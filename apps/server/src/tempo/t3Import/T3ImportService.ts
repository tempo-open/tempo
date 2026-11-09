/**
 * Copies this machine's T3 Code threads (`~/.t3`) into Tempo. It opens T3 Code's database read-only,
 * reads it with Tempo's own projection reads, and writes each thread as a thread move does: history
 * without runs, under an id derived from T3 Code's so a second run finds it. Settings, credentials
 * and other T3 Code state stay where they are.
 */
import {
  CommandId,
  TempoT3ImportFailedError,
  TempoT3ImportIncompatibleError,
  TempoT3ImportNotFoundError,
  TempoT3ImportOwnDataError,
  TempoT3ImportReadError,
  TempoT3ImportSkipReason,
  TempoThreadMoveId,
  EnvironmentId,
  OrchestrationV2AppThreadJson,
  ProjectId,
  ThreadId,
  type TempoT3ImportError,
  type TempoT3ImportIncompatibility,
  type TempoT3ImportInput,
  type TempoT3ImportRunProject,
  type TempoT3ImportRunResult,
  type TempoT3ImportScanResult,
  type TempoT3ImportSkipped,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME, T3_HOME_DIR_NAME } from "@t3tools/shared/tempoBrand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { isActiveRun } from "../../orchestration-v2/ThreadManagementService.ts";
import { expandHomePath } from "../../os-jank.ts";
import { migrationManifest } from "../../persistence/Migrations.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import { isProcessAlive, readPersistedServerRuntimeState } from "../../serverRuntimeState.ts";
import {
  buildMovedThreadEvents,
  copyMovedAttachments,
  exportMovedMessages,
  movedThreadId,
  resolveMovedModelSelection,
} from "../threadMove/ThreadMoveThread.ts";

/** How imported threads name where they came from. */
const T3_ENVIRONMENT_LABEL = "T3 Code";
/** The migration that created the orchestration tables the import reads. */
const ORCHESTRATION_V2_MIGRATION = { id: 55, name: "OrchestrationV2" } as const;
/** A write-ahead log this fresh means T3 Code is writing to its database. */
const RECENT_WRITE_MS = 60_000;
/** The work T3 Code resumes by itself; a thread with any of it is still changing. */
const LIVE_KINDS: ReadonlyArray<ProjectionStore.ProjectionRecoveryKind> = [
  "queued-runs",
  "runtime",
  "subagent-results",
  "delegated-completions",
];

const decodeThread = Schema.decodeUnknownEffect(
  Schema.fromJsonString(OrchestrationV2AppThreadJson),
);
const isThreadNotFound = Schema.is(ProjectionStore.ProjectionStoreThreadNotFoundError);

interface T3Location {
  readonly home: string;
  readonly dbPath: string;
  readonly attachmentsDir: string;
  readonly environmentIdPath: string;
  readonly serverRuntimeStatePath: string;
}

/** T3 Code's database, opened read-only, with Tempo's projection reads over it. */
interface T3Database {
  readonly sql: SqlClient.SqlClient;
  readonly projections: ProjectionStore.ProjectionStoreV2["Service"];
}

/** Where a T3 Code project's threads go here. */
type ProjectTarget =
  | {
      readonly kind: "existing";
      readonly project: { readonly id: ProjectId; readonly title: string };
    }
  | { readonly kind: "create"; readonly projectId: ProjectId }
  | { readonly kind: "unavailable"; readonly reason: "folderMissing" | "projectRemoved" };

interface ThreadToImport {
  readonly t3ThreadId: ThreadId;
  readonly moveId: TempoThreadMoveId;
}

/** One T3 Code project with every one of its threads sorted into a count. */
interface ProjectPlan {
  readonly t3ProjectId: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
  readonly target: ProjectTarget;
  readonly toImport: ReadonlyArray<ThreadToImport>;
  readonly alreadyImported: number;
  readonly skipped: ReadonlyMap<TempoT3ImportSkipReason, number>;
}

/** The provider instances an imported thread's model is resolved against. */
type ProviderInstances = Parameters<typeof resolveMovedModelSelection>[0]["instances"];

type ThreadOutcome =
  | { readonly imported: true; readonly missingAttachments: number; readonly needsModel: boolean }
  | { readonly imported: false; readonly reason: TempoT3ImportSkipReason };

/**
 * Whether T3 Code shows the thread as done: archived, or settled and not
 * waiting on a snooze. Its sidebar lists a snoozed thread under Snoozed until
 * the wake time even when it is settled underneath, so that one is current work.
 */
function isSettledInT3(
  thread: Pick<OrchestrationV2AppThread, "archivedAt" | "settledOverride" | "snoozedUntil">,
  nowMs: number,
): boolean {
  if (thread.archivedAt !== null) return true;
  if (thread.settledOverride !== "settled") return false;
  return thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs;
}

function countSkip(
  skipped: Map<TempoT3ImportSkipReason, number>,
  reason: TempoT3ImportSkipReason,
  count = 1,
) {
  skipped.set(reason, (skipped.get(reason) ?? 0) + count);
}

function skippedList(
  skipped: ReadonlyMap<TempoT3ImportSkipReason, number>,
): ReadonlyArray<TempoT3ImportSkipped> {
  return TempoT3ImportSkipReason.literals.flatMap((reason) => {
    const count = skipped.get(reason) ?? 0;
    return count === 0 ? [] : [{ reason, count }];
  });
}

/**
 * Runs `effect`; a failure is logged with its full cause and becomes
 * `fallback`, so one thread or project cannot stop the rest. Interruption
 * still interrupts.
 */
function recover<A, B, E, R>(
  effect: Effect.Effect<A, E, R>,
  fallback: B,
  message: string,
  annotations: Readonly<Record<string, unknown>>,
): Effect.Effect<A | B, never, R> {
  return effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(message, { ...annotations, cause: Cause.pretty(cause) }).pipe(
            Effect.as(fallback),
          ),
    ),
  );
}

const failed = (cause: unknown) => new TempoT3ImportFailedError({ cause });

export class T3ImportService extends Context.Service<
  T3ImportService,
  {
    /** What an import of this machine's T3 Code would bring. Reads T3 Code; changes nothing. */
    readonly scan: (
      input: TempoT3ImportInput,
    ) => Effect.Effect<TempoT3ImportScanResult, TempoT3ImportError>;
    /** Copies the threads `scan` counts as to import. Safe to repeat; one run at a time. */
    readonly run: (
      input: TempoT3ImportInput,
    ) => Effect.Effect<TempoT3ImportRunResult, TempoT3ImportError>;
  }
>()("t3/tempo/t3Import/T3ImportService") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const projects = yield* ProjectService.ProjectService;
  const providerInstances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  // The path and attachment helpers are plain effects; they run with the services captured here.
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  const runLock = yield* Semaphore.make(1);

  /** A short, stable token for a T3 Code id, safe inside ids here whatever the id holds. */
  const token = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((digest) => Hex.encode(digest).slice(0, 32)),
      Effect.mapError(failed),
    );
  /** The move id an imported thread records; its thread id here is `movedThreadId(moveId)`. */
  const importMoveId = (t3ThreadId: ThreadId) =>
    token(t3ThreadId).pipe(Effect.map((hash) => TempoThreadMoveId.make(`t3-${hash}`)));
  /** The project an import creates for a T3 Code project, so a retry finds it. */
  const importedProjectId = (t3ProjectId: ProjectId) =>
    token(t3ProjectId).pipe(Effect.map((hash) => ProjectId.make(`t3-${hash}`)));

  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const sizeOf = (target: string) =>
    fileSystem.stat(target).pipe(
      Effect.map((info) => Number(info.size)),
      Effect.orElseSucceed(() => 0),
    );
  const realPathOf = (target: string) =>
    fileSystem.realPath(target).pipe(Effect.orElseSucceed(() => path.resolve(target)));

  /** T3 Code's files: `~/.t3` unless the input names another home. Never T3CODE_HOME, which is Tempo's. */
  const locate = Effect.fn("T3ImportService.locate")(function* (input: TempoT3ImportInput) {
    const home =
      input.t3Home === undefined
        ? path.join(yield* HostProcess.HomeDirectory, T3_HOME_DIR_NAME)
        : path.resolve(yield* expandHomePath(input.t3Home));
    const paths = yield* ServerConfig.deriveServerPaths(home, undefined);
    if ((yield* realPathOf(paths.stateDir)) === (yield* realPathOf(config.stateDir))) {
      return yield* new TempoT3ImportOwnDataError({ t3Home: home });
    }
    return {
      home,
      dbPath: paths.dbPath,
      attachmentsDir: paths.attachmentsDir,
      environmentIdPath: paths.environmentIdPath,
      serverRuntimeStatePath: paths.serverRuntimeStatePath,
    } satisfies T3Location;
  });

  const readFailed = (location: T3Location) => (cause: unknown) =>
    new TempoT3ImportReadError({ t3Home: location.home, cause });

  /**
   * Whether T3 Code is running: its server's recorded process is alive, or its
   * write-ahead log took a write in the last minute. A read-only reader such as
   * this import leaves an empty log behind, which does not count.
   */
  const looksRunning = Effect.fn("T3ImportService.looksRunning")(function* (location: T3Location) {
    const runtime = yield* readPersistedServerRuntimeState(location.serverRuntimeStatePath).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isSome(runtime) && isProcessAlive(runtime.value.pid)) return true;
    const log = yield* fileSystem.stat(`${location.dbPath}-wal`).pipe(Effect.option);
    if (Option.isNone(log) || Number(log.value.size) === 0) return false;
    const modified = Option.getOrUndefined(log.value.mtime);
    const now = yield* Clock.currentTimeMillis;
    return modified !== undefined && now - modified.getTime() < RECENT_WRITE_MS;
  });

  /**
   * Opens T3 Code's database read-only for the current scope. No pragma that
   * writes and no migrations: the file stays exactly as T3 Code left it.
   */
  const openT3 = (location: T3Location) =>
    Layer.build(
      // Fresh, or the build reuses the server's memoized ProjectionStore, which reads Tempo's database.
      Layer.fresh(
        ProjectionStore.layer.pipe(
          Layer.provideMerge(NodeSqliteClient.layer({ filename: location.dbPath, readonly: true })),
        ),
      ),
    ).pipe(
      Effect.map((context): T3Database => ({
        sql: Context.get(context, SqlClient.SqlClient),
        projections: Context.get(context, ProjectionStore.ProjectionStoreV2),
      })),
      // Waits out a write T3 Code has in flight instead of failing; it changes nothing on disk.
      Effect.tap((database) => database.sql`PRAGMA busy_timeout = 5000`),
      Effect.mapError(readFailed(location)),
    );

  /** Null when Tempo can read the database with its own projection code; otherwise why not. */
  const checkCompatibility = Effect.fn("T3ImportService.checkCompatibility")(function* (
    database: T3Database,
  ) {
    const tables = yield* database.sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table'
          AND name IN ('effect_sql_migrations', 'orchestration_v2_projection_metadata')
      `;
    if (tables.length < 2) return "tooOld" satisfies TempoT3ImportIncompatibility;
    const applied = yield* database.sql<{
      readonly migration_id: number;
      readonly name: string;
    }>`SELECT migration_id, name FROM effect_sql_migrations`;
    const hasOrchestrationV2 = applied.some(
      (row) =>
        Number(row.migration_id) === ORCHESTRATION_V2_MIGRATION.id &&
        row.name === ORCHESTRATION_V2_MIGRATION.name,
    );
    if (!hasOrchestrationV2) return "tooOld" satisfies TempoT3ImportIncompatibility;
    // A migration this build does not know may have changed what the rows hold.
    const known = new Map<number, string>(migrationManifest);
    if (applied.some((row) => known.get(Number(row.migration_id)) !== row.name)) {
      return "tooNew" satisfies TempoT3ImportIncompatibility;
    }
    const metadata = yield* database.sql<{ readonly schema_version: number }>`
        SELECT schema_version FROM orchestration_v2_projection_metadata
        WHERE projection_name = 'thread-projections'
      `;
    const version = Number(metadata[0]?.schema_version ?? 0);
    if (version > ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION) {
      return "tooNew" satisfies TempoT3ImportIncompatibility;
    }
    if (version < ProjectionStore.ORCHESTRATION_V2_PROJECTION_SCHEMA_VERSION) {
      // The version rises with T3 Code's first thread write; before that there is nothing to read.
      const threads = yield* database.sql<{ readonly present: number }>`
          SELECT EXISTS (SELECT 1 FROM orchestration_v2_projection_threads) AS present
        `;
      if (threads[0]?.present === 1) return "tooOld" satisfies TempoT3ImportIncompatibility;
    }
    return null;
  });

  /** Opens T3 Code's database and checks it, for the scope of `use`. */
  const withT3Database = Effect.fn("T3ImportService.withT3Database")(function* <A, E, R>(
    location: T3Location,
    use: (
      database: T3Database,
      incompatibility: TempoT3ImportIncompatibility | null,
    ) => Effect.Effect<A, E, R>,
  ) {
    const database = yield* openT3(location);
    const incompatibility = yield* checkCompatibility(database).pipe(
      Effect.mapError(readFailed(location)),
    );
    return yield* use(database, incompatibility);
  }, Effect.scoped);

  /**
   * Whether Tempo has this thread: imported before, or the very same thread. A
   * deleted thread counts, so a thread the user deleted here stays deleted.
   * Untraced: classify asks it for every thread in T3 Code's database.
   */
  const alreadyHere = Effect.fnUntraced(function* (thread: ThreadToImport) {
    for (const threadId of [movedThreadId(thread.moveId), thread.t3ThreadId]) {
      // The thread row alone, which a deleted thread keeps.
      const present = yield* orchestrator.getThreadRecords(threadId, []).pipe(
        Effect.as(true),
        Effect.catchTags({
          OrchestratorProjectionError: (error) =>
            isThreadNotFound(error.cause) ? Effect.succeed(false) : Effect.fail(error),
        }),
        Effect.mapError(failed),
      );
      if (present) return true;
    }
    return false;
  });

  /**
   * The Tempo project for a T3 Code project's folder: the active one there, else
   * the one an earlier import created, else one to create. A folder that is
   * gone, or a project the user removed after an import made it, keeps the
   * threads in T3 Code.
   */
  const resolveTarget = Effect.fn("T3ImportService.resolveTarget")(function* (project: {
    readonly t3ProjectId: ProjectId;
    readonly workspaceRoot: string;
  }) {
    const folder = yield* fileSystem.stat(project.workspaceRoot).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    );
    if (!folder) return { kind: "unavailable", reason: "folderMissing" } satisfies ProjectTarget;
    const atFolder = yield* projects
      .getByWorkspaceRoot(project.workspaceRoot)
      .pipe(Effect.mapError(failed));
    if (Option.isSome(atFolder)) {
      return { kind: "existing", project: atFolder.value } satisfies ProjectTarget;
    }
    const projectId = yield* importedProjectId(project.t3ProjectId);
    const earlier = yield* projects
      .getById(projectId, { includeDeleted: true })
      .pipe(Effect.mapError(failed));
    if (Option.isNone(earlier)) return { kind: "create", projectId } satisfies ProjectTarget;
    return earlier.value.deletedAt === null
      ? ({ kind: "existing", project: earlier.value } satisfies ProjectTarget)
      : ({ kind: "unavailable", reason: "projectRemoved" } satisfies ProjectTarget);
  });

  /**
   * Sorts every visible T3 Code thread (roots and forks; subagents belong to their parent's work)
   * into its project's counts; settled and archived ones need `includeSettled`. One short read, no
   * transcripts. Only a running T3 Code has live threads: when it is closed, its sessions and
   * unfinished items wait for it to start again, so they hold nothing back.
   */
  const classify = Effect.fn("T3ImportService.classify")(function* (
    location: T3Location,
    database: T3Database,
    includeSettled: boolean,
    t3Running: boolean,
  ) {
    const { projectRows, threadRows, pendingRows } = yield* database.sql
      .withTransaction(
        Effect.all({
          projectRows: database.sql<{
            readonly project_id: string;
            readonly title: string;
            readonly workspace_root: string;
          }>`
            SELECT project_id, title, workspace_root FROM projection_projects
            WHERE deleted_at IS NULL
            ORDER BY created_at ASC, project_id ASC
          `,
          threadRows: database.sql<{
            readonly thread_id: string;
            readonly project_id: string;
            readonly payload_json: string;
          }>`
            SELECT thread_id, project_id, payload_json FROM orchestration_v2_projection_threads
            WHERE deleted_at IS NULL
            ORDER BY created_at ASC, thread_id ASC
          `,
          // Threads from before T3 Code's database update whose history it has not loaded yet.
          pendingRows: database.sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_legacy_imports
            WHERE transcript_imported_at IS NULL
          `,
        }),
      )
      .pipe(Effect.mapError(readFailed(location)));
    const liveIds = t3Running
      ? yield* Effect.forEach(LIVE_KINDS, (kind) =>
          database.projections.getRecoveryThreadIds(kind),
        ).pipe(
          Effect.map((ids) => new Set<string>(ids.flat())),
          Effect.mapError(readFailed(location)),
        )
      : new Set<string>();
    const pendingIds = new Set(pendingRows.map((row) => row.thread_id));
    const nowMs = yield* Clock.currentTimeMillis;

    const counts = new Map(
      projectRows.map((row) => [
        row.project_id,
        {
          toImport: [] as Array<ThreadToImport>,
          alreadyImported: 0,
          skipped: new Map<TempoT3ImportSkipReason, number>(),
        },
      ]),
    );
    for (const row of threadRows) {
      const projectCounts = counts.get(row.project_id);
      if (projectCounts === undefined) continue;
      const decoded = yield* decodeThread(row.payload_json).pipe(Effect.option);
      if (Option.isNone(decoded)) {
        countSkip(projectCounts.skipped, "unreadable");
        continue;
      }
      if (decoded.value.lineage.relationshipToParent === "subagent") continue;
      const t3ThreadId = ThreadId.make(row.thread_id);
      const thread = { t3ThreadId, moveId: yield* importMoveId(t3ThreadId) };
      const staysSettled = !includeSettled && isSettledInT3(decoded.value, nowMs);
      if (yield* alreadyHere(thread)) projectCounts.alreadyImported += 1;
      else if (staysSettled) countSkip(projectCounts.skipped, "settled");
      else if (liveIds.has(row.thread_id)) countSkip(projectCounts.skipped, "live");
      else if (pendingIds.has(row.thread_id)) countSkip(projectCounts.skipped, "notHydrated");
      else projectCounts.toImport.push(thread);
    }

    const plans: Array<ProjectPlan> = [];
    for (const row of projectRows) {
      const projectCounts = counts.get(row.project_id);
      if (
        projectCounts === undefined ||
        (projectCounts.toImport.length === 0 &&
          projectCounts.alreadyImported === 0 &&
          projectCounts.skipped.size === 0)
      ) {
        continue;
      }
      const t3ProjectId = ProjectId.make(row.project_id);
      const target = yield* resolveTarget({ t3ProjectId, workspaceRoot: row.workspace_root });
      const unavailable = target.kind === "unavailable";
      if (unavailable && projectCounts.toImport.length > 0) {
        countSkip(projectCounts.skipped, target.reason, projectCounts.toImport.length);
      }
      plans.push({
        t3ProjectId,
        title: row.title.trim() === "" ? path.basename(row.workspace_root) : row.title,
        workspaceRoot: row.workspace_root,
        target,
        toImport: unavailable ? [] : projectCounts.toImport,
        alreadyImported: projectCounts.alreadyImported,
        skipped: projectCounts.skipped,
      });
    }
    return plans;
  });

  const tempoProjectOf = (target: ProjectTarget) =>
    target.kind === "existing" ? { id: target.project.id, title: target.project.title } : null;

  const scan = Effect.fn("T3ImportService.scan")(function* (input: TempoT3ImportInput) {
    const location = yield* locate(input);
    const found = yield* exists(location.dbPath);
    const base = {
      t3Home: location.home,
      found,
      // Measured before the database opens: a reader leaves an empty log of its own.
      sizeBytes: found
        ? (yield* sizeOf(location.dbPath)) + (yield* sizeOf(`${location.dbPath}-wal`))
        : 0,
      t3Running: found ? yield* looksRunning(location) : false,
    };
    if (!found) {
      return { ...base, incompatibility: null, projects: [] } satisfies TempoT3ImportScanResult;
    }
    return yield* withT3Database(location, (database, incompatibility) =>
      Effect.gen(function* () {
        if (incompatibility !== null) {
          return { ...base, incompatibility, projects: [] } satisfies TempoT3ImportScanResult;
        }
        const plans = yield* classify(
          location,
          database,
          input.includeSettled === true,
          base.t3Running,
        );
        return {
          ...base,
          incompatibility: null,
          projects: plans.map((entry) => ({
            t3ProjectId: entry.t3ProjectId,
            title: entry.title,
            workspaceRoot: entry.workspaceRoot,
            tempoProject: tempoProjectOf(entry.target),
            toImport: entry.toImport.length,
            alreadyImported: entry.alreadyImported,
            skipped: skippedList(entry.skipped),
          })),
        } satisfies TempoT3ImportScanResult;
      }),
    );
  }, Effect.provide(services));

  /** T3 Code's environment id, recorded on imported threads as where they came from. */
  const readT3EnvironmentId = (location: T3Location) =>
    fileSystem.readFileString(location.environmentIdPath).pipe(
      Effect.map((raw) => raw.trim()),
      Effect.orElseSucceed(() => ""),
      // T3 Code writes the file when its server first starts; one that never started has none.
      Effect.map((raw) => EnvironmentId.make(raw === "" ? "t3-code" : raw)),
    );

  /** Writes one T3 Code thread here: its conversation, attachments, and where it came from. */
  const importThread = Effect.fn("T3ImportService.importThread")(function* (input: {
    readonly database: T3Database;
    readonly location: T3Location;
    readonly thread: ThreadToImport;
    readonly projectId: ProjectId;
    readonly origin: EnvironmentId;
    readonly instances: ProviderInstances;
    readonly t3Running: boolean;
  }) {
    const { t3ThreadId, moveId } = input.thread;
    yield* Effect.annotateCurrentSpan({ t3ThreadId });
    // The thread's one read, which also brings the history a fork inherited.
    const read = yield* input.database.projections.getThreadProjection(t3ThreadId).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("A T3 Code thread could not be read.", { t3ThreadId, cause }),
      ),
      Effect.option,
    );
    if (Option.isNone(read)) {
      return { imported: false, reason: "unreadable" } satisfies ThreadOutcome;
    }
    const projection = read.value;
    // It started a turn since the threads were counted; the next import takes it once it stops.
    // A closed T3 Code leaves an interrupted turn recorded as running; that history is final.
    if (input.t3Running && projection.runs.some(isActiveRun)) {
      return { imported: false, reason: "live" } satisfies ThreadOutcome;
    }
    const source = projection.thread;
    const threadId = movedThreadId(moveId);
    const messages = exportMovedMessages(projection);
    const attachmentIds = yield* copyMovedAttachments({
      threadId,
      messages,
      attachmentsDir: config.attachmentsDir,
      sourcePath: (attachment) =>
        resolveAttachmentPath({ attachmentsDir: input.location.attachmentsDir, attachment }),
    });
    const model = resolveMovedModelSelection({
      modelSelection: source.modelSelection,
      providerDriver:
        projection.providerThreads.find(
          (providerThread) =>
            providerThread.providerInstanceId === source.modelSelection.instanceId,
        )?.driver ?? null,
      instances: input.instances,
    });
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: buildMovedThreadEvents({
        eventPrefix: `tempo-t3-import:${moveId}`,
        thread: {
          title: source.title,
          modelSelection: model.modelSelection,
          runtimeMode: source.runtimeMode,
          interactionMode: source.interactionMode,
          createdAt: source.createdAt,
          linkedPullRequest: source.linkedPullRequest ?? null,
          // Watches stay with the app that set them up.
          pullRequests: (source.pullRequests ?? []).map(({ watch: _watch, ...link }) => link),
        },
        messages,
        threadId,
        projectId: input.projectId,
        // The thread goes on working in T3 Code's checkout, on the same branch.
        branch: source.branch,
        worktreePath: source.worktreePath,
        movedFrom: {
          moveId,
          environmentId: input.origin,
          environmentLabel: T3_ENVIRONMENT_LABEL,
          threadId: source.id,
          movedAt: DateTime.formatIso(now),
        },
        now,
        // Same machine: every path in the history still points where it did.
        pathMappings: [],
        attachmentIds,
        lifecycle: {
          updatedAt: source.updatedAt,
          archivedAt: source.archivedAt,
          settledOverride: source.settledOverride,
          settledAt: source.settledAt,
          snoozedUntil: source.snoozedUntil ?? null,
          snoozedAt: source.snoozedAt ?? null,
        },
      }),
    });
    const attachmentCount = new Set(
      messages.flatMap((message) => message.attachments.map((attachment) => attachment.id)),
    ).size;
    return {
      imported: true,
      missingAttachments: attachmentCount - attachmentIds.size,
      needsModel: !model.available,
    } satisfies ThreadOutcome;
  });

  /** Imports one project's threads, creating its Tempo project first when there is none. */
  const importProject = Effect.fn("T3ImportService.importProject")(function* (input: {
    readonly database: T3Database;
    readonly location: T3Location;
    readonly plan: ProjectPlan;
    readonly origin: EnvironmentId;
    readonly instances: ProviderInstances;
    readonly t3Running: boolean;
  }) {
    const { plan, ...context } = input;
    const skipped = new Map(plan.skipped);
    const target = plan.target;
    const tempoProject =
      target.kind === "existing"
        ? tempoProjectOf(target)
        : target.kind === "create" && plan.toImport.length > 0
          ? yield* recover(
              projects
                .create({
                  // Derived from T3 Code's project, so a retried import replays this create.
                  commandId: CommandId.make(`tempo-t3-import:project:${plan.t3ProjectId}`),
                  projectId: target.projectId,
                  title: plan.title,
                  workspaceRoot: plan.workspaceRoot,
                })
                .pipe(Effect.map((project) => ({ id: project.id, title: project.title }))),
              null,
              `Creating a ${TEMPO_APP_BASE_NAME} project for a T3 Code project failed.`,
              { t3ProjectId: plan.t3ProjectId },
            )
          : null;
    let imported = 0;
    let missingAttachments = 0;
    let needsModel = 0;
    if (tempoProject === null) {
      // Its Tempo project could not be created, so its threads have nowhere to go.
      if (plan.toImport.length > 0) countSkip(skipped, "failed", plan.toImport.length);
    } else {
      for (const thread of plan.toImport) {
        const outcome = yield* recover(
          importThread({ ...context, thread, projectId: tempoProject.id }),
          { imported: false, reason: "failed" } satisfies ThreadOutcome,
          "Importing a T3 Code thread failed.",
          { t3ThreadId: thread.t3ThreadId },
        );
        if (!outcome.imported) {
          countSkip(skipped, outcome.reason);
          continue;
        }
        imported += 1;
        missingAttachments += outcome.missingAttachments;
        if (outcome.needsModel) needsModel += 1;
      }
    }
    return {
      project: {
        t3ProjectId: plan.t3ProjectId,
        title: plan.title,
        workspaceRoot: plan.workspaceRoot,
        tempoProject,
        imported,
        createdProject: target.kind === "create" && tempoProject !== null,
        alreadyImported: plan.alreadyImported,
        skipped: skippedList(skipped),
      } satisfies TempoT3ImportRunProject,
      missingAttachments,
      needsModel,
    };
  });

  const run = Effect.fn("T3ImportService.run")(
    function* (input: TempoT3ImportInput) {
      const location = yield* locate(input);
      if (!(yield* exists(location.dbPath))) {
        return yield* new TempoT3ImportNotFoundError({ t3Home: location.home });
      }
      // Measured before the database opens, as in scan.
      const t3Running = yield* looksRunning(location);
      return yield* withT3Database(location, (database, incompatibility) =>
        Effect.gen(function* () {
          if (incompatibility !== null) {
            return yield* new TempoT3ImportIncompatibleError({ reason: incompatibility });
          }
          const plans = yield* classify(
            location,
            database,
            input.includeSettled === true,
            t3Running,
          );
          const origin = yield* readT3EnvironmentId(location);
          const instances = yield* providerInstances.listInstances;
          const outcomes = yield* Effect.forEach(plans, (plan) =>
            importProject({ database, location, plan, origin, instances, t3Running }),
          );
          return {
            projects: outcomes.map((outcome) => outcome.project),
            missingAttachments: outcomes.reduce(
              (sum, outcome) => sum + outcome.missingAttachments,
              0,
            ),
            needsModel: outcomes.reduce((sum, outcome) => sum + outcome.needsModel, 0),
          } satisfies TempoT3ImportRunResult;
        }),
      );
    },
    Effect.provide(services),
    // Two imports at once would race to write the same threads.
    (effect) => runLock.withPermits(1)(effect),
  );

  return T3ImportService.of({ scan, run });
});

export const layer = Layer.effect(T3ImportService, make);
