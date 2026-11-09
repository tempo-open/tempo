/**
 * tempo: moving a thread between environments, driven by a client connected to both: `prepare`
 * archives the source, the client uploads it to `createImportUpload`'s URL over HTTP (never the
 * WebSocket), `import` recreates it, and `finalize` leaves a read-only stub (`abort` cleans up).
 * Repos with a remote move branch and changes; other threads move their folder to "No project".
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import {
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  EnvironmentAuthorizationError,
  type AuthEnvironmentScope,
} from "./auth.ts";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ChatAttachment } from "./chatAttachment.ts";
import { OrchestrationMessageContext } from "./composerContext.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ThreadLinkedPullRequest, ThreadPullRequestLink } from "./threadPullRequest.ts";

/** Names files and refs on both machines, so it is a plain token: never a path. */
export const TempoThreadMoveId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
).pipe(Schema.brand("TempoThreadMoveId"));
export type TempoThreadMoveId = typeof TempoThreadMoveId.Type;

/**
 * One hop of a move, stored on the thread at either end. `movedAt` is an ISO
 * string so the persisted thread JSON needs no codec of its own.
 */
export const TempoThreadMoveLink = Schema.Struct({
  moveId: TempoThreadMoveId,
  environmentId: EnvironmentId,
  environmentLabel: TrimmedNonEmptyString,
  threadId: ThreadId,
  movedAt: IsoDateTime,
  /**
   * On `movedFrom`: the checkout the thread left, as HEAD and the tree of its
   * uncommitted work. Moving back reuses that checkout while it still matches.
   */
  departure: Schema.optional(
    Schema.Struct({
      headCommit: TrimmedNonEmptyString,
      wipTree: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
});
export type TempoThreadMoveLink = typeof TempoThreadMoveLink.Type;

/** A thread that moved away is a stub: it keeps its history and takes no new turns. */
export function isTempoThreadMovedAway(thread: {
  readonly movedTo?: TempoThreadMoveLink | null | undefined;
}): boolean {
  return thread.movedTo != null;
}

/** The move links a thread shell carries; omitted for threads that never moved. */
export function tempoThreadMoveShellFields(thread: {
  readonly movedTo?: TempoThreadMoveLink | null | undefined;
  readonly movedFrom?: TempoThreadMoveLink | null | undefined;
}): { readonly movedTo?: TempoThreadMoveLink; readonly movedFrom?: TempoThreadMoveLink } {
  return {
    ...(thread.movedTo == null ? {} : { movedTo: thread.movedTo }),
    ...(thread.movedFrom == null ? {} : { movedFrom: thread.movedFrom }),
  };
}

const TEMPO_THREAD_MOVE_ARCHIVE_FORMAT = "tempo-thread-move" as const;
const TEMPO_THREAD_MOVE_ARCHIVE_VERSION = 1 as const;

/** A conversation message as it travels. Ids are reassigned on import. */
export const TempoThreadMoveMessage = Schema.Struct({
  role: Schema.Literals(["user", "assistant"]),
  /** "plan": a proposed plan, its markdown in `text`. Older importers read it as an assistant message. */
  kind: Schema.optional(Schema.Literal("plan")),
  text: Schema.String,
  attachments: Schema.Array(ChatAttachment),
  context: Schema.optional(OrchestrationMessageContext),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
});
export type TempoThreadMoveMessage = typeof TempoThreadMoveMessage.Type;

/** A file stored after the manifest, in manifest order. */
export const TempoThreadMoveArchiveFile = Schema.Struct({
  name: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  sha256: TrimmedNonEmptyString,
});
export type TempoThreadMoveArchiveFile = typeof TempoThreadMoveArchiveFile.Type;

/** How the target finds its copy of the repository; the archive's manifest carries the same. */
export const TempoThreadMoveRepository = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  groupingKey: TrimmedNonEmptyString,
  displayName: Schema.NullOr(TrimmedNonEmptyString),
});
export type TempoThreadMoveRepository = typeof TempoThreadMoveRepository.Type;

export const TempoThreadMoveGitState = Schema.Struct({
  /** Branch the thread worked on; the target keeps it unless taken. */
  branch: Schema.NullOr(TrimmedNonEmptyString),
  headCommit: TrimmedNonEmptyString,
  /** Snapshot of uncommitted work (tracked and untracked), parented on `headCommit`. */
  wipCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** Tree of `wipCommit`, which identifies the checkout's state when the thread left. */
  wipTree: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  /** Archive file holding a git bundle; null when the target's remotes already have every commit. */
  bundleFile: Schema.NullOr(TrimmedNonEmptyString),
  /** Refs inside the bundle. */
  bundleRefs: Schema.Array(TrimmedNonEmptyString),
  /** The branch's upstream on the source, such as `origin/feature`; the target tracks it when it has it. */
  upstream: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
});
export type TempoThreadMoveGitState = typeof TempoThreadMoveGitState.Type;

/** Relative to the moved folder, `/`-separated. Not trimmed: a file name may end in a space. */
const FolderPath = Schema.NonEmptyString;

/**
 * One item under a moved folder. A file's bytes are the archive file it
 * names; a link's target is relative and stays inside the folder.
 */
export const TempoThreadMoveFolderEntry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("directory"), path: FolderPath }),
  Schema.Struct({
    type: Schema.Literal("file"),
    path: FolderPath,
    file: TrimmedNonEmptyString,
    /** Permission bits, such as 0o755 for a script. */
    mode: NonNegativeInt,
  }),
  Schema.Struct({ type: Schema.Literal("symlink"), path: FolderPath, target: FolderPath }),
]);
export type TempoThreadMoveFolderEntry = typeof TempoThreadMoveFolderEntry.Type;

/** A thread with no Git remote moves as a copy of its folder, `.git` included. */
export const TempoThreadMoveFolder = Schema.Struct({
  /** Parents come before their children. */
  entries: Schema.Array(TempoThreadMoveFolderEntry),
  /** Paths left behind because they cannot be copied: sockets, devices, links that leave the folder. */
  skipped: Schema.Array(Schema.String),
});
export type TempoThreadMoveFolder = typeof TempoThreadMoveFolder.Type;

export const TempoThreadMoveProviderRef = Schema.Struct({
  driver: TrimmedNonEmptyString,
  providerInstanceId: TrimmedNonEmptyString,
  nativeId: Schema.NullOr(TrimmedNonEmptyString),
});
export type TempoThreadMoveProviderRef = typeof TempoThreadMoveProviderRef.Type;

export const TempoThreadMoveManifest = Schema.Struct({
  format: Schema.Literal(TEMPO_THREAD_MOVE_ARCHIVE_FORMAT),
  version: Schema.Literal(TEMPO_THREAD_MOVE_ARCHIVE_VERSION),
  moveId: TempoThreadMoveId,
  createdAt: Schema.DateTimeUtc,
  source: Schema.Struct({
    threadId: ThreadId,
    projectId: ProjectId,
    /** Directory the thread ran in; absolute paths under it are rewritten on import. */
    cwd: TrimmedNonEmptyString,
    workspaceRoot: TrimmedNonEmptyString,
  }),
  /** Both null when the thread moves as a copy of its folder: then `folder` is set. */
  repository: Schema.NullOr(TempoThreadMoveRepository),
  git: Schema.NullOr(TempoThreadMoveGitState),
  folder: Schema.optional(TempoThreadMoveFolder),
  thread: Schema.Struct({
    title: TrimmedNonEmptyString,
    modelSelection: ModelSelection,
    /** Driver of the selected provider instance, so a target without that instance can pick its own. */
    providerDriver: Schema.NullOr(TrimmedNonEmptyString),
    runtimeMode: RuntimeMode,
    interactionMode: ProviderInteractionMode,
    createdAt: Schema.DateTimeUtc,
    /** Hop that brought the thread to the source, kept for the trail. */
    movedFrom: Schema.NullOr(TempoThreadMoveLink),
    /** Pull requests linked to the thread. Watches stay with the machine that set them up. */
    linkedPullRequest: Schema.optional(Schema.NullOr(ThreadLinkedPullRequest)),
    pullRequests: Schema.optional(Schema.Array(ThreadPullRequestLink)),
  }),
  messages: Schema.Array(TempoThreadMoveMessage),
  /** Provider conversations the source held; informational until native resume lands. */
  providerRefs: Schema.Array(TempoThreadMoveProviderRef),
  files: Schema.Array(TempoThreadMoveArchiveFile),
});
export type TempoThreadMoveManifest = typeof TempoThreadMoveManifest.Type;

export const TempoThreadMovePrepareInput = Schema.Struct({
  threadId: ThreadId,
  /**
   * Set when the client and the target can take a thread with no Git remote
   * as a copy of its folder. Without it such a thread is refused, which keeps
   * folder moves from clients and targets that predate them.
   */
  allowFolder: Schema.optional(Schema.Boolean),
});
export type TempoThreadMovePrepareInput = typeof TempoThreadMovePrepareInput.Type;

/** Archives past this size do not move: the client holds one in memory on its way. */
export const TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

export const TempoThreadMovePrepareResult = Schema.Struct({
  moveId: TempoThreadMoveId,
  downloadRelativeUrl: TrimmedNonEmptyString,
  sizeBytes: NonNegativeInt,
  expiresAt: Schema.Number,
  messageCount: NonNegativeInt,
  hasUncommittedChanges: Schema.Boolean,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  /** Null when the archive carries the thread's folder instead. */
  repository: Schema.NullOr(TempoThreadMoveRepository),
});
export type TempoThreadMovePrepareResult = typeof TempoThreadMovePrepareResult.Type;

export const TempoThreadMoveCreateImportUploadInput = Schema.Struct({
  moveId: TempoThreadMoveId,
  sizeBytes: NonNegativeInt.check(Schema.isLessThanOrEqualTo(TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES)),
  /**
   * Checked before any bytes move, so a missing project fails fast. Null for
   * a folder, which needs the target's folders for threads without a project.
   */
  repository: Schema.NullOr(TempoThreadMoveRepository),
});
export type TempoThreadMoveCreateImportUploadInput =
  typeof TempoThreadMoveCreateImportUploadInput.Type;

export const TempoThreadMoveCreateImportUploadResult = Schema.Struct({
  uploadRelativeUrl: TrimmedNonEmptyString,
  expiresAt: Schema.Number,
});
export type TempoThreadMoveCreateImportUploadResult =
  typeof TempoThreadMoveCreateImportUploadResult.Type;

export const TempoThreadMoveImportInput = Schema.Struct({
  moveId: TempoThreadMoveId,
  source: Schema.Struct({
    environmentId: EnvironmentId,
    environmentLabel: TrimmedNonEmptyString,
  }),
});
export type TempoThreadMoveImportInput = typeof TempoThreadMoveImportInput.Type;

export const TempoThreadMoveImportResult = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  branch: Schema.NullOr(TrimmedNonEmptyString),
  worktreePath: TrimmedNonEmptyString,
  /** Things the move could not carry, for the client to show. */
  notes: Schema.Array(Schema.String),
});
export type TempoThreadMoveImportResult = typeof TempoThreadMoveImportResult.Type;

export const TempoThreadMoveFinalizeInput = Schema.Struct({
  threadId: ThreadId,
  moveId: TempoThreadMoveId,
  target: Schema.Struct({
    environmentId: EnvironmentId,
    environmentLabel: TrimmedNonEmptyString,
    threadId: ThreadId,
  }),
});
export type TempoThreadMoveFinalizeInput = typeof TempoThreadMoveFinalizeInput.Type;

export const TempoThreadMoveFinalizeResult = Schema.Struct({
  /** Scheduled tasks that posted into the thread; paused, since the stub takes no new turns. */
  pausedScheduledTasks: NonNegativeInt,
});
export type TempoThreadMoveFinalizeResult = typeof TempoThreadMoveFinalizeResult.Type;

export const TempoThreadMoveAbortInput = Schema.Struct({
  threadId: ThreadId,
  moveId: TempoThreadMoveId,
});
export type TempoThreadMoveAbortInput = typeof TempoThreadMoveAbortInput.Type;

export class TempoThreadMoveThreadNotFoundError extends Schema.TaggedError<TempoThreadMoveThreadNotFoundError>()(
  "TempoThreadMoveThreadNotFoundError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This thread no longer exists.";
  }
}

export class TempoThreadMoveRunActiveError extends Schema.TaggedError<TempoThreadMoveRunActiveError>()(
  "TempoThreadMoveRunActiveError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Stop the running turn before moving this thread.";
  }
}

export class TempoThreadMoveAlreadyMovedError extends Schema.TaggedError<TempoThreadMoveAlreadyMovedError>()(
  "TempoThreadMoveAlreadyMovedError",
  { threadId: ThreadId, environmentLabel: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `This thread already moved to ${this.environmentLabel}.`;
  }
}

/**
 * A thread with no Git remote moves as a copy of its folder, which the client
 * asks for only when the target can take one (`allowFolder`). A source raises
 * this when it was not asked, or predates folder moves.
 */
export class TempoThreadMoveRepositoryRequiredError extends Schema.TaggedError<TempoThreadMoveRepositoryRequiredError>()(
  "TempoThreadMoveRepositoryRequiredError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "This thread has no Git remote, so it moves as a copy of its folder. Update Tempo on both machines to move it.";
  }
}

/** The target keeps its data inside a Git checkout, so it has no folders for threads without a project. */
export class TempoThreadMoveFolderUnavailableError extends Schema.TaggedError<TempoThreadMoveFolderUnavailableError>()(
  "TempoThreadMoveFolderUnavailableError",
  {},
) {
  override get message(): string {
    return "This thread has no Git remote, so it moves into a new folder, and the machine it is moving to cannot make folders for threads without a project.";
  }
}

/**
 * The source took a new turn after `prepare`, so the copy the target made
 * lacks it. The source stays live rather than hide that turn behind a stub.
 */
export class TempoThreadMoveThreadChangedError extends Schema.TaggedError<TempoThreadMoveThreadChangedError>()(
  "TempoThreadMoveThreadChangedError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "It took a new turn while the thread was moving, so the moved copy does not have that turn.";
  }
}

export class TempoThreadMoveProjectNotFoundError extends Schema.TaggedError<TempoThreadMoveProjectNotFoundError>()(
  "TempoThreadMoveProjectNotFoundError",
  { repository: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `Open ${this.repository} as a project on the machine it is moving to first.`;
  }
}

export class TempoThreadMoveTooLargeError extends Schema.TaggedError<TempoThreadMoveTooLargeError>()(
  "TempoThreadMoveTooLargeError",
  {
    sizeBytes: NonNegativeInt,
    maxBytes: NonNegativeInt,
    /** Set when the thread's folder was being copied, which may also hold at most this many items. */
    maxFolderEntries: Schema.optional(NonNegativeInt),
  },
) {
  override get message(): string {
    const megabytes = (bytes: number) => Math.ceil(bytes / (1024 * 1024));
    if (this.maxFolderEntries !== undefined) {
      // A folder copy stops counting at the first limit it passes, so its totals would mislead.
      return `This thread's folder is too large to move: the limit is ${megabytes(this.maxBytes)} MB and ${this.maxFolderEntries} files and folders. Delete what can be rebuilt, such as node_modules, or move large files out of it.`;
    }
    return `This thread's uncommitted work is too large to move (${megabytes(this.sizeBytes)} MB; the limit is ${megabytes(this.maxBytes)} MB). Commit and push large files, or add them to .gitignore.`;
  }
}

export class TempoThreadMoveMissingCommitsError extends Schema.TaggedError<TempoThreadMoveMissingCommitsError>()(
  "TempoThreadMoveMissingCommitsError",
  { moveId: TempoThreadMoveId },
) {
  override get message(): string {
    return "This machine is missing commits the thread builds on. Fetch the repository here and try again.";
  }
}

export class TempoThreadMoveArchiveNotFoundError extends Schema.TaggedError<TempoThreadMoveArchiveNotFoundError>()(
  "TempoThreadMoveArchiveNotFoundError",
  { moveId: TempoThreadMoveId },
) {
  override get message(): string {
    return "The moved thread did not arrive. Start the move again.";
  }
}

export const TempoThreadMoveStage = Schema.Literals([
  "export",
  "archive",
  "git",
  "import",
  "finalize",
  "cleanup",
]);
export type TempoThreadMoveStage = typeof TempoThreadMoveStage.Type;

const NEXT_STEP: Record<TempoThreadMoveStage, string> = {
  export: "Try again.",
  archive: "Check that the machine has free disk space, then try again.",
  git: "Check that the repository can fetch from its remote on both machines, then try again.",
  import: "Try again.",
  finalize: "Try again.",
  cleanup: "Try again.",
};

export class TempoThreadMoveFailedError extends Schema.TaggedError<TempoThreadMoveFailedError>()(
  "TempoThreadMoveFailedError",
  {
    stage: TempoThreadMoveStage,
    /** A short, user-safe line about what failed, such as git's first error line. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const detail = this.detail === undefined ? "." : ` (${this.detail}).`;
    return `Moving the thread failed during ${this.stage}${detail} ${NEXT_STEP[this.stage]}`;
  }
}

export const TempoThreadMoveError = Schema.Union([
  TempoThreadMoveThreadNotFoundError,
  TempoThreadMoveRunActiveError,
  TempoThreadMoveAlreadyMovedError,
  TempoThreadMoveThreadChangedError,
  TempoThreadMoveRepositoryRequiredError,
  TempoThreadMoveFolderUnavailableError,
  TempoThreadMoveProjectNotFoundError,
  TempoThreadMoveMissingCommitsError,
  TempoThreadMoveArchiveNotFoundError,
  TempoThreadMoveTooLargeError,
  TempoThreadMoveFailedError,
]);
export type TempoThreadMoveError = typeof TempoThreadMoveError.Type;

export const TEMPO_THREAD_MOVE_WS_METHODS = {
  prepare: "tempo.threadMove.prepare",
  createImportUpload: "tempo.threadMove.createImportUpload",
  import: "tempo.threadMove.import",
  finalize: "tempo.threadMove.finalize",
  abort: "tempo.threadMove.abort",
} as const;

/** Every step changes threads or checkouts on its environment. */
export const TEMPO_THREAD_MOVE_RPC_SCOPES = {
  [TEMPO_THREAD_MOVE_WS_METHODS.prepare]: AuthOrchestrationOperateScope,
  [TEMPO_THREAD_MOVE_WS_METHODS.createImportUpload]: AuthOrchestrationOperateScope,
  [TEMPO_THREAD_MOVE_WS_METHODS.import]: AuthOrchestrationOperateScope,
  [TEMPO_THREAD_MOVE_WS_METHODS.finalize]: AuthOrchestrationOperateScope,
  [TEMPO_THREAD_MOVE_WS_METHODS.abort]: AuthOrchestrationOperateScope,
} as const;

/**
 * Packing a thread writes hidden refs and reads the checkout's files, and
 * unpacking one creates a branch and a worktree and writes files into it, so
 * those steps need the source-control and filesystem grants their own RPCs do.
 */
const SOURCE_SCOPES = [
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemReadScope,
] as const;
const TARGET_SCOPES = [
  AuthOrchestrationOperateScope,
  AuthSourceControlWriteScope,
  AuthFilesystemWriteScope,
] as const;

const TEMPO_THREAD_MOVE_REQUIRED_SCOPES: Record<string, ReadonlyArray<AuthEnvironmentScope>> = {
  [TEMPO_THREAD_MOVE_WS_METHODS.prepare]: SOURCE_SCOPES,
  [TEMPO_THREAD_MOVE_WS_METHODS.createImportUpload]: TARGET_SCOPES,
  [TEMPO_THREAD_MOVE_WS_METHODS.import]: TARGET_SCOPES,
  [TEMPO_THREAD_MOVE_WS_METHODS.finalize]: [AuthOrchestrationOperateScope],
  [TEMPO_THREAD_MOVE_WS_METHODS.abort]: [AuthOrchestrationOperateScope],
};

/** Every scope a move RPC needs, or null for other methods. */
export function tempoThreadMoveRequiredScopes(
  method: string,
): ReadonlyArray<AuthEnvironmentScope> | null {
  return Object.hasOwn(TEMPO_THREAD_MOVE_REQUIRED_SCOPES, method)
    ? (TEMPO_THREAD_MOVE_REQUIRED_SCOPES[method] ?? null)
    : null;
}

/** What a client needs on each end to offer a move. */
export const TEMPO_THREAD_MOVE_SOURCE_SCOPES: ReadonlyArray<AuthEnvironmentScope> = SOURCE_SCOPES;
export const TEMPO_THREAD_MOVE_TARGET_SCOPES: ReadonlyArray<AuthEnvironmentScope> = TARGET_SCOPES;

const TempoThreadMoveRpcError = Schema.Union([TempoThreadMoveError, EnvironmentAuthorizationError]);

export const TempoThreadMovePrepareRpc = Rpc.make(TEMPO_THREAD_MOVE_WS_METHODS.prepare, {
  payload: TempoThreadMovePrepareInput,
  success: TempoThreadMovePrepareResult,
  error: TempoThreadMoveRpcError,
});

export const TempoThreadMoveCreateImportUploadRpc = Rpc.make(
  TEMPO_THREAD_MOVE_WS_METHODS.createImportUpload,
  {
    payload: TempoThreadMoveCreateImportUploadInput,
    success: TempoThreadMoveCreateImportUploadResult,
    error: TempoThreadMoveRpcError,
  },
);

export const TempoThreadMoveImportRpc = Rpc.make(TEMPO_THREAD_MOVE_WS_METHODS.import, {
  payload: TempoThreadMoveImportInput,
  success: TempoThreadMoveImportResult,
  error: TempoThreadMoveRpcError,
});

export const TempoThreadMoveFinalizeRpc = Rpc.make(TEMPO_THREAD_MOVE_WS_METHODS.finalize, {
  payload: TempoThreadMoveFinalizeInput,
  success: TempoThreadMoveFinalizeResult,
  error: TempoThreadMoveRpcError,
});

export const TempoThreadMoveAbortRpc = Rpc.make(TEMPO_THREAD_MOVE_WS_METHODS.abort, {
  payload: TempoThreadMoveAbortInput,
  error: TempoThreadMoveRpcError,
});
