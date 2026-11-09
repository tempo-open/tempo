/**
 * tempo: Claude in a worktree thread runs skills, settings, hooks and `.mcp.json` from the project's
 * main checkout (`resolveTempoClaudeProjectConfigRoot`), so a lagging checkout runs old ones. Before a
 * worktree thread's turn, Tempo fast-forwards it when nothing there can be disturbed.
 *
 * @module mainCheckoutSync
 */
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import { isWithinRoot } from "../workspace/KnownWorkspaces.ts";
import { resolveTempoClaudeProjectConfigRoot } from "./claudeWorkflows.ts";

export const MAIN_CHECKOUT_SYNC_INTERVAL_MS = 60_000;
const READ_TIMEOUT_MS = 5_000;
const FETCH_TIMEOUT_MS = 10_000;
// Bounds only a stuck merge or post-merge hook: a merge cut short leaves a half-updated checkout.
const MERGE_TIMEOUT_MS = 120_000;
const DEFAULT_BRANCH_FALLBACKS = new Set(["main", "master"]);
const OPERATION_MARKERS = [
  "MERGE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "BISECT_LOG",
];

type MainCheckoutSyncOutcome =
  | "fast-forwarded"
  | "current"
  | "not-default-branch"
  | "no-upstream"
  | "tracked-changes"
  | "operation-in-progress"
  | "diverged"
  | "in-use"
  | "git-refused";

const logFailure = <E>(cause: Cause.Cause<E>) =>
  Cause.hasInterruptsOnly(cause)
    ? Effect.interrupt
    : Effect.logWarning("main checkout sync failed", { cause: Cause.pretty(cause) });

/**
 * Fast-forwards `root` only when it is on its default branch with no tracked changes and no merge,
 * rebase, cherry-pick, revert or bisect under way, is strictly behind its upstream, and `inUse`
 * says no running thread works in it. `exclusive` wraps the checks and the merge so a thread cannot
 * start there between them; the fetch stays outside it.
 */
export const fastForwardMainCheckout = Effect.fn("fastForwardMainCheckout")(function* (input: {
  readonly root: string;
  readonly inUse: Effect.Effect<boolean>;
  readonly exclusive?: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = (args: ReadonlyArray<string>, timeoutMs: number) =>
    vcsProcess.run({
      operation: "mainCheckoutSync",
      command: "git",
      cwd: input.root,
      args,
      env: { GIT_TERMINAL_PROMPT: "0" },
      allowNonZeroExit: true,
      timeoutMs,
    });
  const read = (args: ReadonlyArray<string>) =>
    git(args, READ_TIMEOUT_MS).pipe(
      Effect.map((result) => (result.exitCode === 0 ? result.stdout.trim() : null)),
    );

  const branch = yield* read(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  if (branch === null) return "not-default-branch" as const;
  const remote = yield* read(["config", `branch.${branch}.remote`]);
  const mergeRef = yield* read(["config", `branch.${branch}.merge`]);
  if (remote === null || remote === "." || mergeRef === null) return "no-upstream" as const;
  const upstreamBranch = mergeRef.replace(/^refs\/heads\//, "");
  const remoteHead = yield* read(["symbolic-ref", "--quiet", `refs/remotes/${remote}/HEAD`]);
  const defaultBranch = remoteHead?.replace(`refs/remotes/${remote}/`, "");
  const isDefault =
    defaultBranch === undefined
      ? DEFAULT_BRANCH_FALLBACKS.has(branch)
      : branch === defaultBranch && upstreamBranch === defaultBranch;
  if (!isDefault) return "not-default-branch" as const;

  // A failed or slow fetch leaves the remote ref as it was, which can still be ahead.
  const fetched = yield* git(
    ["fetch", "--quiet", "--no-tags", remote, upstreamBranch],
    FETCH_TIMEOUT_MS,
  ).pipe(
    Effect.map((result) => result.exitCode === 0),
    Effect.orElseSucceed(() => false),
  );
  if (!fetched) yield* Effect.logWarning("main checkout fetch failed", { root: input.root });

  const checkAndMerge = Effect.gen(function* () {
    const counts = yield* read(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]);
    if (counts === null) return "no-upstream" as const;
    const tracked = yield* read(["status", "--porcelain", "--untracked-files=no"]);
    if (tracked === null || tracked.length > 0) return "tracked-changes" as const;
    const gitDir = yield* read(["rev-parse", "--absolute-git-dir"]);
    if (gitDir === null) return "operation-in-progress" as const;
    for (const marker of OPERATION_MARKERS) {
      if (
        yield* fileSystem.exists(path.join(gitDir, marker)).pipe(Effect.orElseSucceed(() => true))
      )
        return "operation-in-progress" as const;
    }
    const [ahead = 0, behind = 0] = counts.split(/\s+/).map(Number);
    if (ahead > 0) return "diverged" as const;
    if (behind === 0) return "current" as const;
    if (yield* input.inUse) return "in-use" as const;
    // git refuses, leaving the checkout as it was, when the merge would overwrite
    // a file, ignored ones included.
    const merged = yield* git(
      ["merge", "--ff-only", "--no-overwrite-ignore", "--quiet", "@{upstream}"],
      MERGE_TIMEOUT_MS,
    ).pipe(Effect.uninterruptible);
    return merged.exitCode === 0 ? ("fast-forwarded" as const) : ("git-refused" as const);
  });
  const outcome: MainCheckoutSyncOutcome = yield* input.exclusive === undefined
    ? checkAndMerge
    : input.exclusive(checkAndMerge);
  return outcome;
});

export class MainCheckoutSync extends Context.Service<
  MainCheckoutSync,
  {
    /**
     * Before a turn in `cwd`: in a linked worktree, keep its main checkout
     * current (at most once a minute per checkout); in a checkout, wait for a
     * fast-forward of it to finish. Never fails.
     */
    readonly beforeTurn: (cwd: string) => Effect.Effect<void>;
  }
>()("t3/tempo/mainCheckoutSync") {}

export const layer = Layer.effect(
  MainCheckoutSync,
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const sql = yield* SqlClient.SqlClient;
    const scope = yield* Scope.Scope;
    const locks = yield* KeyedLock.make<string>();
    const lastAttempt = yield* Ref.make(new Map<string, number>());
    const realPath = (target: string) =>
      fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

    const runningThreads = sql<{
      readonly worktreePath: string | null;
      readonly workspaceRoot: string;
    }>`
      SELECT json_extract(t.payload_json, '$.worktreePath') AS worktreePath,
        p.workspace_root AS workspaceRoot
      FROM orchestration_v2_projection_threads AS t
      JOIN projection_projects AS p ON p.project_id = t.project_id
      WHERE t.deleted_at IS NULL
        AND EXISTS (
          SELECT 1 FROM orchestration_v2_projection_runs AS r
          WHERE r.thread_id = t.thread_id
            AND r.status IN ('preparing', 'starting', 'running', 'waiting')
        )
    `;
    // A project may be rooted in a folder of the checkout. A worktree nested in
    // it (`.claude/worktrees`) is a checkout of its own.
    const inUse = (root: string) =>
      runningThreads.pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) =>
            row.worktreePath === null
              ? realPath(row.workspaceRoot).pipe(Effect.map((cwd) => isWithinRoot(path, cwd, root)))
              : realPath(row.worktreePath).pipe(
                  Effect.map((cwd) => path.relative(root, cwd) === ""),
                ),
          ),
        ),
        Effect.map((matches) => matches.includes(true)),
        // Unknown counts as in use.
        Effect.orElseSucceed(() => true),
      );

    const sync = (root: string) =>
      fastForwardMainCheckout({
        root,
        inUse: inUse(root),
        exclusive: (effect) => locks.withLock(root, effect),
      }).pipe(
        Effect.tap((outcome) => Effect.logInfo("main checkout sync", { root, outcome })),
        Effect.catchCause(logFailure),
      );

    const beforeTurn = Effect.fn("MainCheckoutSync.beforeTurn")(
      function* (cwd: string) {
        const mainRoot = yield* resolveTempoClaudeProjectConfigRoot(cwd);
        if (mainRoot === undefined) {
          const resolved = yield* realPath(cwd);
          const syncing = yield* locks.activeKeys;
          yield* Effect.forEach(
            syncing.filter((root) => isWithinRoot(path, resolved, root)),
            (root) => locks.withLock(root, Effect.void),
            { discard: true },
          );
          return;
        }
        const root = yield* realPath(mainRoot);
        const now = yield* Clock.currentTimeMillis;
        const due = yield* Ref.modify(lastAttempt, (current) => {
          const last = current.get(root);
          if (last !== undefined && now - last < MAIN_CHECKOUT_SYNC_INTERVAL_MS) {
            return [false, current] as const;
          }
          return [true, new Map(current).set(root, now)] as const;
        });
        if (!due) return;
        // The turn waits for the sync, but a Stop leaves it running so a merge
        // finishes and keeps the lock until then.
        const fiber = yield* Effect.forkIn(sync(root), scope);
        yield* Fiber.join(fiber);
      },
      (effect) =>
        effect.pipe(
          Effect.provideService(VcsProcess.VcsProcess, vcsProcess),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catchCause(logFailure),
        ),
    );

    return MainCheckoutSync.of({ beforeTurn });
  }),
);
