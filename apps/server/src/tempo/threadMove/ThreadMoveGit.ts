import {
  CheckpointRef,
  TempoThreadMoveMissingCommitsError,
  type TempoThreadMoveGitState,
  type TempoThreadMoveId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";

// Bundling and fetching scale with history size; ordinary commands keep the driver default.
const LONG_GIT_TIMEOUT_MS = 10 * 60_000;
const LIST_REMOTE_TIMEOUT_MS = 60_000;
// Listing a remote must fail rather than wait on a credential prompt, as
// upstream's background upstream refresh does (GitVcsDriverCore).
const LIST_REMOTE_ENV = {
  GCM_INTERACTIVE: "never",
  GIT_ASKPASS: "",
  GIT_TERMINAL_PROMPT: "0",
  SSH_ASKPASS: "",
  SSH_ASKPASS_REQUIRE: "never",
} satisfies NodeJS.ProcessEnv;

class ThreadMoveGitError extends Schema.TaggedError<ThreadMoveGitError>()("ThreadMoveGitError", {
  step: Schema.Literals([
    "inspect",
    "snapshot",
    "bundle",
    "fetch",
    "branch",
    "worktree",
    "restore",
    "cleanup",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Git failed while moving a thread (${this.step}).`;
  }
}

type GitStep = ThreadMoveGitError["step"];

export function moveRefPrefix(moveId: TempoThreadMoveId): string {
  return `refs/tempo/thread-move/${moveId}`;
}

interface GitOptions {
  readonly allowNonZeroExit?: boolean;
  readonly timeoutMs?: number;
  readonly stdin?: string;
  readonly env?: NodeJS.ProcessEnv;
}

const git = Effect.fn("ThreadMoveGit.git")(function* (
  step: GitStep,
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  return yield* driver
    .execute({ operation: `tempo.threadMove.${step}`, cwd, args, ...options })
    .pipe(Effect.mapError((cause) => new ThreadMoveGitError({ step, cause })));
});

const gitOutput = (
  step: GitStep,
  cwd: string,
  args: ReadonlyArray<string>,
  options: GitOptions = {},
) => git(step, cwd, args, options).pipe(Effect.map((result) => result.stdout.trim()));

const lines = (output: string) => output.split("\n").filter((line) => line !== "");

const commitExists = (cwd: string, commit: string) =>
  git("fetch", cwd, ["cat-file", "-e", `${commit}^{commit}`], { allowNonZeroExit: true }).pipe(
    Effect.map((result) => result.exitCode === 0),
  );

/**
 * The remote-tracking refs whose branch the remote still has, so a target can fetch every commit
 * they reach; commits only a deleted branch's leftover ref reaches travel in the bundle. A remote
 * that cannot be listed (offline, no credentials) keeps only its default branch when that is known
 * here, and otherwise every ref it has here.
 */
const fetchableRemoteRefs = Effect.fn("ThreadMoveGit.fetchableRemoteRefs")(function* (cwd: string) {
  const remotes = lines(yield* gitOutput("bundle", cwd, ["remote"]));
  const perRemote = yield* Effect.forEach(
    remotes,
    (remote) =>
      Effect.gen(function* () {
        const prefix = `refs/remotes/${remote}/`;
        const tracked = lines(
          yield* gitOutput("bundle", cwd, ["for-each-ref", "--format=%(refname)", prefix]),
        );
        const listed = yield* git("bundle", cwd, ["ls-remote", "--heads", remote], {
          allowNonZeroExit: true,
          timeoutMs: LIST_REMOTE_TIMEOUT_MS,
          env: LIST_REMOTE_ENV,
        }).pipe(Effect.option);
        if (Option.isSome(listed) && listed.value.exitCode === 0) {
          const live = new Set<string>();
          for (const line of lines(listed.value.stdout)) {
            const ref = line.split("\t")[1];
            if (ref?.startsWith("refs/heads/")) live.add(prefix + ref.slice("refs/heads/".length));
          }
          return tracked.filter((ref) => live.has(ref));
        }
        const defaultBranch = `${prefix}HEAD`;
        return tracked.includes(defaultBranch) ? [defaultBranch] : tracked;
      }),
    { concurrency: "unbounded" },
  );
  return perRemote.flat();
});

/**
 * Captures the checkout at `cwd` for a move without touching the user's branch, index, or files:
 * HEAD and a snapshot of uncommitted work go on hidden refs, and a bundle carries every commit the
 * repository's remotes cannot provide as they are now. Returns null for the bundle when there is
 * nothing to carry.
 */
export const captureMoveGitState = Effect.fn("ThreadMoveGit.capture")(function* (input: {
  readonly cwd: string;
  readonly moveId: TempoThreadMoveId;
  readonly bundlePath: string;
  readonly bundleFile: string;
}) {
  const checkpoints = yield* CheckpointStore.CheckpointStore;
  const prefix = moveRefPrefix(input.moveId);
  const headCommit = yield* gitOutput("inspect", input.cwd, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  const symbolic = yield* git(
    "inspect",
    input.cwd,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      allowNonZeroExit: true,
    },
  );
  const branch =
    symbolic.exitCode === 0 && symbolic.stdout.trim() !== "" ? symbolic.stdout.trim() : null;
  const tracking =
    branch === null
      ? null
      : yield* git(
          "inspect",
          input.cwd,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
          { allowNonZeroExit: true },
        );
  const upstream =
    tracking !== null && tracking.exitCode === 0 && tracking.stdout.trim() !== ""
      ? tracking.stdout.trim()
      : null;
  const status = yield* gitOutput("inspect", input.cwd, [
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  const headRef = `${prefix}/head`;
  yield* git("snapshot", input.cwd, ["update-ref", headRef, headCommit]);
  let wipCommit: string | null = null;
  let wipTree: string | null = null;
  const refs = [headRef];
  if (status.length > 0) {
    const wipRef = `${prefix}/wip`;
    yield* checkpoints
      .captureCheckpoint({ cwd: input.cwd, checkpointRef: CheckpointRef.make(wipRef) })
      .pipe(Effect.mapError((cause) => new ThreadMoveGitError({ step: "snapshot", cause })));
    wipCommit = yield* gitOutput("snapshot", input.cwd, ["rev-parse", "--verify", wipRef]);
    wipTree = yield* gitOutput("snapshot", input.cwd, [
      "rev-parse",
      "--verify",
      `${wipRef}^{tree}`,
    ]);
    refs.push(wipRef);
  }
  // A large repository can have thousands of these, so they go on stdin.
  const exclude = (yield* fetchableRemoteRefs(input.cwd)).map((ref) => `^${ref}\n`).join("");
  const missing = yield* gitOutput(
    "bundle",
    input.cwd,
    ["rev-list", "--count", ...refs, "--stdin"],
    { stdin: exclude },
  );
  const hasBundle = Number(missing) > 0;
  if (hasBundle) {
    yield* git(
      "bundle",
      input.cwd,
      ["bundle", "create", "--quiet", input.bundlePath, ...refs, "--stdin"],
      { timeoutMs: LONG_GIT_TIMEOUT_MS, stdin: exclude },
    );
  }
  return {
    branch,
    headCommit,
    wipCommit,
    wipTree,
    bundleFile: hasBundle ? input.bundleFile : null,
    bundleRefs: hasBundle ? refs : [],
    upstream,
  } satisfies TempoThreadMoveGitState;
});

/** Removes a move's hidden refs. Safe to repeat. */
export const deleteMoveRefs = Effect.fn("ThreadMoveGit.deleteRefs")(function* (input: {
  readonly cwd: string;
  readonly moveId: TempoThreadMoveId;
}) {
  const prefix = moveRefPrefix(input.moveId);
  const listed = yield* git(
    "cleanup",
    input.cwd,
    ["for-each-ref", "--format=%(refname)", `${prefix}/`],
    { allowNonZeroExit: true },
  );
  const refs = listed.exitCode === 0 ? listed.stdout.split("\n").filter((ref) => ref !== "") : [];
  for (const ref of refs) {
    yield* git("cleanup", input.cwd, ["update-ref", "-d", ref], { allowNonZeroExit: true });
  }
});

/** First branch name not taken: the preferred one, then `-moved`, `-moved-2`, ... */
export const chooseMovedBranch = Effect.fn("ThreadMoveGit.chooseBranch")(function* (input: {
  readonly cwd: string;
  readonly preferred: string;
}) {
  const valid = yield* git("branch", input.cwd, ["check-ref-format", "--branch", input.preferred], {
    allowNonZeroExit: true,
  });
  const base = valid.exitCode === 0 ? input.preferred : "tempo/moved-thread";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate =
      attempt === 0 ? base : attempt === 1 ? `${base}-moved` : `${base}-moved-${attempt}`;
    const taken = yield* git(
      "branch",
      input.cwd,
      ["show-ref", "--verify", "--quiet", `refs/heads/${candidate}`],
      { allowNonZeroExit: true },
    );
    if (taken.exitCode !== 0) return candidate;
  }
  return yield* new ThreadMoveGitError({ step: "branch" });
});

/** Where a thread came from on this machine, when it is coming home. */
export interface MoveHome {
  readonly checkout: string;
  readonly branch: string | null;
  readonly departure: { readonly headCommit: string; readonly wipTree: string | null };
}

/**
 * Whether the checkout a thread left can take it back: still on its branch,
 * at the HEAD it left, with exactly the uncommitted work it left with. That
 * work traveled with the thread, so replacing it with the returning state
 * loses nothing. Returns the commit holding the checkout's current state.
 */
const reusableCheckout = Effect.fn("ThreadMoveGit.reusableCheckout")(
  function* (home: MoveHome, moveId: TempoThreadMoveId) {
    const checkpoints = yield* CheckpointStore.CheckpointStore;
    const current = yield* git(
      "inspect",
      home.checkout,
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      { allowNonZeroExit: true },
    );
    const branch = current.exitCode === 0 ? current.stdout.trim() : "";
    if (branch === "" || (home.branch !== null && branch !== home.branch)) return null;
    const head = yield* gitOutput("inspect", home.checkout, ["rev-parse", "--verify", "HEAD"]);
    if (head !== home.departure.headCommit) return null;
    if (home.departure.wipTree === null) {
      const status = yield* gitOutput("inspect", home.checkout, [
        "status",
        "--porcelain",
        "--untracked-files=normal",
      ]);
      return status === "" ? { branch, head, state: head } : null;
    }
    const hereRef = `${moveRefPrefix(moveId)}/here`;
    yield* checkpoints
      .captureCheckpoint({ cwd: home.checkout, checkpointRef: CheckpointRef.make(hereRef) })
      .pipe(Effect.mapError((cause) => new ThreadMoveGitError({ step: "snapshot", cause })));
    const state = yield* gitOutput("inspect", home.checkout, ["rev-parse", "--verify", hereRef]);
    const tree = yield* gitOutput("inspect", home.checkout, [
      "rev-parse",
      "--verify",
      `${state}^{tree}`,
    ]);
    return tree === home.departure.wipTree ? { branch, head, state } : null;
  },
  Effect.orElseSucceed(() => null),
);

/** Runs every cleanup step in order, whether or not the ones before it worked. */
const settleAll = <A, E, R>(steps: ReadonlyArray<Effect.Effect<A, E, R>>) =>
  Effect.forEach(steps, (step) => Effect.ignore(step), { discard: true });

export interface RestoredMoveCheckout {
  readonly branch: string;
  readonly worktreePath: string;
  /** True when the thread came home to the checkout its stub left behind. */
  readonly reused: boolean;
  /** Puts the repository back as it was before the restore. */
  readonly undo: Effect.Effect<void>;
}

/**
 * Brings a move's commits into the repository at `repoCwd` and checks the moved HEAD out, its
 * uncommitted work restored as uncommitted changes: in the checkout a returning thread's stub left
 * when a fast-forward is safe (`reuse`), else in a new worktree on a new branch. Commits the bundle
 * lacks come from the remotes; whatever a failed or interrupted restore created is removed.
 */
export const restoreMoveGitState = Effect.fn("ThreadMoveGit.restore")(function* (input: {
  readonly repoCwd: string;
  readonly moveId: TempoThreadMoveId;
  readonly git: TempoThreadMoveGitState;
  readonly bundlePath: string | null;
  readonly worktreesDirectory: string;
  readonly home: MoveHome | null;
}) {
  const driver = yield* GitVcsDriver.GitVcsDriver;
  const prefix = moveRefPrefix(input.moveId);
  const fetchRemotes = git("fetch", input.repoCwd, ["fetch", "--quiet", "--all"], {
    allowNonZeroExit: true,
    timeoutMs: LONG_GIT_TIMEOUT_MS,
  });
  const missingCommits = new TempoThreadMoveMissingCommitsError({ moveId: input.moveId });
  const restore = Effect.gen(function* () {
    if (input.bundlePath !== null) {
      const verify = git(
        "fetch",
        input.repoCwd,
        ["bundle", "verify", "--quiet", input.bundlePath],
        { allowNonZeroExit: true, timeoutMs: LONG_GIT_TIMEOUT_MS },
      );
      if ((yield* verify).exitCode !== 0) {
        yield* fetchRemotes;
        if ((yield* verify).exitCode !== 0) return yield* missingCommits;
      }
      yield* git(
        "fetch",
        input.repoCwd,
        ["fetch", "--quiet", "--no-tags", input.bundlePath, `+${prefix}/*:${prefix}/*`],
        { timeoutMs: LONG_GIT_TIMEOUT_MS },
      );
    }
    const required = [input.git.headCommit, ...(input.git.wipCommit ? [input.git.wipCommit] : [])];
    const allPresent = (commits: ReadonlyArray<string>) =>
      Effect.forEach(commits, (commit) => commitExists(input.repoCwd, commit)).pipe(
        Effect.map((present) => present.every(Boolean)),
      );
    if (!(yield* allPresent(required))) {
      yield* fetchRemotes;
      if (!(yield* allPresent(required))) return yield* missingCommits;
    }

    const reusable = input.home === null ? null : yield* reusableCheckout(input.home, input.moveId);
    if (input.home !== null && reusable !== null) {
      const worktreePath = input.home.checkout;
      const arriving = input.git.wipCommit ?? input.git.headCommit;
      // Index the files as they are (`from`), switch them to `to`, move the
      // branch to `head`, and leave the difference as uncommitted work.
      const switchFiles = (from: string, to: string, head: string) =>
        [
          ["read-tree", "--reset", from],
          ["read-tree", "-u", "--reset", to],
          ["reset", "--quiet", "--soft", head],
          ["reset", "--quiet", "--mixed", "HEAD"],
        ].map((args) => git("restore", worktreePath, args));
      const undo = settleAll(switchFiles(arriving, reusable.state, reusable.head)).pipe(
        Effect.provideService(GitVcsDriver.GitVcsDriver, driver),
      );
      yield* Effect.forEach(
        switchFiles(reusable.state, arriving, input.git.headCommit),
        (step) => step,
        { discard: true },
      ).pipe(Effect.onError(() => undo));
      return {
        branch: reusable.branch,
        worktreePath,
        reused: true,
        undo,
      } satisfies RestoredMoveCheckout;
    }

    const branch = yield* chooseMovedBranch({
      cwd: input.repoCwd,
      preferred: input.git.branch ?? `tempo/moved-${input.moveId.slice(0, 8)}`,
    });
    const upstream = input.git.upstream ?? null;
    const wipCommit = input.git.wipCommit;
    // The worktree's undo is armed as soon as it exists, with no gap an interruption can land in.
    return yield* Effect.uninterruptibleMask((interruptible) =>
      Effect.gen(function* () {
        const created = yield* interruptible(
          driver
            .createWorktree(
              { cwd: input.repoCwd, refName: input.git.headCommit, newRefName: branch, path: null },
              { worktreesDirectory: input.worktreesDirectory },
            )
            .pipe(Effect.mapError((cause) => new ThreadMoveGitError({ step: "worktree", cause }))),
        );
        const checkout: RestoredMoveCheckout = {
          branch,
          worktreePath: created.worktree.path,
          reused: false,
          undo: settleAll([
            driver.removeWorktree({ cwd: input.repoCwd, path: created.worktree.path, force: true }),
            driver.deleteLocalBranch({ cwd: input.repoCwd, refName: branch, force: true }),
          ]),
        };
        yield* interruptible(
          Effect.gen(function* () {
            // Track the branch the source tracked, when this repository has it under the same name.
            if (upstream !== null && branch === input.git.branch) {
              yield* git(
                "branch",
                input.repoCwd,
                ["branch", "--quiet", `--set-upstream-to=${upstream}`, branch],
                { allowNonZeroExit: true },
              );
            }
            if (wipCommit !== null) {
              // Check the snapshot's tree out, then point the index back at HEAD: the
              // files keep the snapshot's content and show as uncommitted changes.
              yield* git("restore", checkout.worktreePath, [
                "read-tree",
                "-u",
                "--reset",
                wipCommit,
              ]);
              yield* git("restore", checkout.worktreePath, ["reset", "--quiet", "--mixed", "HEAD"]);
            }
          }),
        ).pipe(Effect.onError(() => checkout.undo));
        return checkout;
      }),
    );
  });
  return yield* restore.pipe(
    Effect.ensuring(
      deleteMoveRefs({ cwd: input.repoCwd, moveId: input.moveId }).pipe(Effect.ignore),
    ),
  );
});
