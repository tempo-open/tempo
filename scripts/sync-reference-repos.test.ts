// @effect-diagnostics nodeBuiltinImport:off - builds a real upstream git repository on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
import * as NodeChildProcess from "node:child_process";

import { referenceRepos } from "./lib/reference-repos.ts";
import {
  materializeReferenceRepo,
  planReferenceRepoSync,
  REFERENCE_REPO_STAMP_FILE,
  resolveReferenceRepoRef,
  syncReferenceRepos,
} from "./sync-reference-repos.ts";

const encoder = new TextEncoder();
const effectSmol = referenceRepos[0]!;

function mockHandle(
  options: {
    readonly exitCode?: number;
    readonly stdout?: string;
    readonly stderr?: string;
  } = {},
) {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.exitCode ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.make(encoder.encode(options.stdout ?? "done\n")),
    stderr: Stream.make(encoder.encode(options.stderr ?? "")),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

function mockSpawnerLayer(
  commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>,
  handle = mockHandle(),
) {
  return Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const childProcess = command as unknown as {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
      };
      commands.push({
        command: childProcess.command,
        args: childProcess.args,
      });
      return Effect.succeed(handle);
    }),
  );
}

/** Runs git for fixtures, never signing and with a fixed identity. */
function git(cwd: string, ...args: ReadonlyArray<string>) {
  NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=t3",
      "-c",
      "user.email=t3@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    { cwd, stdio: "pipe" },
  );
}

it.layer(NodeServices.layer)("sync-reference-repos", (it) => {
  it.effect("resolves the effect-smol tag from the root catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-version-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      assert.equal(
        yield* resolveReferenceRepoRef(effectSmol, rootDir, false),
        "effect@4.0.0-beta.73",
      );
    }),
  );

  it.effect("plans a fetch unless the stamp names the pinned version", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-plan-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );
      const stamp = path.join(rootDir, effectSmol.prefix, REFERENCE_REPO_STAMP_FILE);
      const action = (latest = false) =>
        planReferenceRepoSync(effectSmol, rootDir, latest).pipe(Effect.map((plan) => plan.action));

      assert.equal(yield* action(), "fetch");

      yield* fs.makeDirectory(path.dirname(stamp), { recursive: true });
      yield* fs.writeFileString(stamp, "effect@4.0.0-beta.72\n");
      assert.equal(yield* action(), "fetch");

      yield* fs.writeFileString(stamp, "effect@4.0.0-beta.73\n");
      assert.equal(yield* action(), "current");

      // A branch moves, so it is fetched even when the stamp names it.
      yield* fs.writeFileString(stamp, "main\n");
      assert.equal(yield* action(true), "fetch");
    }),
  );

  it.effect("downloads a version into the cache once and clones it into each checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "sync-reference-repos-git-" });
      const upstream = path.join(tempDir, "upstream");
      const cacheDir = path.join(tempDir, "cache");
      const first = path.join(tempDir, "first");
      const second = path.join(tempDir, "second");
      const repo = { ...effectSmol, repository: (yield* path.toFileUrl(upstream)).href };
      const plan = (ref: string) => ({ repo, action: "fetch", ref, latest: false }) as const;
      const copy = (rootDir: string, file: string) => path.join(rootDir, repo.prefix, file);

      yield* fs.makeDirectory(upstream);
      git(upstream, "init", "--quiet");
      yield* fs.writeFileString(path.join(upstream, "LLMS.md"), "one\n");
      git(upstream, "add", ".");
      git(upstream, "commit", "--quiet", "-m", "one");
      git(upstream, "tag", "-a", "-m", "one", "effect@1.0.0");
      yield* fs.remove(path.join(upstream, "LLMS.md"));
      yield* fs.writeFileString(path.join(upstream, "README.md"), "two\n");
      git(upstream, "add", "--all");
      git(upstream, "commit", "--quiet", "-m", "two");
      git(upstream, "tag", "effect@2.0.0");

      yield* materializeReferenceRepo(plan("effect@1.0.0"), first, cacheDir);
      assert.equal(yield* fs.readFileString(copy(first, "LLMS.md")), "one\n");
      assert.equal(
        yield* fs.readFileString(copy(first, REFERENCE_REPO_STAMP_FILE)),
        "effect@1.0.0\n",
      );
      assert.isFalse(yield* fs.exists(copy(first, ".git")));

      // A newer version replaces the whole copy, files it dropped included.
      yield* materializeReferenceRepo(plan("effect@2.0.0"), first, cacheDir);
      assert.equal(yield* fs.readFileString(copy(first, "README.md")), "two\n");
      assert.isFalse(yield* fs.exists(copy(first, "LLMS.md")));
      assert.isFalse(yield* fs.exists(`${path.join(first, repo.prefix)}.partial`));

      // Cached versions need no upstream: another checkout clones them locally.
      yield* fs.remove(upstream, { recursive: true });
      yield* materializeReferenceRepo(plan("effect@1.0.0"), second, cacheDir);
      assert.equal(yield* fs.readFileString(copy(second, "LLMS.md")), "one\n");
    }),
  );

  it.effect("fetches nothing on a dry run", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-dry-run-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const plans = yield* syncReferenceRepos({
        rootDir,
        cacheDir: path.join(rootDir, "cache"),
        repoId: "effect-smol",
        dryRun: true,
      }).pipe(Effect.provide(mockSpawnerLayer(commands)));

      assert.deepStrictEqual(
        plans.map((plan) => [plan.repo.id, plan.action, plan.ref]),
        [["effect-smol", "fetch", "effect@4.0.0-beta.73"]],
      );
      assert.deepStrictEqual(commands, []);
      assert.isFalse(yield* fs.exists(path.join(rootDir, "cache")));
    });
  });

  it.effect("reports non-zero git exits without retaining process output", () => {
    const commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }> = [];

    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const rootDir = yield* fs.makeTempDirectoryScoped({
        prefix: "sync-reference-repos-exit-error-",
      });
      yield* fs.writeFileString(
        path.join(rootDir, "pnpm-workspace.yaml"),
        "catalog:\n  effect: 4.0.0-beta.73\n",
      );

      const error = yield* syncReferenceRepos({
        rootDir,
        cacheDir: path.join(rootDir, "cache"),
        repoId: "effect-smol",
      }).pipe(
        Effect.provide(
          mockSpawnerLayer(
            commands,
            mockHandle({ exitCode: 23, stderr: "init failed secret-token-value\n" }),
          ),
        ),
        Effect.flip,
      );

      if (error._tag !== "ReferenceRepoGitError") {
        assert.fail(`Unexpected error: ${error._tag}`);
      }
      assert.equal(error.operation, "exit");
      assert.equal(error.step, "init");
      assert.equal(error.repoId, effectSmol.id);
      assert.equal(error.repository, effectSmol.repository);
      assert.equal(error.ref, "effect@4.0.0-beta.73");
      assert.equal(error.argumentCount, commands[0]?.args.length);
      assert.equal(error.exitCode, 23);
      assert.equal(error.stdoutLength, 5);
      assert.equal(error.stderrLength, 31);
      assert.notProperty(error, "args");
      assert.notProperty(error, "stderr");
      assert.notInclude(error.message, "secret-token-value");
      assert.ok(!("cause" in error));
    });
  });
});
