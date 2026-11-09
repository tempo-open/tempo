/**
 * Keeps this machine's own Codex and Claude Code threads and scheduled tasks in Tempo. Sweeps import
 * new threads, append grown transcripts and mirror archiving, except where Tempo continued a thread
 * (Tempo's copy wins); Claude Code's idle cleanup is not a deletion. Unchanged transcripts are never
 * read, this sync writes nothing under a native home, and a session Tempo runs is never imported.
 */
import {
  AgentSessionImportSource,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  resolveProviderInstanceEnabled,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  CODEX_STATE_DATABASE,
  makeNativeDiscovery,
  type NativeDiscovery,
  type NativeDriver,
  type NativeTranscript,
} from "./nativeDiscovery.ts";
import { resolveNativeHomes, type NativeHomes } from "./nativeHomes.ts";
import { makeNativeSchedules, NativeTaskRecord } from "./nativeSchedules.ts";

/** Between sweeps; a sweep that left work behind runs again after BACKLOG_DELAY. */
const SWEEP_INTERVAL = "1 minute";
const BACKLOG_DELAY = "5 seconds";
/** Longest a watched machine goes without a sweep, for a change no watch or check saw. */
const UNCHANGED_SWEEP_MS = 15 * 60_000;
/** Where watching a home recursively is native; Linux's walks and watches every folder. */
const WATCHED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32"]);
/**
 * What a sweep reads in each native home, the only places watched there: the home's own files, and
 * folders read whole or only for their `files`. Claude Code: `projects/` and `settings.json` (its
 * cleanup age). Codex: `sessions/`, the state database, `automations/`, `sqlite/codex.db`, and
 * `archived_sessions/`, where archiving moves a rollout.
 */
const READ_IN_HOME: Readonly<
  Record<
    keyof NativeHomes,
    {
      readonly files: ReadonlyArray<string>;
      readonly folders: ReadonlyArray<{
        readonly name: string;
        readonly files?: ReadonlyArray<string>;
      }>;
    }
  >
> = {
  claude: { files: ["settings.json"], folders: [{ name: "projects" }] },
  codex: {
    files: [CODEX_STATE_DATABASE, `${CODEX_STATE_DATABASE}-wal`],
    folders: [
      { name: "sessions" },
      { name: "archived_sessions" },
      { name: "automations" },
      { name: "sqlite", files: ["codex.db", "codex.db-wal"] },
    ],
  },
};
/** A transcript written to more recently may be mid-turn; its refresh waits a sweep. */
const QUIET_MS = 60_000;
/** Transcripts one sweep reads in full, newest first. */
const MAX_READS_PER_SWEEP = 25;
const MAX_READ_BYTES_PER_SWEEP = 512 * 1024 * 1024;
/** New transcripts one sweep looks at the start of, to tell whose they are and where. */
const MAX_HEADS_PER_SWEEP = 500;
const DAY_MS = 24 * 60 * 60_000;
const CLAUDE_DEFAULT_RETENTION_DAYS = 30;
const decodeClaudeSettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ cleanupPeriodDays: Schema.optional(Schema.NullOr(Schema.Number)) }),
  ),
);
const STATE_FILE = "native-agent-sync.json";

/** The provider instance Tempo runs each native app's threads on. */
const INSTANCE_BY_DRIVER: Readonly<Record<NativeDriver, ProviderInstanceId>> = {
  claudeAgent: ProviderInstanceId.make("claudeAgent"),
  codex: ProviderInstanceId.make("codex"),
};

export interface NativeAgentSyncResult {
  /** False when the Settings toggle is off; nothing else ran. */
  readonly enabled: boolean;
  readonly imported: number;
  readonly refreshed: number;
  readonly archived: number;
  readonly unarchived: number;
  readonly scheduledTasks: {
    readonly created: number;
    readonly updated: number;
    readonly removed: number;
  };
  /** More native threads changed than one sweep reads; the next sweep continues. */
  readonly pending: boolean;
}

export class NativeAgentSync extends Context.Service<
  NativeAgentSync,
  {
    /** One sweep now, unless the setting is off. */
    readonly syncNow: Effect.Effect<NativeAgentSyncResult>;
    /**
     * The minute's sweep. Where the native homes can be watched, it runs only
     * when anything it reads may have changed since the last sweep or that one
     * is 15 minutes old; elsewhere always. Null when it skipped or the setting is off.
     */
    readonly syncIfChanged: Effect.Effect<NativeAgentSyncResult | null>;
    /** Runs `syncIfChanged` every minute while the setting is on, and sweeps as soon as it is turned on. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/tempo/nativeAgentSync/NativeAgentSync") {}

/** What this sync remembers between sweeps and restarts, beside what Tempo itself records. */
const SyncState = Schema.Struct({
  /** Threads this sync archived because the native thread was archived or deleted. */
  archived: Schema.Array(Schema.String),
  /** Each synced thread's native title when last synced, to tell a rename here from one there. */
  titles: Schema.Record(Schema.String, Schema.String),
  /** Each imported scheduled task's native task when last synced. */
  tasks: Schema.Record(Schema.String, NativeTaskRecord),
});
type SyncState = typeof SyncState.Type;
const decodeState = Schema.decodeUnknownOption(Schema.fromJsonString(SyncState));

class NativeAgentSyncStateError extends Schema.TaggedError<NativeAgentSyncStateError>()(
  "NativeAgentSyncStateError",
  { statePath: Schema.String },
) {
  override get message(): string {
    return `${this.statePath} is not a native sync state; the sync waits until it is fixed or removed.`;
  }
}
const encodeState = Schema.encodeSync(Schema.fromJsonString(SyncState));
const EMPTY_STATE: SyncState = { archived: [], titles: {}, tasks: {} };

const decodeRuntimePayload = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      importedTranscripts: Schema.optional(Schema.Array(AgentSessionImportSource)),
    }),
  ),
);

/** An imported thread as this sync needs it: one read of Tempo's projections per sweep. */
interface KnownThread {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly archived: boolean;
  readonly deleted: boolean;
  /** Tempo has run turns on it since the import. */
  readonly continued: boolean;
  readonly worktreePath: string | null;
  readonly sources: ReadonlyArray<AgentSessionImportSource>;
}

const threadIdFor = (driver: NativeDriver, nativeId: string) =>
  ThreadId.make(`import:${INSTANCE_BY_DRIVER[driver]}:${nativeId}`);

const sameFile = (source: AgentSessionImportSource, transcript: NativeTranscript) =>
  source.filePath === transcript.filePath &&
  source.size === transcript.size &&
  source.mtimeMs === transcript.mtimeMs;

const NOTHING_DONE = {
  imported: 0,
  refreshed: 0,
  archived: 0,
  unarchived: 0,
  scheduledTasks: { created: 0, updated: 0, removed: 0 },
} as const;

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const threadManagement = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const runtimes = yield* ProviderSessionRuntime.ProviderSessionRuntimeRepository;
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const importer = yield* AgentSessionImporter.AgentSessionImporter;
  const discovery = yield* makeNativeDiscovery;
  const schedules = yield* makeNativeSchedules;
  const platform = yield* HostProcess.Platform;
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const statePath = path.join(config.stateDir, STATE_FILE);

  /**
   * Something a sweep reads may have changed since the last one began: set by
   * the native homes' watches, settings changes, failures and work a sweep
   * left for later, and cleared as a sweep begins.
   */
  let unswept = true;
  let sweptAt = Number.NEGATIVE_INFINITY;
  /** The folders outside the native homes the last sweep read, and what they held at the last look. */
  let outsideFolders: ReadonlyArray<string> = [];
  let outsideKey: string | null = null;

  // Interrupting the sweep's own fiber skips these handlers; an interrupted inner
  // fiber is one more failure, so the minute loop keeps going and tries again.
  const logFailure =
    (message: string, fields: Record<string, unknown>) =>
    <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
      Effect.sync(() => {
        unswept = true;
      }).pipe(
        Effect.andThen(Effect.logWarning(message, { ...fields, cause: Cause.pretty(cause) })),
      );

  /** `effect`'s success, or `fallback` after logging its failure. */
  const recover = <A, B, E, R>(
    effect: Effect.Effect<A, E, R>,
    fallback: B,
    message: string,
    fields: Record<string, unknown>,
  ): Effect.Effect<A | B, never, R> =>
    effect.pipe(
      Effect.catchCause((cause) => logFailure(message, fields)(cause).pipe(Effect.as(fallback))),
    );

  /** Transcripts that are not Tempo's to import (another app's, a folder Tempo does not offer), by stat. */
  const passedOver = new Map<string, string>();
  /** Folders whose project the person removed, with the transcripts passed over for it. */
  const removedFolders = new Map<string, Set<string>>();
  /** Continued threads whose native copy moved on; logged once each. */
  const diverged = new Set<ThreadId>();
  const statKey = (transcript: NativeTranscript) => `${transcript.size}:${transcript.mtimeMs}`;

  const digest = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) => Hex.encode(bytes).slice(0, 24)),
      Effect.orDie,
    );
  const serverCommandId = (action: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:native-sync:${action}:${threadId}:${uuid}`)),
    );

  /**
   * Empty only before the first save. A state that cannot be read fails the
   * sweep instead: starting over would recreate tasks the person deleted and
   * re-archive threads they unarchived.
   */
  const loadState = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(statePath))) return EMPTY_STATE;
    const decoded = decodeState(yield* fileSystem.readFileString(statePath));
    if (Option.isNone(decoded)) return yield* new NativeAgentSyncStateError({ statePath });
    return decoded.value;
  });
  const saveState = Effect.fn("NativeAgentSync.saveState")(
    function* (state: SyncState) {
      const suffix = Math.abs(yield* Random.nextInt).toString(36);
      const temporary = `${statePath}.${suffix}.tmp`;
      yield* fileSystem.writeFileString(temporary, encodeState(state));
      yield* fileSystem.rename(temporary, statePath);
    },
    Effect.catchCause(logFailure("native sync could not save its state", { statePath })),
  );

  const readKnownThreads = sql<{
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
    readonly archivedAt: string | null;
    readonly deletedAt: string | null;
    readonly continued: number;
    readonly worktreePath: string | null;
    readonly runtimePayload: string | null;
  }>`
    SELECT t.thread_id AS "threadId",
      t.project_id AS "projectId",
      t.title AS title,
      t.archived_at AS "archivedAt",
      t.deleted_at AS "deletedAt",
      EXISTS (
        SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.thread_id = t.thread_id
      ) AS continued,
      json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
      p.runtime_payload_json AS "runtimePayload"
    FROM orchestration_v2_projection_threads t
    LEFT JOIN provider_session_runtime p ON p.thread_id = t.thread_id
    WHERE t.thread_id LIKE 'import:%'
  `.pipe(
    Effect.map((rows) =>
      rows.map((row): KnownThread => ({
        threadId: ThreadId.make(row.threadId),
        projectId: ProjectId.make(row.projectId),
        title: row.title,
        archived: row.archivedAt !== null,
        deleted: row.deletedAt !== null,
        continued: Number(row.continued) === 1,
        worktreePath: row.worktreePath,
        sources: Option.match(decodeRuntimePayload(row.runtimePayload), {
          onNone: () => [],
          onSome: (payload) => payload.importedTranscripts ?? [],
        }),
      })),
    ),
  );

  /**
   * The native sessions Tempo's own threads run on, which live beside the person's in a shared home.
   * The transcript's start cannot always tell: a fork of a Claude Desktop session starts with its lines.
   */
  const readOwnNativeIds = sql<{ readonly nativeId: string }>`
    SELECT json_extract(payload_json, '$.nativeThreadRef.nativeId') AS "nativeId"
    FROM orchestration_v2_projection_provider_threads
    WHERE json_extract(payload_json, '$.nativeThreadRef.nativeId') IS NOT NULL
  `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.nativeId.toLowerCase()))));

  const discoverHome = (driver: NativeDriver, home: string | null) =>
    home === null
      ? Effect.succeed<NativeDiscovery>({
          transcripts: [],
          archivedIds: new Set(),
          complete: false,
        })
      : driver === "claudeAgent"
        ? discovery.claude(home)
        : discovery.codex(home);

  /** The person removed this folder's project, so its native threads stay out. */
  const projectRemoved = Effect.fn("NativeAgentSync.projectRemoved")(function* (
    workspaceRoot: string,
  ) {
    if (Option.isSome(yield* projects.getByWorkspaceRoot(workspaceRoot))) return false;
    return Option.isSome(
      yield* projects.getByWorkspaceRoot(workspaceRoot, { includeDeleted: true }),
    );
  });

  /** The Tempo project for a native thread's folder: the one there, else one this sync creates. */
  const projectFor = Effect.fn("NativeAgentSync.projectFor")(function* (workspaceRoot: string) {
    const active = yield* projects.getByWorkspaceRoot(workspaceRoot);
    if (Option.isSome(active)) return active.value;
    if (yield* projectRemoved(workspaceRoot)) return null;
    const projectId = ProjectId.make(`native-${yield* digest(workspaceRoot)}`);
    return yield* projects.create({
      // Derived from the folder, so a retried sweep replays this create.
      commandId: CommandId.make(`tempo-native-sync:project:${projectId}`),
      projectId,
      title: path.basename(workspaceRoot) || workspaceRoot,
      workspaceRoot,
    });
  });

  /**
   * Appends the messages a native session gained since Tempo last read it. The
   * importer numbers a thread's messages; new ones continue that numbering.
   */
  const refresh = Effect.fn("NativeAgentSync.refresh")(function* (
    thread: KnownThread,
    read: AgentSessionScanner.AgentSessionTranscriptThread,
  ) {
    const { messages, runs } = yield* orchestrator.getThreadRecords(thread.threadId, [
      "messages",
      "runs",
    ]);
    // Continued here since the sweep began: Tempo's copy wins.
    if (runs.length > 0) return false;
    const prefix = `${thread.threadId}:`;
    const imported = messages
      .flatMap((message) => {
        const suffix = message.id.slice(prefix.length);
        return message.id.startsWith(prefix) && /^\d+$/.test(suffix)
          ? [{ index: Number(suffix), message }]
          : [];
      })
      .toSorted((a, b) => a.index - b.index);
    const window = read.thread.messages;
    const same = (
      candidate: (typeof window)[number] | undefined,
      entry: (typeof imported)[number] | undefined,
    ) =>
      candidate !== undefined &&
      entry !== undefined &&
      candidate.role === entry.message.role &&
      candidate.text === entry.message.text &&
      candidate.createdAt === DateTime.formatIso(entry.message.createdAt);
    const last = imported.at(-1);
    const position = window.findLastIndex((candidate) => same(candidate, last));
    // More messages than one import keeps arrived since: the newest of them follow.
    const overflowed =
      last !== undefined &&
      same(window[0], imported[0]) &&
      (window[1]?.createdAt ?? "") > DateTime.formatIso(last.message.createdAt);
    const fresh =
      last === undefined
        ? window
        : position >= 0
          ? window.slice(position + 1)
          : overflowed
            ? window.slice(1)
            : null;
    if (fresh === null) {
      yield* Effect.logInfo(
        `a synced thread's native history no longer matches; keeping ${TEMPO_APP_BASE_NAME}'s`,
        {
          threadId: thread.threadId,
        },
      );
    } else if (fresh.length > 0) {
      const start = (last?.index ?? -1) + 1;
      yield* eventSink.write({
        events: fresh.flatMap((message, offset) =>
          AgentSessionImporter.messageEvents({
            threadId: thread.threadId,
            index: start + offset,
            message,
          }),
        ),
      });
    }
    yield* runtimes.recordImportedTranscript({ threadId: thread.threadId, source: read.source });
    return fresh !== null && fresh.length > 0;
  });

  /**
   * How long Claude Code keeps an idle transcript before its own cleanup
   * deletes it (`cleanupPeriodDays`, default 30). That deletion is not the
   * person's, so it archives nothing here.
   */
  const claudeRetentionMs = Effect.fn("NativeAgentSync.claudeRetentionMs")(function* (
    claudeHome: string,
  ) {
    const text = yield* fileSystem
      .readFileString(path.join(claudeHome, "settings.json"))
      .pipe(Effect.option);
    const days = Option.flatMap(text, decodeClaudeSettings).pipe(
      Option.flatMap((settings) => Option.fromNullishOr(settings.cleanupPeriodDays)),
      Option.filter((value) => Number.isFinite(value) && value > 0),
      Option.getOrElse(() => CLAUDE_DEFAULT_RETENTION_DAYS),
    );
    return days * DAY_MS;
  });

  /**
   * Where an imported thread's native copy stands: there, archived or deleted
   * ("gone"), or unknown when its home could not be read in full or the native
   * app removed it by age.
   */
  const nativeStateOf = Effect.fn("NativeAgentSync.nativeStateOf")(function* (
    thread: KnownThread,
    context: {
      readonly homes: Readonly<Record<NativeDriver, string | null>>;
      readonly found: Readonly<Record<NativeDriver, NativeDiscovery>>;
      readonly present: Readonly<Record<NativeDriver, ReadonlySet<string>>>;
      readonly now: number;
      readonly claudeRetentionMs: number;
    },
  ) {
    for (const source of thread.sources) {
      const home = context.homes[source.provider];
      // Imported from elsewhere, such as Tempo's own homes: not this sync's to follow.
      if (home === null || !source.filePath.startsWith(`${home}${path.sep}`)) continue;
      const discovered = context.found[source.provider];
      if (context.present[source.provider].has(source.providerSessionId)) return "active" as const;
      if (discovered.archivedIds.has(source.providerSessionId)) return "gone" as const;
      if (!discovered.complete) return "unknown" as const;
      const exists = yield* fileSystem
        .exists(source.filePath)
        .pipe(Effect.orElseSucceed(() => true));
      if (exists) return "active" as const;
      // Within a day of Claude Code's cleanup age, a missing transcript aged out.
      const agedOut =
        source.provider === "claudeAgent" &&
        source.mtimeMs !== null &&
        context.now - source.mtimeMs >= context.claudeRetentionMs - DAY_MS;
      return agedOut ? ("unknown" as const) : ("gone" as const);
    }
    return "unknown" as const;
  });

  const sweep = Effect.fn("NativeAgentSync.sweep")(function* () {
    const current = yield* settings.getSettings;
    if (!current.tempoNativeAgentSync) {
      return { enabled: false, ...NOTHING_DONE, pending: false } satisfies NativeAgentSyncResult;
    }
    // What changes from here on is the next sweep's to find.
    unswept = false;
    sweptAt = yield* Clock.currentTimeMillis;
    const native: NativeHomes = yield* resolveNativeHomes({ baseDir: config.baseDir }).pipe(
      Effect.provideService(Path.Path, path),
    );
    // A provider turned off in settings keeps its native threads out.
    const enabled = (driver: NativeDriver) => {
      const instance = current.providerInstances[INSTANCE_BY_DRIVER[driver]];
      return instance === undefined || resolveProviderInstanceEnabled(instance);
    };
    const homes: Readonly<Record<NativeDriver, string | null>> = {
      claudeAgent: enabled("claudeAgent") ? native.claude : null,
      codex: enabled("codex") ? native.codex : null,
    };
    const found: Readonly<Record<NativeDriver, NativeDiscovery>> = {
      claudeAgent: yield* discoverHome("claudeAgent", homes.claudeAgent),
      codex: yield* discoverHome("codex", homes.codex),
    };
    const state = yield* loadState;
    const titles: Record<string, string> = { ...state.titles };
    const archivedBySync = new Set(state.archived);
    const known = new Map((yield* readKnownThreads).map((thread) => [thread.threadId, thread]));
    const now = yield* Clock.currentTimeMillis;
    // A folder added back as a project brings its threads again.
    for (const [workspaceRoot, files] of removedFolders) {
      if (yield* projectRemoved(workspaceRoot)) continue;
      for (const file of files) passedOver.delete(file);
      removedFolders.delete(workspaceRoot);
    }
    let heads = 0;
    let reads = 0;
    let bytes = 0;
    let pending = false;
    let refreshed = 0;
    // Read when a sweep first meets a transcript it does not know, which most sweeps never do.
    let ownNativeIds: ReadonlySet<string> | null = null;
    const takeRead = (transcript: NativeTranscript) => {
      if (
        reads >= MAX_READS_PER_SWEEP ||
        (reads > 0 && bytes + transcript.size > MAX_READ_BYTES_PER_SWEEP)
      ) {
        pending = true;
        return false;
      }
      reads += 1;
      bytes += transcript.size;
      return true;
    };
    const readThread = (transcript: NativeTranscript) =>
      scanner.readThread({
        source: transcript.driver,
        providerInstanceId: INSTANCE_BY_DRIVER[transcript.driver],
        filePath: transcript.filePath,
      });
    /**
     * A rename in the native app follows, unless the thread was renamed here.
     * Untraced: a sweep calls it for every synced thread, and most have no rename.
     */
    const followTitle = Effect.fnUntraced(function* (thread: KnownThread, nativeTitle: string) {
      const synced = titles[thread.threadId];
      titles[thread.threadId] = nativeTitle;
      if (synced === undefined || synced === nativeTitle || thread.title !== synced) return;
      if (nativeTitle.trim() === "") return;
      yield* recover(
        threadManagement.dispatch({
          type: "thread.metadata.update",
          commandId: yield* serverCommandId("title", thread.threadId),
          threadId: thread.threadId,
          title: nativeTitle,
        }),
        undefined,
        "native sync could not rename a thread",
        { threadId: thread.threadId },
      );
    });

    // New and changed threads, newest first across both apps.
    const toImport = new Map<string, Array<AgentSessionScanner.AgentSessionSyncedThread>>();
    const active = [...found.claudeAgent.transcripts, ...found.codex.transcripts].toSorted(
      (a, b) => b.mtimeMs - a.mtimeMs,
    );
    for (const transcript of active) {
      const threadId = threadIdFor(transcript.driver, transcript.nativeId);
      const thread = known.get(threadId);
      if (thread === undefined) {
        if (transcript.compressed) continue;
        if (passedOver.get(transcript.filePath) === statKey(transcript)) continue;
        ownNativeIds ??= yield* readOwnNativeIds;
        if (ownNativeIds.has(transcript.nativeId)) {
          passedOver.set(transcript.filePath, statKey(transcript));
          continue;
        }
        if (heads >= MAX_HEADS_PER_SWEEP) {
          pending = true;
          continue;
        }
        heads += 1;
        const head = yield* discovery.readHead(transcript);
        const workspace =
          head === null || head.foreign ? null : yield* scanner.workspaceFor(head.cwd);
        if (workspace === null) {
          passedOver.set(transcript.filePath, statKey(transcript));
          continue;
        }
        const { workspaceRoot, worktreePath, branch } = workspace;
        if (yield* projectRemoved(workspaceRoot)) {
          passedOver.set(transcript.filePath, statKey(transcript));
          const files = removedFolders.get(workspaceRoot) ?? new Set<string>();
          removedFolders.set(workspaceRoot, files.add(transcript.filePath));
          continue;
        }
        if (!takeRead(transcript)) continue;
        const read = yield* readThread(transcript);
        if (
          read === null ||
          threadIdFor(transcript.driver, read.thread.providerSessionId) !== threadId
        ) {
          passedOver.set(transcript.filePath, statKey(transcript));
          continue;
        }
        const title = transcript.title ?? read.thread.title;
        titles[threadId] = title;
        const batch = toImport.get(workspaceRoot) ?? [];
        batch.push({ ...read, thread: { ...read.thread, title }, worktreePath, branch });
        toImport.set(workspaceRoot, batch);
        continue;
      }
      if (thread.deleted) continue;
      const recorded = thread.sources.find((source) => source.filePath === transcript.filePath);
      const changed = recorded === undefined || !sameFile(recorded, transcript);
      if (thread.continued) {
        if (changed && !diverged.has(threadId)) {
          diverged.add(threadId);
          yield* Effect.logInfo(
            `a synced thread changed natively after ${TEMPO_APP_BASE_NAME} continued it; keeping ${TEMPO_APP_BASE_NAME}'s copy`,
            { threadId, filePath: transcript.filePath },
          );
        }
        continue;
      }
      // Codex keeps names in its database, so its renames need no transcript read.
      if (transcript.title !== null) yield* followTitle(thread, transcript.title);
      if (!changed || transcript.compressed) continue;
      // A transcript still being written waits for the next sweep, which is due for it.
      if (now - transcript.mtimeMs < QUIET_MS) {
        unswept = true;
        continue;
      }
      if (passedOver.get(transcript.filePath) === statKey(transcript)) continue;
      if (!takeRead(transcript)) continue;
      const read = yield* readThread(transcript);
      if (read === null) {
        // Past the import's limits: tried again once it changes.
        passedOver.set(transcript.filePath, statKey(transcript));
        continue;
      }
      if (
        yield* recover(refresh(thread, read), false, "native sync could not refresh a thread", {
          threadId,
        })
      ) {
        refreshed += 1;
      }
      // A Claude session names itself in its transcript; Codex names threads in its database.
      if (transcript.driver === "claudeAgent") yield* followTitle(thread, read.thread.title);
    }

    let imported = 0;
    for (const [workspaceRoot, batch] of toImport) {
      imported += yield* recover(
        Effect.gen(function* () {
          const project = yield* projectFor(workspaceRoot);
          if (project === null) return 0;
          const counts = yield* importer.importRecentAgentThreads(
            { projectId: project.id, expectedWorkspaceRoot: project.workspaceRoot },
            batch,
          );
          return counts.importedCount;
        }),
        0,
        "native sync could not import a folder's threads",
        { workspaceRoot },
      );
    }
    // Every thread this sweep imported; one that did not arrive waits until its transcript changes.
    const threads =
      toImport.size === 0
        ? known
        : new Map((yield* readKnownThreads).map((thread) => [thread.threadId, thread]));
    for (const batch of toImport.values()) {
      for (const { source } of batch) {
        if (threads.has(threadIdFor(source.provider, source.providerSessionId))) continue;
        passedOver.set(source.filePath, `${source.size}:${source.mtimeMs}`);
      }
    }

    // Native archives and deletions, and their reversal.
    let archived = 0;
    let unarchived = 0;
    const context = {
      homes,
      found,
      present: {
        claudeAgent: new Set(found.claudeAgent.transcripts.map((entry) => entry.nativeId)),
        codex: new Set(found.codex.transcripts.map((entry) => entry.nativeId)),
      },
      now,
      claudeRetentionMs:
        homes.claudeAgent === null
          ? CLAUDE_DEFAULT_RETENTION_DAYS * DAY_MS
          : yield* claudeRetentionMs(homes.claudeAgent),
    };
    for (const thread of known.values()) {
      if (thread.deleted) continue;
      const nativeState = yield* nativeStateOf(thread, context);
      if (nativeState === "unknown") continue;
      if (nativeState === "active") {
        if (!archivedBySync.has(thread.threadId)) continue;
        // Unarchived here already: the sync's archive is undone either way.
        if (!thread.archived) {
          archivedBySync.delete(thread.threadId);
          continue;
        }
        const done = yield* recover(
          threadManagement.dispatch({
            type: "thread.unarchive",
            commandId: yield* serverCommandId("unarchive", thread.threadId),
            threadId: thread.threadId,
          }),
          null,
          "native sync could not unarchive a thread",
          { threadId: thread.threadId },
        );
        if (done === null) continue;
        archivedBySync.delete(thread.threadId);
        unarchived += 1;
        continue;
      }
      if (archivedBySync.has(thread.threadId) || thread.archived || thread.continued) continue;
      const done = yield* recover(
        threadManagement.dispatch({
          type: "thread.archive",
          commandId: yield* serverCommandId("archive", thread.threadId),
          threadId: thread.threadId,
        }),
        null,
        "native sync could not archive a thread",
        { threadId: thread.threadId },
      );
      if (done === null) continue;
      archivedBySync.add(thread.threadId);
      archived += 1;
    }

    // Tasks bind to threads, including the ones this sweep just imported.
    const tasks = yield* recover(
      schedules.sync({
        homes: { claude: homes.claudeAgent, codex: homes.codex },
        state: state.tasks,
        threads,
        projectFor: (folder) =>
          recover(
            scanner.workspaceFor(folder).pipe(
              Effect.flatMap((workspace) =>
                workspace === null ? Effect.succeed(null) : projectFor(workspace.workspaceRoot),
              ),
              Effect.map((project) => project?.id ?? null),
            ),
            null,
            "native sync could not find a scheduled task's project",
            { folder },
          ),
      }),
      { state: state.tasks, created: 0, updated: 0, removed: 0, folders: outsideFolders },
      "native sync could not sync scheduled tasks",
      {},
    );
    outsideFolders = tasks.folders;

    const synced = new Set<string>(threads.keys());
    const next: SyncState = {
      archived: [...archivedBySync].toSorted(),
      titles: Object.fromEntries(Object.entries(titles).filter(([id]) => synced.has(id))),
      tasks: tasks.state,
    };
    if (encodeState(next) !== encodeState(state)) yield* saveState(next);
    // The rest is the next sweep's, after BACKLOG_DELAY.
    if (pending) unswept = true;
    return {
      enabled: true,
      imported,
      refreshed,
      archived,
      unarchived,
      scheduledTasks: { created: tasks.created, updated: tasks.updated, removed: tasks.removed },
      pending,
    } satisfies NativeAgentSyncResult;
  });

  const syncNow: NativeAgentSync["Service"]["syncNow"] = lock.withPermits(1)(
    recover(
      sweep(),
      { enabled: true, ...NOTHING_DONE, pending: false } satisfies NativeAgentSyncResult,
      "native sync failed",
      {},
    ),
  );

  /** Each watched folder's watch while it runs: true once it is ready. */
  const watches = new Map<string, boolean>();
  /** Folders whose watch failed, logged once each. */
  const unwatchable = new Set<string>();
  /**
   * Watches `folder` unless it already is: all of it, or given `names`, only
   * its own entries of those names. True once it is watched, and while it does
   * not exist, as it holds nothing to sweep; it is looked for again next minute.
   * Untraced: every look calls it for each folder, and a watched one returns at once.
   */
  const watchFolder = Effect.fnUntraced(function* (folder: string, names?: ReadonlySet<string>) {
    const current = watches.get(folder);
    if (current !== undefined) return current;
    if (!(yield* fileSystem.exists(folder).pipe(Effect.orElseSucceed(() => true)))) return true;
    const ready = yield* Deferred.make<boolean>();
    watches.set(folder, false);
    yield* fileSystem
      .watch(folder, {
        recursive: names === undefined,
        onReady: () => {
          watches.set(folder, true);
          Deferred.doneUnsafe(ready, Exit.succeed(true));
        },
      })
      .pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            if (names === undefined || names.has(event.path)) unswept = true;
          }),
        ),
        Effect.catchCause((cause) => {
          if (unwatchable.has(folder)) return Effect.void;
          unwatchable.add(folder);
          return Effect.logWarning(
            "native sync cannot watch a native home's folder; it sweeps every minute",
            { folder, cause: Cause.pretty(cause) },
          );
        }),
        Effect.ensuring(
          Effect.sync(() => {
            watches.delete(folder);
            unswept = true;
            Deferred.doneUnsafe(ready, Exit.succeed(false));
          }),
        ),
        Effect.forkIn(scope),
      );
    const watched = yield* Deferred.await(ready);
    // What changed before the watch began is the next sweep's to find.
    if (watched) unswept = true;
    return watched;
  });

  /**
   * Watches what a sweep reads in each native home that exists (READ_IN_HOME)
   * and is not watched yet; true when all of it is. The home's own watch sees
   * the files read there, and a read folder appear or go; one that appears is
   * watched from the next minute.
   */
  const watchHomes = Effect.gen(function* () {
    if (!WATCHED_PLATFORMS.has(platform)) return false;
    const native = yield* resolveNativeHomes({ baseDir: config.baseDir }).pipe(
      Effect.provideService(Path.Path, path),
    );
    let watched = true;
    for (const app of ["claude", "codex"] as const) {
      const home = native[app];
      if (home === null) continue;
      const { files, folders } = READ_IN_HOME[app];
      const entries = new Set([...files, ...folders.map((folder) => folder.name)]);
      if (!(yield* watchFolder(home, entries))) watched = false;
      // A home that does not exist or is not watched has no folders to watch yet.
      if (watches.get(home) !== true) continue;
      for (const folder of folders) {
        const read = folder.files === undefined ? undefined : new Set(folder.files);
        if (!(yield* watchFolder(path.join(home, folder.name), read))) watched = false;
      }
    }
    return watched;
  });

  /** The newest event Tempo had committed at the last look. */
  let eventsSeen: number | null = null;
  /** Whether Tempo committed an event about a project or an imported thread since the last look. */
  const tempoChanged = Effect.gen(function* () {
    if (eventsSeen === null) {
      const [first] = yield* sql<{ readonly latest: number | null }>`
        SELECT MAX(sequence) AS latest FROM orchestration_events
      `;
      eventsSeen = first?.latest ?? 0;
      return true;
    }
    // Only the events since the last look, which the sequence's own index finds.
    const [row] = yield* sql<{ readonly latest: number | null; readonly relevant: number | null }>`
      SELECT MAX(sequence) AS latest,
        MAX(aggregate_kind = 'project' OR stream_id LIKE 'import:%') AS relevant
      FROM orchestration_events
      WHERE sequence > ${eventsSeen}
    `;
    eventsSeen = row?.latest ?? eventsSeen;
    return Number(row?.relevant) === 1;
  });

  /** Whether a folder outside the homes that the last sweep read, or its Claude Code tasks, changed since the last look. */
  const foldersChanged = Effect.gen(function* () {
    const looks = yield* Effect.forEach(outsideFolders, (folder) =>
      Effect.all([
        fileSystem.stat(folder).pipe(
          Effect.map((info) => info.type),
          Effect.orElseSucceed(() => "missing"),
        ),
        fileSystem.stat(path.join(folder, ".claude", "scheduled_tasks.json")).pipe(
          Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`),
          Effect.orElseSucceed(() => "missing"),
        ),
      ]).pipe(Effect.map((parts) => [folder, ...parts].join("\0"))),
    );
    const key = looks.join("\n");
    const changed = key !== outsideKey;
    outsideKey = key;
    return changed;
  });

  const syncIfChanged: NativeAgentSync["Service"]["syncIfChanged"] = Effect.gen(function* () {
    const current = yield* settings.getSettings.pipe(Effect.option);
    if (Option.isSome(current) && !current.value.tempoNativeAgentSync) return null;
    if (yield* watchHomes) {
      // Both look every time, so each next look starts from this one.
      const [events, folders] = yield* Effect.all([tempoChanged, foldersChanged]).pipe(
        Effect.orElseSucceed(() => [true, true] as const),
      );
      const sinceSweep = (yield* Clock.currentTimeMillis) - sweptAt;
      if (!unswept && !events && !folders && sinceSweep < UNCHANGED_SWEEP_MS) return null;
    }
    return yield* syncNow;
  });

  const start: NativeAgentSync["Service"]["start"] = Effect.fn("NativeAgentSync.start")(
    function* () {
      const changes = yield* settings.subscribeChanges;
      let enabled = (yield* settings.getSettings.pipe(Effect.orDie)).tempoNativeAgentSync;
      // Back to back while work is left, else a look each minute.
      yield* forkParked(
        syncIfChanged.pipe(
          Effect.flatMap((result) =>
            Effect.sleep(result?.pending ? BACKLOG_DELAY : SWEEP_INTERVAL),
          ),
          Effect.forever,
        ),
      );
      yield* forkParked(
        Stream.runForEach(changes, (next) => {
          const turnedOn = next.tempoNativeAgentSync && !enabled;
          enabled = next.tempoNativeAgentSync;
          // Settings choose which homes a sweep reads.
          unswept = true;
          return turnedOn ? syncNow.pipe(Effect.asVoid) : Effect.void;
        }),
      );
    },
  );

  return NativeAgentSync.of({ syncNow, syncIfChanged, start });
});

export const layer = Layer.effect(NativeAgentSync, make).pipe(
  Layer.provide(ProviderSessionRuntime.layer),
);
