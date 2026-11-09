#!/usr/bin/env node
/**
 * tempo: pulls a T3 Code stable release (a `vX.Y.Z` tag) into this tree. Tempo shares no history with
 * T3 Code, so `git merge` cannot work: this applies upstream's diff between the last synced tag
 * and the new one three-way under Tempo's folder and records the tag in `t3code-upstream.json`.
 * See docs/operations/tempo-t3-stable-releases.md.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** The T3 Code tag and commit this tree last synced, at Tempo's root. */
export const UPSTREAM_RECORD_FILE = "t3code-upstream.json";

/** Fetched tags stay under refs no push or tag listing touches, so the next fetch is incremental. */
const UPSTREAM_REF_PREFIX = "refs/t3code-upstream/";

/**
 * `.repos/` is fetched by `vpr sync:repos`; what Tempo needs from upstream's `.github/` is ported by
 * hand. Tempo ships no mobile app, marketing site or relay, so upstream's copies stay out.
 */
const EXCLUDED_PATHSPECS = [
  ":(exclude).repos/",
  ":(exclude).github/",
  ":(exclude)apps/mobile/",
  ":(exclude)apps/marketing/",
  ":(exclude)infra/relay/",
];

const UpstreamRecord = Schema.Struct({
  repository: Schema.String,
  tag: Schema.String,
  commit: Schema.String,
});
export type UpstreamRecord = typeof UpstreamRecord.Type;

const UpstreamRecordJson = Schema.fromJsonString(UpstreamRecord, { space: 2 });
const decodeRecord = Schema.decodeEffect(UpstreamRecordJson);
const encodeRecord = Schema.encodeEffect(UpstreamRecordJson);

export interface UpstreamSkippedPath {
  /** The upstream change: A, M, D, R or T, as `git diff --name-status` reports it. */
  readonly status: string;
  /** Relative to the repository's top level. */
  readonly path: string;
  readonly reason: string;
}

export type UpstreamSyncResult =
  | { readonly status: "current"; readonly from: UpstreamRecord }
  | {
      readonly status: "applied";
      readonly from: UpstreamRecord;
      readonly to: UpstreamRecord;
      /** Relative to the repository's top level, like the other paths here. */
      readonly conflicts: ReadonlyArray<string>;
      readonly skipped: ReadonlyArray<UpstreamSkippedPath>;
      /** `git diff --name-status` lines for upstream's `.github/`, which is not applied. */
      readonly githubChanges: ReadonlyArray<string>;
    };

export class UpstreamRecordError extends Schema.TaggedError<UpstreamRecordError>()(
  "UpstreamRecordError",
  {
    operation: Schema.Literals(["read", "parse", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not ${this.operation} the upstream record at ${this.path}.`;
  }
}

export class UpstreamDirtyTreeError extends Schema.TaggedError<UpstreamDirtyTreeError>()(
  "UpstreamDirtyTreeError",
  { topLevel: Schema.String },
) {
  override get message(): string {
    return `${this.topLevel} has uncommitted changes. Commit or stash them before syncing upstream.`;
  }
}

export class UpstreamTagMovedError extends Schema.TaggedError<UpstreamTagMovedError>()(
  "UpstreamTagMovedError",
  {
    tag: Schema.String,
    recordedCommit: Schema.String,
    fetchedCommit: Schema.String,
  },
) {
  override get message(): string {
    return `Upstream's ${this.tag} is now ${this.fetchedCommit}, but this tree synced it at ${this.recordedCommit}.`;
  }
}

export class UpstreamGitError extends Schema.TaggedError<UpstreamGitError>()("UpstreamGitError", {
  operation: Schema.Literals(["spawn", "communicate", "exit"]),
  step: Schema.Literals(["locate", "status", "fetch", "resolve", "diff", "apply", "stage"]),
  argumentCount: Schema.Number,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git ${this.step} failed during "${this.operation}"${this.exitCode === undefined ? "" : ` with exit code ${this.exitCode}`}.`;
  }
}

type GitStep = UpstreamGitError["step"];

const collectBytes = <E>(stream: Stream.Stream<Uint8Array, E>) =>
  Stream.runFold(
    stream,
    () => [] as Array<Uint8Array>,
    (chunks, chunk) => {
      chunks.push(chunk);
      return chunks;
    },
  ).pipe(Effect.map((chunks) => Buffer.concat(chunks)));

/** Runs git and returns its exit code with its output; only a process failure fails. */
const runGit = Effect.fn("runGit")(function* (
  step: GitStep,
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly stdin?: Uint8Array; readonly showProgress?: boolean } = {},
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const errorContext = { step, argumentCount: args.length } as const;
  const child = yield* spawner
    .spawn(
      ChildProcess.make("git", args, {
        cwd,
        // git apply's per-file errors are read below, so keep them in English.
        env: { LC_ALL: "C" },
        extendEnv: true,
        ...(options.stdin ? { stdin: Stream.make(options.stdin) } : {}),
        // A first fetch can download T3 Code's whole history; let git show its progress.
        ...(options.showProgress ? { stderr: "inherit" as const } : {}),
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) => new UpstreamGitError({ ...errorContext, operation: "spawn", cause }),
      ),
    );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectBytes(child.stdout),
      collectBytes(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) => new UpstreamGitError({ ...errorContext, operation: "communicate", cause }),
    ),
  );
  return { exitCode, stdout, stderr: stderr.toString("utf8") };
}, Effect.scoped);

/** Runs git and returns its stdout, failing on a non-zero exit after showing git's own reason. */
const git = Effect.fn("git")(function* (
  step: GitStep,
  cwd: string,
  args: ReadonlyArray<string>,
  options: { readonly showProgress?: boolean } = {},
) {
  const result = yield* runGit(step, cwd, args, options);
  if (result.exitCode !== 0) {
    if (result.stderr.trim().length > 0) yield* Console.error(result.stderr.trim());
    return yield* new UpstreamGitError({
      step,
      operation: "exit",
      argumentCount: args.length,
      exitCode: result.exitCode,
    });
  }
  return result.stdout;
});

const lines = (output: Uint8Array) =>
  Buffer.from(output)
    .toString("utf8")
    .split("\n")
    .filter((line) => line.length > 0);

/**
 * The paths a whole-patch `git apply` refused, with its reason. A modified or
 * deleted file Tempo no longer has, or a deleted one Tempo changed, makes git apply
 * nothing at all, where a merge would report one conflict.
 */
export function parseApplyFailures(
  stderr: string,
): ReadonlyArray<{ readonly path: string; readonly reason: string }> {
  const failures = new Map<string, string>();
  for (const line of stderr.split("\n")) {
    const match = /^error: (?!patch failed: )(.+): ([^:]+)$/.exec(line);
    if (match && !failures.has(match[1]!)) failures.set(match[1]!, match[2]!);
  }
  return [...failures].map(([path, reason]) => ({ path, reason }));
}

/** `{ path: status }` for each path the diff touches, renames under both names. */
function changeStatuses(nameStatus: ReadonlyArray<string>): ReadonlyMap<string, string> {
  const statuses = new Map<string, string>();
  for (const line of nameStatus) {
    const [status = "", ...paths] = line.split("\t");
    for (const path of paths) statuses.set(path, status.charAt(0));
  }
  return statuses;
}

export const syncUpstream = Effect.fn("syncUpstream")(function* (options: {
  /** Tempo's root: the folder holding `t3code-upstream.json`. */
  readonly root: string;
  /** The T3 Code tag to sync to. */
  readonly to: string;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const recordPath = path.join(options.root, UPSTREAM_RECORD_FILE);
  const recordText = yield* fs
    .readFileString(recordPath)
    .pipe(
      Effect.mapError(
        (cause) => new UpstreamRecordError({ operation: "read", path: recordPath, cause }),
      ),
    );
  const from = yield* decodeRecord(recordText).pipe(
    Effect.mapError(
      (cause) => new UpstreamRecordError({ operation: "parse", path: recordPath, cause }),
    ),
  );
  if (from.tag === options.to) {
    return { status: "current", from } satisfies UpstreamSyncResult;
  }

  // Tempo's root relative to the top level: "" at the repository root, the folder's path when Tempo is a folder of a bigger repository.
  const [topLevel = "", prefix = ""] = Buffer.from(
    yield* git("locate", options.root, ["rev-parse", "--show-toplevel", "--show-prefix"]),
  )
    .toString("utf8")
    .split("\n");
  const hasChanges = git("status", topLevel, [
    "status",
    "--porcelain",
    "--untracked-files=no",
  ]).pipe(Effect.map((stdout) => lines(stdout).length > 0));
  if (yield* hasChanges) {
    return yield* new UpstreamDirtyTreeError({ topLevel });
  }

  const fromRef = `${UPSTREAM_REF_PREFIX}${from.tag}`;
  const toRef = `${UPSTREAM_REF_PREFIX}${options.to}`;
  yield* Console.log(`Fetching ${from.tag} and ${options.to} from ${from.repository}.`);
  yield* git(
    "fetch",
    topLevel,
    [
      "fetch",
      "--no-tags",
      from.repository,
      `+refs/tags/${from.tag}:${fromRef}`,
      `+refs/tags/${options.to}:${toRef}`,
    ],
    { showProgress: true },
  );
  const resolve = (ref: string) =>
    git("resolve", topLevel, ["rev-parse", "--verify", `${ref}^{commit}`]).pipe(
      Effect.map((stdout) => Buffer.from(stdout).toString("utf8").trim()),
    );
  const fetchedFrom = yield* resolve(fromRef);
  if (fetchedFrom !== from.commit) {
    return yield* new UpstreamTagMovedError({
      tag: from.tag,
      recordedCommit: from.commit,
      fetchedCommit: fetchedFrom,
    });
  }
  const to: UpstreamRecord = { ...from, tag: options.to, commit: yield* resolve(toRef) };

  const githubChanges = lines(
    yield* git("diff", topLevel, [
      "diff",
      "--name-status",
      from.commit,
      to.commit,
      "--",
      ".github/",
    ]),
  );
  const statuses = changeStatuses(
    lines(
      yield* git("diff", topLevel, [
        "diff",
        "--name-status",
        from.commit,
        to.commit,
        "--",
        ...EXCLUDED_PATHSPECS,
      ]),
    ),
  );

  // Apply the whole diff at once. When git refuses some paths it applies
  // nothing, so leave those out and try again with the rest.
  const directory = prefix.replace(/\/$/, "");
  const applyArgs = ["apply", "--3way", ...(directory ? [`--directory=${directory}`] : [])];
  const skipped: Array<UpstreamSkippedPath> = [];
  for (;;) {
    const patch = yield* git("diff", topLevel, [
      "diff",
      "--binary",
      from.commit,
      to.commit,
      "--",
      ...EXCLUDED_PATHSPECS,
      ...skipped.map((entry) => `:(exclude,literal)${entry.path.slice(prefix.length)}`),
    ]);
    if (patch.length === 0) break;
    const applied = yield* runGit("apply", topLevel, applyArgs, { stdin: patch });
    if (applied.exitCode === 0) break;
    // Conflicts still apply everything else and leave the index changed.
    if (yield* hasChanges) break;
    const failures = parseApplyFailures(applied.stderr).filter(
      (failure) => !skipped.some((entry) => entry.path === failure.path),
    );
    if (failures.length === 0) {
      yield* Console.error(applied.stderr.trim());
      return yield* new UpstreamGitError({
        step: "apply",
        operation: "exit",
        argumentCount: applyArgs.length,
        exitCode: applied.exitCode,
      });
    }
    for (const failure of failures) {
      skipped.push({
        status: statuses.get(failure.path.slice(prefix.length)) ?? "?",
        ...failure,
      });
    }
  }

  const conflicts = lines(yield* git("diff", topLevel, ["diff", "--name-only", "--diff-filter=U"]));
  yield* encodeRecord(to).pipe(
    Effect.flatMap((json) => fs.writeFileString(recordPath, `${json}\n`)),
    Effect.mapError(
      (cause) => new UpstreamRecordError({ operation: "write", path: recordPath, cause }),
    ),
  );
  yield* git("stage", options.root, ["add", "--", UPSTREAM_RECORD_FILE]);

  return {
    status: "applied",
    from,
    to,
    conflicts,
    // Upstream deleting a file Tempo already deleted needs no one's attention.
    skipped: skipped.filter(
      (entry) => !(entry.status === "D" && entry.reason === "does not exist in index"),
    ),
    githubChanges,
  } satisfies UpstreamSyncResult;
});

const short = (commit: string) => commit.slice(0, 12);

const report = Effect.fn("report")(function* (result: UpstreamSyncResult) {
  if (result.status === "current") {
    yield* Console.log(`Already synced to ${result.from.tag}.`);
    return;
  }
  const { from, to, conflicts, skipped, githubChanges } = result;
  // Upstream paths are at the top of T3 Code's tree, wherever Tempo sits.
  const showUpstream = (pathspec: string) =>
    `git diff ${short(from.commit)} ${short(to.commit)} -- ':(top)${pathspec}'`;
  const out: Array<string> = [
    `Applied T3 Code ${to.tag} (${short(to.commit)}) over ${from.tag} (${short(from.commit)}). The record is updated and staged.`,
  ];
  if (conflicts.length > 0) {
    out.push("", `Conflicts (${conflicts.length}):`, ...conflicts.map((path) => `  ${path}`));
  } else {
    out.push("", "No conflicts.");
  }
  if (skipped.length > 0) {
    out.push(
      "",
      "Not applied, because git refused them (a merge would call these conflicts):",
      ...skipped.map((entry) => `  ${entry.status} ${entry.path}: ${entry.reason}`),
      `  See one with: ${showUpstream("<path without Tempo's folder>")}`,
    );
  }
  if (githubChanges.length > 0) {
    out.push(
      "",
      "Upstream changes under .github/, not applied:",
      ...githubChanges.map((line) => `  ${line.replaceAll("\t", " ")}`),
      `  See them with: ${showUpstream(".github/")}`,
    );
  }
  out.push(
    "",
    "Next:",
    ...[
      conflicts.length > 0
        ? "Resolve each conflict so Tempo's changes survive alongside upstream's, then git add it."
        : undefined,
      skipped.length > 0
        ? "Port each refused change by hand, or leave it out if Tempo does not need it."
        : undefined,
      githubChanges.length > 0
        ? "Port what Tempo needs from the .github/ changes to .github/workflows by hand."
        : undefined,
      "Run vp i and vpr sync:repos, then typecheck and test what changed.",
      "Commit, open a pull request, and merge it once CI is green.",
    ]
      .filter((step) => step !== undefined)
      .map((step, index) => `  ${index + 1}. ${step}`),
  );
  yield* Console.log(out.join("\n"));
});

const upstreamSyncCommand = Command.make(
  "upstream-sync",
  {
    to: Flag.String("to").pipe(Flag.withDescription("The T3 Code tag to sync to.")),
    root: Flag.String("root").pipe(
      Flag.withDescription(
        `Tempo's root, the folder holding ${UPSTREAM_RECORD_FILE}. Defaults to this script's checkout.`,
      ),
      Flag.optional,
    ),
  },
  Effect.fn("upstreamSync.main")(function* ({ to, root }) {
    const path = yield* Path.Path;
    const tempoRoot = Option.isSome(root)
      ? path.resolve(root.value)
      : yield* path.fromFileUrl(new URL("..", import.meta.url));
    yield* report(yield* syncUpstream({ root: tempoRoot, to }));
  }),
).pipe(
  Command.withDescription("Apply a T3 Code stable release (vX.Y.Z) to this tree without a merge."),
);

if (import.meta.main) {
  Command.run(upstreamSyncCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
