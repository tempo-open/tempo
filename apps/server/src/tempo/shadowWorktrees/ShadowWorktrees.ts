// @effect-diagnostics nodeBuiltinImport:off -- statfs, nanosecond lstat and `cp -c` clones, which effect FileSystem and ChildProcess do not cover.
/**
 * tempo: shadow worktrees. Each repository keeps a hidden checkout in `<worktrees folder>/.shadow`;
 * new worktrees are added `--no-checkout`, filled with APFS clones of its files, and given an index
 * Tempo writes. macOS `cp -c` silently copies across volumes, so shadow and worktree must share a
 * device. On failure only `.git` remains, and the caller's `git reset --hard` checks it out.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { GitCommandError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import {
  encodeGitIndex,
  parseStagedEntries,
  writeGitIndexFile,
  type GitIndexEntry,
} from "./gitIndex.ts";

/** The folder in each worktrees folder that holds the shadows. Storage cleanup skips it. */
export const SHADOW_DIRECTORY_NAME = ".shadow";
/** Each shadow records the git directory it belongs to here, so cleanup can drop it with its repository. */
export const SHADOW_REPOSITORY_FILE = "repository";

/** `ls-files --stage` lists about 100 bytes a file. */
const MAX_LISTING_BYTES = 512 * 1024 * 1024;
const LSTAT_CONCURRENCY = 64;

export class ShadowWorktreeError extends Schema.TaggedError<ShadowWorktreeError>()(
  "ShadowWorktreeError",
  { step: Schema.String, detail: Schema.String },
) {
  override get message(): string {
    return `Shadow worktree ${this.step}: ${this.detail}`;
  }
}

export interface ShadowGitResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stdoutTruncated: boolean;
}

/** The git driver's runner: fails on a non-zero exit unless `allowNonZeroExit`. */
export type ShadowGitRunner = (
  operation: string,
  cwd: string,
  args: ReadonlyArray<string>,
  options?: {
    readonly env?: NodeJS.ProcessEnv;
    readonly timeoutMs?: number | null;
    readonly maxOutputBytes?: number;
    readonly allowNonZeroExit?: boolean;
    readonly fallbackErrorDetail?: string;
  },
) => Effect.Effect<ShadowGitResult, GitCommandError>;

export interface ShadowFillInput {
  /** Registered with `git worktree add --no-checkout`, so it holds only its `.git` file. */
  readonly worktreePath: string;
  /** The worktrees folder; its `.shadow` holds the repository's shadow. */
  readonly worktreesRoot: string;
  readonly checkoutWorkers: string;
  readonly timeoutMs: number;
}

const attempt = <A>(step: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ShadowWorktreeError({
        step,
        detail: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const readTextIfPresent = (file: string) =>
  attempt("read", () =>
    NodeFSP.readFile(file, "utf8").catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return null;
      throw cause;
    }),
  );

/** `cp -c` clones each file (clonefile(2)), keeping modes and modification times. */
const cloneInto = (source: string, destinationDirectory: string) =>
  Effect.callback<void, ShadowWorktreeError>((resume) => {
    const child = NodeChildProcess.execFile(
      "/bin/cp",
      ["-c", "-R", source, `${destinationDirectory}/`],
      { maxBuffer: 1024 * 1024 },
      (error, _stdout, stderr) => {
        resume(
          error === null
            ? Effect.void
            : Effect.fail(
                new ShadowWorktreeError({ step: "clone", detail: stderr.trim() || error.message }),
              ),
        );
      },
    );
    return Effect.sync(() => {
      child.kill();
    });
  });

/** APFS clones about four jobs at once; one `cp` per entry one folder deep keeps them busy. */
const CLONE_CONCURRENCY = 4;

const cloneTree = Effect.fnUntraced(function* (source: string, destination: string) {
  const jobs = yield* attempt("clone", async () => {
    const found: Array<string> = [];
    for (const entry of await NodeFSP.readdir(source, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        found.push(entry.name);
        continue;
      }
      await NodeFSP.mkdir(NodePath.join(destination, entry.name), { recursive: true });
      for (const child of await NodeFSP.readdir(NodePath.join(source, entry.name))) {
        found.push(NodePath.join(entry.name, child));
      }
    }
    return found;
  });
  yield* Effect.forEach(
    jobs,
    (job) =>
      cloneInto(NodePath.join(source, job), NodePath.join(destination, NodePath.dirname(job))),
    { concurrency: CLONE_CONCURRENCY, discard: true },
  );
});

/** Clones only stay clones on one APFS volume; `cp -c` would silently copy anywhere else. */
const assertClonable = (shadowsDirectory: string, worktreePath: string) =>
  attempt("volume", async () => {
    const [shadows, worktree, shadowsFs, systemFs] = await Promise.all([
      NodeFSP.stat(shadowsDirectory),
      NodeFSP.stat(worktreePath),
      NodeFSP.statfs(shadowsDirectory),
      NodeFSP.statfs("/"),
    ]);
    if (shadows.dev !== worktree.dev) {
      throw new Error("the worktree is on another volume than its worktrees folder");
    }
    if (shadowsFs.type !== systemFs.type) {
      throw new Error("the worktrees folder is not on an APFS volume");
    }
  });

/** Leaves only `.git`, so `git reset --hard` checks the worktree out as if it were new. */
const emptyWorktree = (worktreePath: string) =>
  attempt("reset", async () => {
    const names = await NodeFSP.readdir(worktreePath);
    await Promise.all(
      names
        .filter((name) => name !== ".git")
        .map((name) =>
          NodeFSP.rm(NodePath.join(worktreePath, name), { recursive: true, force: true }),
        ),
    );
  });

const parseGitVersion = (output: string) => {
  const match = /git version (\d+)\.(\d+)/.exec(output);
  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
};

export const makeShadowWorktrees = (runGit: ShadowGitRunner) => {
  const locks = new Map<string, Semaphore.Semaphore>();
  const lockFor = (shadowDirectory: string) => {
    const existing = locks.get(shadowDirectory);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    locks.set(shadowDirectory, created);
    return created;
  };
  let hookRunSupported: boolean | undefined;

  /** `git hook run` (Git 2.36) runs post-checkout the way `git worktree add` would have. */
  const supported = (cwd: string) =>
    hookRunSupported !== undefined
      ? Effect.succeed(hookRunSupported)
      : runGit("tempo.shadowWorktrees.version", cwd, ["version"]).pipe(
          Effect.map((result) => {
            const version = parseGitVersion(result.stdout);
            return (
              version !== null &&
              (version.major > 2 || (version.major === 2 && version.minor >= 36))
            );
          }),
          Effect.tap((value) =>
            Effect.sync(() => {
              hookRunSupported = value;
            }),
          ),
          Effect.orElseSucceed(() => false),
        );

  const fillOrFail = Effect.fnUntraced(function* (input: ShadowFillInput) {
    const git = (step: string, cwd: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv) =>
      runGit(`tempo.shadowWorktrees.${step}`, cwd, args, {
        timeoutMs: input.timeoutMs,
        maxOutputBytes: MAX_LISTING_BYTES,
        ...(env === undefined ? {} : { env }),
      }).pipe(
        Effect.flatMap((result) =>
          result.stdoutTruncated
            ? Effect.fail(new ShadowWorktreeError({ step, detail: "git output was too long" }))
            : Effect.succeed(result.stdout),
        ),
      );

    const [commonDirectory, indexPath, objectFormat, head] = (yield* git(
      "describe",
      input.worktreePath,
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
        "--git-path",
        "index",
        "--show-object-format",
        "HEAD",
      ],
    ))
      .trim()
      .split("\n");
    if (
      commonDirectory === undefined ||
      indexPath === undefined ||
      head === undefined ||
      (objectFormat !== "sha1" && objectFormat !== "sha256")
    ) {
      return yield* new ShadowWorktreeError({ step: "describe", detail: "unexpected rev-parse" });
    }
    const sparse = yield* runGit(
      "tempo.shadowWorktrees.sparse",
      input.worktreePath,
      ["config", "--type=bool", "--get", "core.sparseCheckout"],
      { allowNonZeroExit: true },
    );
    if (sparse.stdout.trim() === "true") {
      return yield* new ShadowWorktreeError({ step: "describe", detail: "sparse checkout" });
    }

    const repository = yield* attempt("describe", () => NodeFSP.realpath(commonDirectory));
    const shadowsDirectory = NodePath.join(input.worktreesRoot, SHADOW_DIRECTORY_NAME);
    yield* attempt("prepare", () => NodeFSP.mkdir(shadowsDirectory, { recursive: true }));
    yield* assertClonable(shadowsDirectory, input.worktreePath);
    const repositoryKey = NodeCrypto.createHash("sha256").update(repository).digest("hex");
    const shadowDirectory = NodePath.join(
      shadowsDirectory,
      `${NodePath.basename(NodePath.dirname(repository))}-${repositoryKey.slice(0, 12)}`,
    );
    const tree = NodePath.join(shadowDirectory, "tree");
    const commitFile = NodePath.join(shadowDirectory, "commit");
    const shadowEnv = { GIT_INDEX_FILE: NodePath.join(shadowDirectory, "index") };
    const shadowGit = ["--git-dir", repository, "--work-tree", tree];

    const entries = yield* lockFor(shadowDirectory).withPermits(1)(
      Effect.gen(function* () {
        // The shadow moves between commits, so git rewrites only what changed. When a
        // .gitattributes changed, files that did not could keep the old conversions.
        const previous = (yield* readTextIfPresent(commitFile))?.trim() ?? null;
        if (previous !== null && previous !== head) {
          const attributes = yield* runGit(
            "tempo.shadowWorktrees.attributes",
            input.worktreePath,
            ["diff", "--name-only", "-z", previous, head, "--", ":(glob)**/.gitattributes"],
            { allowNonZeroExit: true, timeoutMs: input.timeoutMs },
          );
          if (attributes.exitCode !== 0 || attributes.stdout !== "") {
            yield* attempt("prepare", () =>
              NodeFSP.rm(shadowDirectory, { recursive: true, force: true }),
            );
          }
        }
        yield* attempt("prepare", () => NodeFSP.mkdir(tree, { recursive: true }));
        yield* attempt("prepare", () =>
          NodeFSP.writeFile(
            NodePath.join(shadowDirectory, SHADOW_REPOSITORY_FILE),
            `${repository}\n`,
          ),
        );
        // A shadow git could not update (a damaged index, say) starts over next time.
        yield* git(
          "update",
          tree,
          [
            ...shadowGit,
            "-c",
            `checkout.workers=${input.checkoutWorkers}`,
            "read-tree",
            "--reset",
            "-u",
            "--no-recurse-submodules",
            head,
          ],
          shadowEnv,
        ).pipe(
          Effect.tapError(() =>
            Effect.promise(() =>
              NodeFSP.rm(shadowDirectory, { recursive: true, force: true }).catch(() => undefined),
            ),
          ),
        );
        yield* attempt("update", () => NodeFSP.writeFile(commitFile, `${head}\n`));
        const listing = parseStagedEntries(
          yield* git("list", tree, [...shadowGit, "ls-files", "--stage", "-z"], shadowEnv),
        );
        if (listing === null) {
          return yield* new ShadowWorktreeError({ step: "list", detail: "unexpected ls-files" });
        }
        yield* cloneTree(tree, input.worktreePath);
        return listing;
      }),
    );

    // Tens of thousands of stats: a plain promise pool, not one effect each.
    const statted = yield* attempt("index", async () => {
      const result: Array<{ entry: GitIndexEntry; stats: NodeFS.BigIntStats }> = [];
      let next = 0;
      const worker = async () => {
        for (let index = next++; index < entries.length; index = next++) {
          const entry = entries[index]!;
          const file = NodePath.join(input.worktreePath, entry.path);
          result[index] = { entry, stats: await NodeFSP.lstat(file, { bigint: true }) };
        }
      };
      await Promise.all(Array.from({ length: LSTAT_CONCURRENCY }, worker));
      return result;
    });
    yield* attempt("index", () =>
      writeGitIndexFile(indexPath, encodeGitIndex(statted, objectFormat)),
    );
  });

  /**
   * Fills a worktree registered with `--no-checkout` from its repository's shadow.
   * Never fails: false leaves the worktree with only its `.git` file.
   */
  const fillFromShadow = Effect.fn("ShadowWorktrees.fillFromShadow")(function* (
    input: ShadowFillInput,
  ) {
    return yield* fillOrFail(input).pipe(
      Effect.as(true),
      Effect.catch((cause) =>
        Effect.logWarning("shadow worktree unavailable; checking out the regular way", {
          worktreePath: input.worktreePath,
          cause,
        }).pipe(
          Effect.andThen(emptyWorktree(input.worktreePath)),
          Effect.as(false),
          Effect.orElseSucceed(() => false),
        ),
      ),
    );
  });

  /** What `git worktree add` runs after its checkout, which `--no-checkout` skips. */
  const runPostCheckoutHook = Effect.fn("ShadowWorktrees.runPostCheckoutHook")(function* (
    worktreePath: string,
    timeoutMs: number,
  ) {
    const head = (yield* runGit("tempo.shadowWorktrees.head", worktreePath, [
      "rev-parse",
      "HEAD",
    ])).stdout.trim();
    yield* runGit(
      "tempo.shadowWorktrees.postCheckout",
      worktreePath,
      [
        "hook",
        "run",
        "--ignore-missing",
        "post-checkout",
        "--",
        "0".repeat(head.length),
        head,
        "1",
      ],
      { timeoutMs, fallbackErrorDetail: "post-checkout hook failed" },
    );
  });

  return { supported, fillFromShadow, runPostCheckoutHook };
};
