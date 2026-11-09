import {
  TempoThreadMoveAlreadyMovedError,
  TempoThreadMoveArchiveNotFoundError,
  TempoThreadMoveFailedError,
  TempoThreadMoveFolderUnavailableError,
  TempoThreadMoveId,
  TempoThreadMoveProjectNotFoundError,
  TempoThreadMoveRepositoryRequiredError,
  TempoThreadMoveRunActiveError,
  TempoThreadMoveThreadChangedError,
  TempoThreadMoveThreadNotFoundError,
  TempoThreadMoveTooLargeError,
  TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES,
  EventId,
  NonNegativeInt,
  ThreadId,
  repositoryGroupingKeyOf,
  repositoryGroupingDisplayNameOf,
  type TempoThreadMoveAbortInput,
  type TempoThreadMoveCreateImportUploadInput,
  type TempoThreadMoveCreateImportUploadResult,
  type TempoThreadMoveError,
  type TempoThreadMoveFinalizeInput,
  type TempoThreadMoveFinalizeResult,
  type TempoThreadMoveFolder,
  type TempoThreadMoveImportInput,
  type TempoThreadMoveImportResult,
  type TempoThreadMoveLink,
  type TempoThreadMoveManifest,
  type TempoThreadMovePrepareInput,
  type TempoThreadMovePrepareResult,
  type TempoThreadMoveRepository,
  type TempoThreadMoveStage,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { extractArchive, writeArchive, type ArchiveInputFile } from "./ThreadMoveArchive.ts";
import {
  captureMoveFolder,
  restoreMoveFolder,
  MAX_FOLDER_ENTRIES,
  type CapturedMoveFolder,
} from "./ThreadMoveFolder.ts";
import { captureMoveGitState, deleteMoveRefs, restoreMoveGitState } from "./ThreadMoveGit.ts";
import {
  attachmentArchiveFileName,
  buildMovedThreadEvents,
  copyMovedAttachments,
  exportMovedMessages,
  movedAwayThread,
  movedThreadId,
  resolveMovedModelSelection,
  type PathMapping,
} from "./ThreadMoveThread.ts";
import { issueTransferUrl, transferExpiry, validateTransferToken } from "./ThreadMoveTokens.ts";

const MOVES_DIRECTORY = "tempo-thread-moves";
const ARCHIVE_FILE = "archive.tempomove";
const RECORD_FILE = "move.json";
const BUNDLE_FILE = "repo.bundle";
// Moves that never finished leave their files behind; later moves sweep them.
const STALE_MOVE_MS = 24 * 60 * 60_000;

/** What the source remembers between `prepare` and `finalize`/`abort`. */
const OutgoingMoveRecord = Schema.Struct({
  threadId: ThreadId,
  runCount: NonNegativeInt,
});
const outgoingMoveRecordJson = Schema.fromJsonString(OutgoingMoveRecord);
const encodeRecord = Schema.encodeEffect(outgoingMoveRecordJson);
const decodeRecord = Schema.decodeUnknownEffect(outgoingMoveRecordJson);

type ThreadMoveUploadResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly status: 400 | 404 | 409 | 500; readonly detail: string };

function isActiveRun(run: Pick<OrchestrationV2Run, "status">): boolean {
  return (
    run.status === "preparing" ||
    run.status === "queued" ||
    run.status === "starting" ||
    run.status === "running" ||
    run.status === "waiting"
  );
}

/** One short line about what failed, for the user: git's step and its first error line. */
function failureDetail(cause: unknown): string | undefined {
  const parts: Array<string> = [];
  let current = cause;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth += 1) {
    if ("step" in current && typeof current.step === "string") parts.push(current.step);
    if ("detail" in current && typeof current.detail === "string") {
      const line = current.detail.trim().split("\n")[0]?.trim() ?? "";
      if (line !== "") parts.push(line.slice(0, 200));
      break;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return parts.length === 0 ? undefined : parts.join(": ");
}

const failed = (stage: TempoThreadMoveStage) => (cause: unknown) => {
  const detail = failureDetail(cause);
  return new TempoThreadMoveFailedError({
    stage,
    cause,
    ...(detail === undefined ? {} : { detail }),
  });
};

/** The full cause of an unexpected failure goes to the server log; the client sees one line. */
const logFailure = <A, R>(effect: Effect.Effect<A, TempoThreadMoveError, R>) =>
  effect.pipe(
    Effect.tapError((error) =>
      error._tag === "TempoThreadMoveFailedError"
        ? Effect.logWarning("A thread move failed.", { stage: error.stage, cause: error.cause })
        : Effect.void,
    ),
  );

const NO_FOLDER: CapturedMoveFolder = { entries: [], files: [], skipped: [] };

/** Where an import put the thread's files, and how to take that back. */
interface MovedPlacement {
  readonly projectId: ProjectId;
  readonly branch: string | null;
  /** Where the thread's files are. */
  readonly worktreePath: string;
  /** What the thread records: null when it runs in its project's own checkout. */
  readonly threadWorktreePath: string | null;
  readonly departure: TempoThreadMoveLink["departure"];
  readonly pathMappings: ReadonlyArray<PathMapping>;
  /** About the files; they follow the note on tool activity. */
  readonly notes: ReadonlyArray<string>;
  /** Removes what placing the files created. */
  readonly undo: Effect.Effect<void>;
  /** Starts what the files need once the thread exists; returns notes. */
  readonly setUp: Effect.Effect<ReadonlyArray<string>>;
}

function folderNotes(input: {
  readonly folder: TempoThreadMoveFolder;
  readonly worktreePath: string;
  readonly sourceLabel: string;
}): ReadonlyArray<string> {
  const { skipped } = input.folder;
  const shown = skipped.slice(0, 3).join(", ");
  const more = skipped.length > 3 ? ` and ${skipped.length - 3} more` : "";
  return [
    input.folder.entries.length === 0
      ? `No files came along, so it starts in a new, empty folder: ${input.worktreePath}.`
      : `Its folder was copied to ${input.worktreePath}.`,
    ...(skipped.length === 0
      ? []
      : [
          `Left on ${input.sourceLabel}, since ${skipped.length === 1 ? "it" : "they"} cannot be copied: ${shown}${more}.`,
        ]),
  ];
}

export class ThreadMoveService extends Context.Service<
  ThreadMoveService,
  {
    /** Source: captures the thread and its checkout into an archive behind a signed download URL. */
    readonly prepareMove: (
      input: TempoThreadMovePrepareInput,
    ) => Effect.Effect<TempoThreadMovePrepareResult, TempoThreadMoveError>;
    /** Target: checks the repository is here, then signs a URL that admits one archive of exactly `sizeBytes`. */
    readonly createImportUpload: (
      input: TempoThreadMoveCreateImportUploadInput,
    ) => Effect.Effect<TempoThreadMoveCreateImportUploadResult, TempoThreadMoveError>;
    /** Target: recreates the thread and its checkout from the uploaded archive. Safe to repeat. */
    readonly importMove: (
      input: TempoThreadMoveImportInput,
    ) => Effect.Effect<TempoThreadMoveImportResult, TempoThreadMoveError>;
    /** Source: turns the thread into a read-only stub that links to its new home. Safe to repeat. */
    readonly finalizeMove: (
      input: TempoThreadMoveFinalizeInput,
    ) => Effect.Effect<TempoThreadMoveFinalizeResult, TempoThreadMoveError>;
    /** Source: forgets a move that did not finish. The thread is untouched. */
    readonly abortMove: (
      input: TempoThreadMoveAbortInput,
    ) => Effect.Effect<void, TempoThreadMoveError>;
    /** HTTP: the archive file a download token names, or null. */
    readonly resolveDownload: (token: string) => Effect.Effect<string | null>;
    /** HTTP: stores the one archive an upload token admits. `contentLength` is the request's header. */
    readonly receiveUpload: <E>(
      token: string,
      body: Stream.Stream<Uint8Array, E>,
      contentLength: number | null,
    ) => Effect.Effect<ThreadMoveUploadResult>;
  }
>()("t3/tempo/threadMove/ThreadMoveService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const threadLocks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const projects = yield* ProjectService.ProjectService;
  const managedFolders = yield* ManagedProjectFolders.ManagedProjectFolders;
  const repositories = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const settings = yield* ServerSettings.ServerSettingsService;
  const setupScripts = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  // The archive, git, and token helpers are plain effects; they run with the services captured here.
  const services = yield* Effect.context<
    | FileSystem.FileSystem
    | Path.Path
    | GitVcsDriver.GitVcsDriver
    | CheckpointStore.CheckpointStore
    | ServerSecretStore.ServerSecretStore
  >();
  const moveLocks = yield* KeyedLock.make<TempoThreadMoveId>();
  // Uploads being received now; a token admits one archive, not one per request.
  const uploadsInFlight = new Set<TempoThreadMoveId>();

  const movesRoot = path.join(config.stateDir, MOVES_DIRECTORY);
  const outgoingDir = (moveId: TempoThreadMoveId) => path.join(movesRoot, "outgoing", moveId);
  const incomingArchive = (moveId: TempoThreadMoveId) =>
    path.join(movesRoot, "incoming", `${moveId}.tempomove`);
  const incomingExtractDir = (moveId: TempoThreadMoveId) =>
    path.join(movesRoot, "incoming", moveId);

  const removeQuietly = (target: string) =>
    fileSystem.remove(target, { recursive: true, force: true }).pipe(Effect.ignore);

  /** Removes move files older than a day: moves whose client went away mid-way. */
  const sweepStale = Effect.gen(function* () {
    const now = yield* DateTime.now;
    for (const directory of [path.join(movesRoot, "outgoing"), path.join(movesRoot, "incoming")]) {
      const entries = yield* fileSystem
        .readDirectory(directory)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      for (const entry of entries) {
        const target = path.join(directory, entry);
        const info = yield* fileSystem.stat(target).pipe(Effect.option);
        const modified = Option.flatMap(info, (stat) => stat.mtime);
        if (
          Option.isSome(modified) &&
          DateTime.toEpochMillis(now) - modified.value.getTime() > STALE_MOVE_MS
        ) {
          yield* removeQuietly(target);
        }
      }
    }
  });

  const threadShell = (threadId: ThreadId) =>
    orchestrator.getThreadShell(threadId).pipe(
      Effect.mapError(failed("export")),
      Effect.filterOrFail(
        (shell): shell is OrchestrationV2ThreadShell => shell !== null && shell.deletedAt === null,
        () => new TempoThreadMoveThreadNotFoundError({ threadId }),
      ),
    );

  const prepareMove = Effect.fn("ThreadMoveService.prepareMove")(
    function* (input: TempoThreadMovePrepareInput) {
      yield* Effect.annotateCurrentSpan({ threadId: input.threadId });
      const shell = yield* threadShell(input.threadId);
      if (shell.movedTo != null) {
        return yield* new TempoThreadMoveAlreadyMovedError({
          threadId: input.threadId,
          environmentLabel: shell.movedTo.environmentLabel,
        });
      }
      const projection = yield* orchestrator
        .getThreadProjection(input.threadId)
        .pipe(Effect.mapError(failed("export")));
      if (projection.runs.some(isActiveRun)) {
        return yield* new TempoThreadMoveRunActiveError({ threadId: input.threadId });
      }
      const project = yield* projects.getById(projection.thread.projectId).pipe(
        Effect.mapError(failed("export")),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TempoThreadMoveThreadNotFoundError({ threadId: input.threadId })),
            onSome: Effect.succeed,
          }),
        ),
      );
      const cwd = projection.thread.worktreePath ?? project.workspaceRoot;
      const identity = yield* repositories.resolve(cwd, { refresh: true });
      // Without a remote the target has no copy of the repository to find, so the folder travels.
      if (identity === null && input.allowFolder !== true) {
        return yield* new TempoThreadMoveRepositoryRequiredError({ threadId: input.threadId });
      }

      const repository: TempoThreadMoveRepository | null =
        identity === null
          ? null
          : {
              canonicalKey: identity.canonicalKey,
              groupingKey: repositoryGroupingKeyOf(identity),
              displayName:
                repositoryGroupingDisplayNameOf(identity) ?? identity.displayName ?? null,
            };
      // A thread in the shared "No project" folder has no folder of its own to carry.
      const inSharedScratch = Option.exists(
        yield* managedFolders.scratchRoot,
        (root) => path.resolve(root) === path.resolve(cwd),
      );

      yield* sweepStale;
      const moveId = TempoThreadMoveId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie));
      const directory = outgoingDir(moveId);
      const archivePath = path.join(directory, ARCHIVE_FILE);
      const bundlePath = path.join(directory, BUNDLE_FILE);
      const result = yield* Effect.gen(function* () {
        yield* fileSystem
          .makeDirectory(directory, { recursive: true })
          .pipe(Effect.mapError(failed("archive")));
        const gitState =
          repository === null
            ? null
            : yield* captureMoveGitState({
                cwd,
                moveId,
                bundlePath,
                bundleFile: BUNDLE_FILE,
              }).pipe(
                // The bundle holds every commit the refs pointed at; the refs only had to live until then.
                Effect.ensuring(deleteMoveRefs({ cwd, moveId }).pipe(Effect.ignore)),
                Effect.mapError(failed("git")),
              );
        const folder =
          repository !== null
            ? null
            : inSharedScratch
              ? NO_FOLDER
              : yield* captureMoveFolder({
                  root: cwd,
                  maxBytes: TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES,
                }).pipe(
                  Effect.catchTags({
                    ThreadMoveFolderError: (cause) => Effect.fail(failed("archive")(cause)),
                  }),
                );

        const messages = exportMovedMessages(projection);
        const attachmentFiles = new Map<string, ArchiveInputFile>();
        for (const attachment of messages.flatMap((message) => message.attachments)) {
          if (attachmentFiles.has(attachment.id)) continue;
          const attachmentPath = resolveAttachmentPath({
            attachmentsDir: config.attachmentsDir,
            attachment,
          });
          if (attachmentPath === null) continue;
          if (!(yield* fileSystem.exists(attachmentPath).pipe(Effect.orElseSucceed(() => false)))) {
            continue;
          }
          attachmentFiles.set(attachment.id, {
            name: attachmentArchiveFileName(attachment.id),
            path: attachmentPath,
          });
        }
        const activeProviderThread = projection.providerThreads.find(
          (providerThread) =>
            providerThread.providerInstanceId === projection.thread.modelSelection.instanceId,
        );
        const manifest: Omit<TempoThreadMoveManifest, "files"> = {
          format: "tempo-thread-move",
          version: 1,
          moveId,
          createdAt: yield* DateTime.now,
          source: {
            threadId: projection.thread.id,
            projectId: projection.thread.projectId,
            cwd,
            workspaceRoot: project.workspaceRoot,
          },
          repository,
          git: gitState,
          ...(folder === null
            ? {}
            : { folder: { entries: folder.entries, skipped: folder.skipped } }),
          thread: {
            title: projection.thread.title,
            modelSelection: projection.thread.modelSelection,
            providerDriver: activeProviderThread?.driver ?? null,
            runtimeMode: projection.thread.runtimeMode,
            interactionMode: projection.thread.interactionMode,
            createdAt: projection.thread.createdAt,
            movedFrom: projection.thread.movedFrom ?? null,
            linkedPullRequest: projection.thread.linkedPullRequest ?? null,
            pullRequests: (projection.thread.pullRequests ?? []).map(
              ({ watch: _watch, ...link }) => link,
            ),
          },
          messages,
          providerRefs: projection.providerThreads.map((providerThread) => ({
            driver: providerThread.driver,
            providerInstanceId: providerThread.providerInstanceId,
            nativeId: providerThread.nativeThreadRef?.nativeId ?? null,
          })),
        };
        yield* writeArchive({
          archivePath,
          manifest,
          files: [
            ...(gitState === null || gitState.bundleFile === null
              ? []
              : [{ name: BUNDLE_FILE, path: bundlePath }]),
            ...(folder?.files ?? []),
            ...attachmentFiles.values(),
          ],
        }).pipe(Effect.mapError(failed("archive")));
        yield* removeQuietly(bundlePath);
        const record = yield* encodeRecord({
          threadId: input.threadId,
          runCount: projection.runs.length,
        }).pipe(Effect.mapError(failed("archive")));
        yield* fileSystem
          .writeFileString(path.join(directory, RECORD_FILE), record)
          .pipe(Effect.mapError(failed("archive")));
        const info = yield* fileSystem.stat(archivePath).pipe(Effect.mapError(failed("archive")));
        const sizeBytes = Number(info.size);
        if (sizeBytes > TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES) {
          return yield* new TempoThreadMoveTooLargeError({
            sizeBytes,
            maxBytes: TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES,
            ...(folder === null ? {} : { maxFolderEntries: MAX_FOLDER_ENTRIES }),
          });
        }
        const expiresAt = yield* transferExpiry;
        const downloadRelativeUrl = yield* issueTransferUrl({
          version: 1,
          kind: "download",
          moveId,
          expiresAt,
        }).pipe(Effect.mapError(failed("archive")));
        return {
          moveId,
          downloadRelativeUrl,
          sizeBytes,
          expiresAt,
          messageCount: messages.length,
          hasUncommittedChanges: gitState !== null && gitState.wipCommit !== null,
          branch: gitState?.branch ?? null,
          repository,
        } satisfies TempoThreadMovePrepareResult;
      }).pipe(Effect.onError(() => removeQuietly(directory)));
      return result;
    },
    Effect.provide(services),
    logFailure,
  );

  /** The project here that holds the archive's repository: same remote first, then same fork group. */
  const findProject = Effect.fn("ThreadMoveService.findProject")(function* (
    repository: TempoThreadMoveRepository,
  ) {
    const shells = yield* projects.listShells().pipe(Effect.mapError(failed("import")));
    const candidates: Array<{
      readonly id: (typeof shells)[number]["id"];
      readonly workspaceRoot: string;
      readonly identity: RepositoryIdentity;
    }> = [];
    for (const shell of shells) {
      const identity =
        shell.repositoryIdentity ?? (yield* repositories.resolve(shell.workspaceRoot));
      if (identity !== null) {
        candidates.push({ id: shell.id, workspaceRoot: shell.workspaceRoot, identity });
      }
    }
    const match =
      candidates.find((candidate) => candidate.identity.canonicalKey === repository.canonicalKey) ??
      candidates.find(
        (candidate) => repositoryGroupingKeyOf(candidate.identity) === repository.groupingKey,
      );
    if (match === undefined) {
      return yield* new TempoThreadMoveProjectNotFoundError({
        repository: repository.displayName ?? repository.canonicalKey,
      });
    }
    return match;
  });

  const createImportUpload = Effect.fn("ThreadMoveService.createImportUpload")(
    function* (input: TempoThreadMoveCreateImportUploadInput) {
      // The most common refusals, found before the source's archive travels anywhere.
      if (input.repository !== null) {
        yield* findProject(input.repository);
      } else if (Option.isNone(yield* managedFolders.scratchRoot)) {
        return yield* new TempoThreadMoveFolderUnavailableError();
      }
      yield* sweepStale;
      const expiresAt = yield* transferExpiry;
      const uploadRelativeUrl = yield* issueTransferUrl({
        version: 1,
        kind: "upload",
        moveId: input.moveId,
        sizeBytes: input.sizeBytes,
        expiresAt,
      }).pipe(Effect.mapError(failed("archive")));
      return { uploadRelativeUrl, expiresAt } satisfies TempoThreadMoveCreateImportUploadResult;
    },
    Effect.provide(services),
    logFailure,
  );

  const resolveDownload = Effect.fn("ThreadMoveService.resolveDownload")(function* (token: string) {
    const claims = yield* validateTransferToken(token, "download");
    if (claims === null || claims.kind !== "download") return null;
    const archivePath = path.join(outgoingDir(claims.moveId), ARCHIVE_FILE);
    return (yield* fileSystem.exists(archivePath).pipe(Effect.orElseSucceed(() => false)))
      ? archivePath
      : null;
  }, Effect.provide(services));

  const receiveUpload = Effect.fn("ThreadMoveService.receiveUpload")(function* <E>(
    token: string,
    body: Stream.Stream<Uint8Array, E>,
    contentLength: number | null,
  ) {
    const claims = yield* validateTransferToken(token, "upload");
    if (claims === null || claims.kind !== "upload") {
      return { ok: false, status: 404, detail: "Not Found" } satisfies ThreadMoveUploadResult;
    }
    if (contentLength !== null && contentLength !== claims.sizeBytes) {
      return {
        ok: false,
        status: 400,
        detail: "Content-Length must match the upload size.",
      } satisfies ThreadMoveUploadResult;
    }
    const finalPath = incomingArchive(claims.moveId);
    const conflict = {
      ok: false,
      status: 409,
      detail: "This move already has its archive.",
    } satisfies ThreadMoveUploadResult;
    // One archive per move: not while another upload runs, and not once one arrived or imported.
    if (uploadsInFlight.has(claims.moveId)) return conflict;
    uploadsInFlight.add(claims.moveId);
    return yield* Effect.gen(function* () {
      const arrived = yield* fileSystem.exists(finalPath).pipe(Effect.orElseSucceed(() => false));
      const imported = yield* orchestrator
        .getThreadShell(movedThreadId(claims.moveId))
        .pipe(Effect.orElseSucceed(() => null));
      if (arrived || imported !== null) return conflict;
      const partPath = `${finalPath}.${yield* crypto.randomUUIDv4().pipe(Effect.orDie)}.part`;
      let receivedBytes = 0;
      const stored = yield* Effect.gen(function* () {
        yield* fileSystem.makeDirectory(path.dirname(finalPath), { recursive: true });
        yield* Stream.run(
          body.pipe(
            Stream.takeWhile((chunk) => {
              receivedBytes += chunk.byteLength;
              return receivedBytes <= claims.sizeBytes;
            }),
          ),
          fileSystem.sink(partPath),
        );
        if (receivedBytes !== claims.sizeBytes) {
          return {
            ok: false,
            status: 400,
            detail: `Expected ${claims.sizeBytes} bytes.`,
          } satisfies ThreadMoveUploadResult;
        }
        yield* fileSystem.rename(partPath, finalPath);
        return { ok: true } satisfies ThreadMoveUploadResult;
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Failed to store a thread move upload.", { cause }).pipe(
            Effect.as({
              ok: false,
              status: 500,
              detail: "The upload could not be stored.",
            } satisfies ThreadMoveUploadResult),
          ),
        ),
        // A short, failed, or interrupted upload leaves no part file behind.
        Effect.onExit((exit) =>
          exit._tag === "Success" && exit.value.ok ? Effect.void : removeQuietly(partPath),
        ),
      );
      return stored;
    }).pipe(Effect.ensuring(Effect.sync(() => uploadsInFlight.delete(claims.moveId))));
  }, Effect.provide(services));

  /**
   * The stub this thread left here when it moved away, when the archive brings
   * it home: the stub's checkout can take the thread back.
   */
  const homeStub = Effect.fn("ThreadMoveService.homeStub")(function* (
    manifest: TempoThreadMoveManifest,
  ) {
    const hop = manifest.thread.movedFrom;
    if (hop === null || hop.departure === undefined) return null;
    const departure = hop.departure;
    const stub = yield* orchestrator
      .getThreadShell(hop.threadId)
      .pipe(Effect.orElseSucceed(() => null));
    if (stub === null || stub.deletedAt !== null || stub.movedTo?.moveId !== hop.moveId) {
      return null;
    }
    const project = yield* projects.getById(stub.projectId).pipe(
      Effect.map(Option.getOrNull),
      Effect.orElseSucceed(() => null),
    );
    return project === null ? null : { stub, project, departure };
  });

  /** Starts the project's worktree setup script in the moved checkout; returns a note for the user. */
  const runSetupScript = (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly workspaceRoot: string;
    readonly worktreePath: string;
  }) =>
    setupScripts
      .runForThread({
        threadId: input.threadId,
        projectId: input.projectId,
        projectCwd: input.workspaceRoot,
        worktreePath: input.worktreePath,
      })
      .pipe(
        Effect.map((setup): ReadonlyArray<string> =>
          setup.status === "started"
            ? [`Running the project's setup script (${setup.scriptName}) in a terminal.`]
            : [],
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning("A moved thread's setup script did not start.", { cause }).pipe(
            Effect.as(["The project's setup script did not start. Run it before continuing."]),
          ),
        ),
      );

  /** Brings a Git thread's work into its repository's project here, or home to the checkout it left. */
  const placeCheckout = Effect.fn("ThreadMoveService.placeCheckout")(function* (
    move: TempoThreadMoveImportInput,
    manifest: TempoThreadMoveManifest,
    files: ReadonlyMap<string, string>,
  ) {
    const { repository, git } = manifest;
    if (repository === null || git === null) {
      return yield* new TempoThreadMoveFailedError({ stage: "archive" });
    }
    const home = yield* homeStub(manifest);
    const project =
      home === null
        ? yield* findProject(repository)
        : { id: home.project.id, workspaceRoot: home.project.workspaceRoot };
    const worktreesDirectory = yield* settings.getSettings.pipe(
      Effect.map((current) => current.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const restored = yield* restoreMoveGitState({
      repoCwd: project.workspaceRoot,
      moveId: move.moveId,
      git,
      bundlePath: git.bundleFile === null ? null : (files.get(git.bundleFile) ?? null),
      worktreesDirectory,
      home:
        home === null
          ? null
          : {
              checkout: home.stub.worktreePath ?? home.project.workspaceRoot,
              branch: home.stub.branch,
              departure: home.departure,
            },
    }).pipe(Effect.catchTags({ ThreadMoveGitError: (cause) => Effect.fail(failed("git")(cause)) }));
    return {
      projectId: project.id,
      branch: restored.branch,
      worktreePath: restored.worktreePath,
      // A thread that comes home to the project's own checkout runs there, as it did before.
      threadWorktreePath:
        restored.reused && home?.stub.worktreePath == null ? null : restored.worktreePath,
      // What the source checkout looked like, so moving back can reuse it.
      departure: {
        headCommit: git.headCommit,
        wipTree: git.wipCommit === null ? null : (git.wipTree ?? null),
      },
      pathMappings: [
        { from: manifest.source.cwd, to: restored.worktreePath },
        ...(manifest.source.workspaceRoot === manifest.source.cwd
          ? []
          : [{ from: manifest.source.workspaceRoot, to: project.workspaceRoot }]),
      ],
      notes: restored.reused
        ? [`It is back in its original checkout on ${restored.branch}.`]
        : git.branch !== null && git.branch !== restored.branch
          ? [`${git.branch} was taken here, so the work is on ${restored.branch}.`]
          : [],
      undo: restored.undo,
      // A checkout the thread comes home to is already set up.
      setUp: restored.reused
        ? Effect.succeed([])
        : runSetupScript({
            threadId: movedThreadId(move.moveId),
            projectId: project.id,
            workspaceRoot: project.workspaceRoot,
            worktreePath: restored.worktreePath,
          }),
    } satisfies MovedPlacement;
  }, Effect.provide(services));

  /** Unpacks a moved folder into a new folder for threads without a project, as a new thread gets. */
  const placeFolder = Effect.fn("ThreadMoveService.placeFolder")(function* (
    move: TempoThreadMoveImportInput,
    manifest: TempoThreadMoveManifest,
    folder: TempoThreadMoveFolder,
    files: ReadonlyMap<string, string>,
  ) {
    const scratch = yield* managedFolders.ensureScratchProject.pipe(
      Effect.catchTags({
        ScratchUnavailableError: () => Effect.fail(new TempoThreadMoveFolderUnavailableError()),
        ScratchFolderError: (cause) => Effect.fail(failed("import")(cause)),
        ScratchProjectError: (cause) => Effect.fail(failed("import")(cause)),
      }),
    );
    // The folder's undo is armed as soon as it exists, with no gap an interruption can land in.
    return yield* Effect.uninterruptibleMask((interruptible) =>
      Effect.gen(function* () {
        const claimed = yield* interruptible(
          managedFolders.folderForThread({
            projectId: scratch.projectId,
            threadId: movedThreadId(move.moveId),
            text: manifest.thread.title,
          }),
        ).pipe(
          Effect.catchTags({ ScratchFolderError: (cause) => Effect.fail(failed("import")(cause)) }),
        );
        if (Option.isNone(claimed)) return yield* new TempoThreadMoveFolderUnavailableError();
        const worktreePath = claimed.value;
        const undo = removeQuietly(worktreePath);
        yield* interruptible(
          restoreMoveFolder({ folder: worktreePath, entries: folder.entries, files }),
        ).pipe(
          Effect.catchTags({
            ThreadMoveFolderError: (cause) => Effect.fail(failed("archive")(cause)),
          }),
          Effect.onError(() => undo),
        );
        return {
          projectId: scratch.projectId,
          branch: null,
          worktreePath,
          threadWorktreePath: worktreePath,
          // Moving back copies the folder again rather than reuse the one it left.
          departure: undefined,
          pathMappings: [{ from: manifest.source.cwd, to: worktreePath }],
          notes: folderNotes({ folder, worktreePath, sourceLabel: move.source.environmentLabel }),
          undo,
          setUp: Effect.succeed([]),
        } satisfies MovedPlacement;
      }),
    );
  }, Effect.provide(services));

  /** The events that create the moved thread, and notes about what it could not carry. */
  const buildThread = Effect.fn("ThreadMoveService.buildThread")(function* (
    move: TempoThreadMoveImportInput,
    manifest: TempoThreadMoveManifest,
    files: ReadonlyMap<string, string>,
    placement: MovedPlacement,
  ) {
    const threadId = movedThreadId(move.moveId);
    // The archive's attachments, under ids that belong to the moved thread.
    const attachmentIds = yield* copyMovedAttachments({
      threadId,
      messages: manifest.messages,
      attachmentsDir: config.attachmentsDir,
      sourcePath: (attachment) => files.get(attachmentArchiveFileName(attachment.id)) ?? null,
    }).pipe(Effect.mapError(failed("import")));
    const instances = yield* providerInstances.listInstances;
    const model = resolveMovedModelSelection({
      modelSelection: manifest.thread.modelSelection,
      providerDriver: manifest.thread.providerDriver,
      instances,
    });
    const now = yield* DateTime.now;
    const movedFrom: TempoThreadMoveLink = {
      moveId: move.moveId,
      environmentId: move.source.environmentId,
      environmentLabel: move.source.environmentLabel,
      threadId: manifest.source.threadId,
      movedAt: DateTime.formatIso(now),
      ...(placement.departure === undefined ? {} : { departure: placement.departure }),
    };
    const events = buildMovedThreadEvents({
      eventPrefix: `tempo-move:${manifest.moveId}`,
      thread: { ...manifest.thread, modelSelection: model.modelSelection },
      messages: manifest.messages,
      threadId,
      projectId: placement.projectId,
      branch: placement.branch,
      worktreePath: placement.threadWorktreePath,
      movedFrom,
      now,
      pathMappings: placement.pathMappings,
      attachmentIds,
    });
    const attachmentCount = new Set(
      manifest.messages.flatMap((message) => message.attachments.map(({ id }) => id)),
    ).size;
    const notes: ReadonlyArray<string> = [
      "Tool activity and checkpoints stay with the original thread.",
      ...placement.notes,
      ...(attachmentIds.size < attachmentCount ? ["Some attachments could not be carried."] : []),
      ...(model.available
        ? []
        : ["This machine does not have the thread's provider. Pick a model before continuing."]),
    ];
    return { events, notes };
  });

  const importMoveUnlocked = Effect.fn("ThreadMoveService.importMove")(
    function* (input: TempoThreadMoveImportInput) {
      yield* Effect.annotateCurrentSpan({ moveId: input.moveId });
      const threadId = movedThreadId(input.moveId);
      const existing = yield* orchestrator
        .getThreadShell(threadId)
        .pipe(Effect.mapError(failed("import")));
      // The thread and its history land in one write, so an existing thread is a finished import.
      if (existing !== null && existing.deletedAt === null) {
        const project = yield* projects
          .getById(existing.projectId)
          .pipe(Effect.map(Option.getOrNull), Effect.mapError(failed("import")));
        const worktreePath = existing.worktreePath ?? project?.workspaceRoot ?? null;
        if (worktreePath !== null) {
          return {
            threadId,
            projectId: existing.projectId,
            branch: existing.branch,
            worktreePath,
            notes: [],
          } satisfies TempoThreadMoveImportResult;
        }
      }
      const archivePath = incomingArchive(input.moveId);
      if (!(yield* fileSystem.exists(archivePath).pipe(Effect.orElseSucceed(() => false)))) {
        return yield* new TempoThreadMoveArchiveNotFoundError({ moveId: input.moveId });
      }
      const extractDir = incomingExtractDir(input.moveId);
      return yield* Effect.gen(function* () {
        const { manifest, files } = yield* extractArchive({ archivePath, extractDir }).pipe(
          Effect.mapError(failed("archive")),
        );
        if (manifest.moveId !== input.moveId) {
          return yield* new TempoThreadMoveArchiveNotFoundError({ moveId: input.moveId });
        }
        const place: Effect.Effect<MovedPlacement, TempoThreadMoveError> =
          manifest.folder === undefined
            ? placeCheckout(input, manifest, files)
            : placeFolder(input, manifest, manifest.folder, files);
        // Nothing a failed or interrupted import created stays behind for a retry to
        // duplicate: the files' undo is armed the moment they are placed, and once the
        // thread is being written, it is written whole and kept.
        const { placement, notes } = yield* Effect.uninterruptibleMask((interruptible) =>
          Effect.gen(function* () {
            const placement = yield* interruptible(place);
            const thread = yield* interruptible(
              buildThread(input, manifest, files, placement),
            ).pipe(
              Effect.tap(({ events }) =>
                eventSink.write({ events }).pipe(Effect.mapError(failed("import"))),
              ),
              Effect.onError(() => placement.undo),
            );
            return { placement, notes: thread.notes };
          }),
        );
        const setupNotes = yield* placement.setUp;
        return {
          threadId,
          projectId: placement.projectId,
          branch: placement.branch,
          worktreePath: placement.worktreePath,
          notes: [...notes, ...setupNotes],
        } satisfies TempoThreadMoveImportResult;
      }).pipe(
        // The client starts a fresh move after any failure, so the upload is never needed twice.
        Effect.ensuring(Effect.all([removeQuietly(extractDir), removeQuietly(archivePath)])),
      );
    },
    Effect.provide(services),
    logFailure,
  );

  const importMove = (input: TempoThreadMoveImportInput) =>
    moveLocks.withLock(input.moveId, importMoveUnlocked(input));

  const readRecord = (moveId: TempoThreadMoveId) =>
    fileSystem
      .readFileString(path.join(outgoingDir(moveId), RECORD_FILE))
      .pipe(Effect.flatMap(decodeRecord), Effect.option);

  /** Disables the enabled scheduled tasks bound to a thread; returns how many it paused. */
  const pauseScheduledTasks = Effect.fn("ThreadMoveService.pauseScheduledTasks")(
    function* (threadId: ThreadId) {
      const { tasks } = yield* scheduledTasks.list();
      let paused = 0;
      for (const task of tasks) {
        if (!task.enabled || task.threadId !== threadId) continue;
        const result = yield* scheduledTasks
          .setEnabled({ id: task.id, enabled: false })
          .pipe(Effect.option);
        if (Option.isSome(result)) paused += 1;
      }
      return paused;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not pause a moved thread's scheduled tasks.", { cause }).pipe(
        Effect.as(0),
      ),
    ),
  );

  const finalizeMove = Effect.fn("ThreadMoveService.finalizeMove")(function* (
    input: TempoThreadMoveFinalizeInput,
  ) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId, moveId: input.moveId });
    yield* threadShell(input.threadId);
    yield* threadLocks.withLock(
      input.threadId,
      Effect.gen(function* () {
        const records = yield* orchestrator
          .getThreadRecords(input.threadId, ["runs"])
          .pipe(Effect.mapError(failed("finalize")));
        const thread = records.thread;
        if (thread.movedTo != null) {
          if (thread.movedTo.moveId === input.moveId) return;
          return yield* new TempoThreadMoveAlreadyMovedError({
            threadId: input.threadId,
            environmentLabel: thread.movedTo.environmentLabel,
          });
        }
        const record = yield* readRecord(input.moveId);
        if (Option.isNone(record) || record.value.threadId !== input.threadId) {
          return yield* new TempoThreadMoveArchiveNotFoundError({ moveId: input.moveId });
        }
        if (records.runs.some(isActiveRun) || records.runs.length !== record.value.runCount) {
          return yield* new TempoThreadMoveThreadChangedError({ threadId: input.threadId });
        }
        const now = yield* DateTime.now;
        const movedTo: TempoThreadMoveLink = {
          moveId: input.moveId,
          environmentId: input.target.environmentId,
          environmentLabel: input.target.environmentLabel,
          threadId: input.target.threadId,
          movedAt: DateTime.formatIso(now),
        };
        yield* eventSink
          .write({
            events: [
              {
                id: EventId.make(`tempo-move:${input.moveId}:moved-away`),
                type: "thread.metadata-updated",
                threadId: input.threadId,
                occurredAt: now,
                payload: movedAwayThread(thread, movedTo, now),
              },
            ],
          })
          .pipe(Effect.mapError(failed("finalize")));
      }),
    );
    yield* removeQuietly(outgoingDir(input.moveId));
    // A stub takes no new turns, so tasks that post into it would fail on every run.
    const pausedScheduledTasks = yield* pauseScheduledTasks(input.threadId);
    return { pausedScheduledTasks } satisfies TempoThreadMoveFinalizeResult;
  }, logFailure);

  const abortMove = Effect.fn("ThreadMoveService.abortMove")(function* (
    input: TempoThreadMoveAbortInput,
  ) {
    const record = yield* readRecord(input.moveId);
    if (Option.isSome(record) && record.value.threadId !== input.threadId) {
      return yield* new TempoThreadMoveArchiveNotFoundError({ moveId: input.moveId });
    }
    yield* removeQuietly(outgoingDir(input.moveId));
  });

  return ThreadMoveService.of({
    prepareMove,
    createImportUpload,
    importMove,
    finalizeMove,
    abortMove,
    resolveDownload,
    receiveUpload,
  });
});

export const layer = Layer.effect(ThreadMoveService, make);
