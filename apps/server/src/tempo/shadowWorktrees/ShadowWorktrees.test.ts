// @effect-diagnostics nodeBuiltinImport:off -- checks modes, symlinks and folders the way git leaves them.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { makeGitVcsDriverCore } from "../../vcs/GitVcsDriverCore.ts";
import { SHADOW_DIRECTORY_NAME, makeShadowWorktrees } from "./ShadowWorktrees.ts";

const layerTest = GitVcsDriver.layer.pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "tempo-shadow-worktrees-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const run = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const driver = yield* GitVcsDriver.GitVcsDriver;
    return yield* driver.execute({
      operation: "ShadowWorktrees.test",
      cwd,
      args,
      allowNonZeroExit: true,
      timeoutMs: 60_000,
    });
  });

const git = (cwd: string, args: ReadonlyArray<string>) =>
  run(cwd, args).pipe(
    Effect.flatMap((result) =>
      result.exitCode === 0
        ? Effect.succeed(result.stdout.trim())
        : Effect.die(new Error(`git ${args.join(" ")}: ${result.stderr}`)),
    ),
  );

/** A repository with an executable, a symlink, nested and non-ASCII paths, and its worktrees folder. */
const makeRepository = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-shadow-worktrees-" });
  const repo = NodePath.join(root, "repo");
  NodeFS.mkdirSync(repo);
  yield* git(repo, ["init", "--quiet", "--initial-branch=main"]);
  yield* git(repo, ["config", "user.name", "Tempo Test"]);
  yield* git(repo, ["config", "user.email", "tempo-test@example.com"]);
  yield* git(repo, ["config", "commit.gpgsign", "false"]);
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# shadow\n");
  NodeFS.mkdirSync(NodePath.join(repo, "bin"));
  NodeFS.writeFileSync(NodePath.join(repo, "bin", "run.sh"), "#!/bin/sh\necho run\n", {
    mode: 0o755,
  });
  NodeFS.mkdirSync(NodePath.join(repo, "nested", "deeper"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, "nested", "deeper", "file.txt"), "deep\n");
  NodeFS.writeFileSync(NodePath.join(repo, "ünïcode.txt"), "unicode\n");
  NodeFS.symlinkSync("README.md", NodePath.join(repo, "link"));
  yield* git(repo, ["add", "."]);
  // Recorded even where core.fileMode is off, as on some CI hosts.
  yield* git(repo, ["update-index", "--chmod=+x", "bin/run.sh"]);
  yield* git(repo, ["commit", "--quiet", "-m", "initial"]);
  return { root, repo, worktrees: NodePath.join(root, "worktrees") };
});

/**
 * Each file under `directory` but `.git` as git tracks it: its path, whether it
 * is a link, executable or plain file, and its target or contents. Exact modes
 * follow the umask, which differs between git's checkout and the test's writes.
 */
const snapshot = (directory: string) => {
  const files: Array<string> = [];
  const visit = (relative: string) => {
    for (const name of NodeFS.readdirSync(NodePath.join(directory, relative)).toSorted()) {
      if (relative === "" && name === ".git") continue;
      const path = NodePath.join(relative, name);
      const absolute = NodePath.join(directory, path);
      const stats = NodeFS.lstatSync(absolute);
      if (stats.isDirectory()) visit(path);
      else if (stats.isSymbolicLink()) files.push(`${path} link ${NodeFS.readlinkSync(absolute)}`);
      else
        files.push(
          `${path} ${stats.mode & 0o111 ? "executable" : "file"} ${NodeFS.readFileSync(absolute, "utf8")}`,
        );
    }
  };
  visit("");
  return files;
};

const shadowsOf = (worktrees: string) => {
  const directory = NodePath.join(worktrees, SHADOW_DIRECTORY_NAME);
  return NodeFS.existsSync(directory)
    ? NodeFS.readdirSync(directory).map((name) => NodePath.join(directory, name))
    : [];
};

const macHost = HostProcess.Platform.defaultValue() === "darwin";

describe.runIf(macHost)("shadow worktrees on macOS", () => {
  it.effect("fills a worktree that git finds clean without reading its files", () =>
    Effect.gen(function* () {
      const { repo, worktrees } = yield* makeRepository;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const worktreePath = NodePath.join(worktrees, "repo", "feature");
      yield* git(repo, [
        "worktree",
        "add",
        "--quiet",
        "--no-checkout",
        "-b",
        "feature",
        worktreePath,
      ]);

      const shadowWorktrees = makeShadowWorktrees((operation, cwd, args, options = {}) =>
        driver.execute({
          operation,
          cwd,
          args,
          allowNonZeroExit: options.allowNonZeroExit ?? false,
          ...(options.env === undefined ? {} : { env: options.env }),
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(options.maxOutputBytes === undefined
            ? {}
            : { maxOutputBytes: options.maxOutputBytes }),
        }),
      );
      const filled = yield* shadowWorktrees.fillFromShadow({
        worktreePath,
        worktreesRoot: worktrees,
        checkoutWorkers: "0",
        timeoutMs: 60_000,
      });

      assert.isTrue(filled);
      // diff-files compares stat data only, so a clean result means the reset
      // createWorktree runs next rewrites nothing.
      assert.strictEqual((yield* run(worktreePath, ["diff-files", "--quiet"])).exitCode, 0);
      assert.strictEqual(yield* git(worktreePath, ["status", "--porcelain"]), "");
      assert.deepStrictEqual(snapshot(worktreePath), snapshot(repo));
      const [shadow] = shadowsOf(worktrees);
      assert.deepStrictEqual(snapshot(NodePath.join(shadow!, "tree")), snapshot(repo));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("creates worktrees the way git worktree add does, post-checkout included", () =>
    Effect.gen(function* () {
      const { root, repo, worktrees } = yield* makeRepository;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const hookLog = NodePath.join(root, "post-checkout.log");
      NodeFS.writeFileSync(
        NodePath.join(repo, ".git", "hooks", "post-checkout"),
        `#!/bin/sh\necho "$@" >> '${hookLog}'\n`,
        { mode: 0o755 },
      );
      const head = yield* git(repo, ["rev-parse", "HEAD"]);

      const shadowed = yield* driver.createWorktree(
        { cwd: repo, refName: "main", newRefName: "shadowed", path: null },
        { worktreesDirectory: worktrees, tempoShadowWorktrees: true },
      );
      const regular = yield* driver.createWorktree(
        { cwd: repo, refName: "main", newRefName: "regular", path: null },
        { worktreesDirectory: worktrees, tempoShadowWorktrees: false },
      );

      assert.strictEqual(yield* git(shadowed.worktree.path, ["status", "--porcelain"]), "");
      assert.strictEqual(
        yield* git(shadowed.worktree.path, ["branch", "--show-current"]),
        "shadowed",
      );
      assert.deepStrictEqual(snapshot(shadowed.worktree.path), snapshot(regular.worktree.path));
      assert.deepStrictEqual(NodeFS.readFileSync(hookLog, "utf8").trim().split("\n"), [
        `${"0".repeat(head.length)} ${head} 1`,
        `${"0".repeat(head.length)} ${head} 1`,
      ]);

      // A later commit moves the shadow; the next worktree gets the change.
      NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# shadow, again\n");
      NodeFS.rmSync(NodePath.join(repo, "nested"), { recursive: true });
      yield* git(repo, ["commit", "--quiet", "-am", "second"]);
      const later = yield* driver.createWorktree(
        { cwd: repo, refName: "main", newRefName: "later", path: null },
        { worktreesDirectory: worktrees, tempoShadowWorktrees: true },
      );
      assert.strictEqual(yield* git(later.worktree.path, ["status", "--porcelain"]), "");
      assert.deepStrictEqual(snapshot(later.worktree.path), snapshot(repo));
      assert.strictEqual(shadowsOf(worktrees).length, 1);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("checks out the regular way when the shadow breaks, then rebuilds it", () =>
    Effect.gen(function* () {
      const { repo, worktrees } = yield* makeRepository;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const create = (branch: string) =>
        driver.createWorktree(
          { cwd: repo, refName: "main", newRefName: branch, path: null },
          { worktreesDirectory: worktrees, tempoShadowWorktrees: true },
        );

      yield* create("first");
      const [shadow] = shadowsOf(worktrees);
      NodeFS.writeFileSync(NodePath.join(shadow!, "index"), "not an index");

      const second = yield* create("second");
      assert.strictEqual(yield* git(second.worktree.path, ["status", "--porcelain"]), "");
      assert.deepStrictEqual(snapshot(second.worktree.path), snapshot(repo));
      assert.isFalse(NodeFS.existsSync(shadow!));

      yield* create("third");
      assert.deepStrictEqual(snapshot(NodePath.join(shadow!, "tree")), snapshot(repo));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});

describe("regular worktrees", () => {
  it.effect("are made when shadow worktrees are off or the host cannot clone", () =>
    Effect.gen(function* () {
      const { repo, worktrees } = yield* makeRepository;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const off = yield* driver.createWorktree(
        { cwd: repo, refName: "main", newRefName: "off", path: null },
        { worktreesDirectory: worktrees, tempoShadowWorktrees: false },
      );
      const linuxDriver = yield* makeGitVcsDriverCore().pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
      );
      const linux = yield* linuxDriver.createWorktree(
        { cwd: repo, refName: "main", newRefName: "linux", path: null },
        { worktreesDirectory: worktrees, tempoShadowWorktrees: true },
      );

      assert.deepStrictEqual(shadowsOf(worktrees), []);
      for (const worktree of [off, linux]) {
        assert.strictEqual(yield* git(worktree.worktree.path, ["status", "--porcelain"]), "");
        assert.deepStrictEqual(snapshot(worktree.worktree.path), snapshot(repo));
      }
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
