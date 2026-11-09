import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ThreadManagement from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as AgentSessionImporter from "../../project/AgentSessionImporter.ts";
import * as AgentSessionScanner from "../../project/AgentSessionScanner.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import * as NativeAgentSync from "./NativeAgentSync.ts";

const CLAUDE_A = "0697f99c-0e22-406f-9d0a-7a07cf6b5ecc";
const CLAUDE_B = "5b1c0e7e-2f43-4d55-9a3e-0b8f2c6d7e11";
const CLAUDE_SDK = "9a7d3b2c-1e4f-4a5b-8c6d-7e8f9a0b1c2d";
const CLAUDE_RELEASED = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f";
const CLAUDE_AGED = "6d7e8f90-1a2b-4c3d-9e4f-5a6b7c8d9e0f";
const CODEX_A = "01a113df-9b3d-7660-8f79-fb7e6a45e63b";
const CODEX_T3 = "01a113e0-2562-79e2-a298-35c5f8c045ea";
const CODEX_ARCHIVED = "01a11400-0000-7000-8000-000000000001";
const CODEX_SUBAGENT = "01a11400-0000-7000-8000-000000000002";
const CLAUDE_WORKTREE = "7e8f9a0b-1c2d-4e3f-8a4b-5c6d7e8f9a0b";
const CODEX_WORKTREE = "01a11400-0000-7000-8000-000000000005";
const CODEX_HOME_FOLDER = "01a11400-0000-7000-8000-000000000006";
const CODEX_CHAT = "01a11400-0000-7000-8000-000000000007";
const CLAUDE_NEW = "8e9f0a1b-2c3d-4e5f-9a6b-7c8d9e0f1a2b";
const CLAUDE_TEMPO_FORK = "9f0a1b2c-3d4e-4f5a-8b6c-7d8e9f0a1b2c";
const CODEX_TEMPO_OWN = "01a11400-0000-7000-8000-000000000008";

const claudeThread = (id: string) => ThreadId.make(`import:claudeAgent:${id}`);
const codexThread = (id: string) => ThreadId.make(`import:codex:${id}`);

/** An hour ago: quiet enough to refresh, and far younger than Claude Code's cleanup age. */
const settled = DateTime.now.pipe(
  Effect.map((now) => DateTime.toDateUtc(DateTime.subtract(now, { hours: 1 }))),
);
/** Older than Claude Code keeps an idle session. */
const AGED = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"));
const iso = (minute: number) => `2026-10-01T10:${String(minute).padStart(2, "0")}:00.000Z`;

const claudeLine = (input: {
  readonly type: "user" | "assistant";
  readonly text: string;
  readonly sessionId: string;
  readonly cwd: string;
  readonly minute: number;
  readonly entrypoint?: string;
}) =>
  JSON.stringify({
    type: input.type,
    sessionId: input.sessionId,
    cwd: input.cwd,
    entrypoint: input.entrypoint ?? "cli",
    isSidechain: false,
    timestamp: iso(input.minute),
    message: { role: input.type, content: input.text },
  });

const codexLines = (input: {
  readonly id: string;
  readonly cwd: string;
  readonly originator?: string;
  readonly source?: unknown;
  readonly turns: ReadonlyArray<readonly [user: string, assistant: string]>;
}) => [
  JSON.stringify({
    timestamp: iso(0),
    type: "session_meta",
    payload: {
      id: input.id,
      cwd: input.cwd,
      originator: input.originator ?? "codex_cli_rs",
      source: input.source ?? "cli",
      cli_version: "0.162.1",
    },
  }),
  ...input.turns.flatMap(([user, assistant], index) => [
    JSON.stringify({
      timestamp: iso(index * 2 + 1),
      type: "event_msg",
      payload: { type: "user_message", message: user },
    }),
    JSON.stringify({
      timestamp: iso(index * 2 + 2),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: assistant }],
      },
    }),
  ]),
];

/** A transcript, last written an hour ago unless `at` says otherwise. */
const writeLines = (file: string, lines: ReadonlyArray<string>, at?: Date) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    yield* fileSystem.writeFileString(file, `${lines.join("\n")}\n`);
    const mtime = at ?? (yield* settled);
    yield* fileSystem.utimes(file, mtime, mtime);
  });

/** Makes `repo` a repository with a linked worktree at `worktree`, as `git worktree add` does. */
const addWorktree = (input: {
  readonly repo: string;
  readonly worktree: string;
  readonly head: string;
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const admin = path.join(input.repo, ".git", "worktrees", path.basename(input.worktree));
    yield* fileSystem.makeDirectory(admin, { recursive: true });
    yield* fileSystem.makeDirectory(input.worktree, { recursive: true });
    const pointer = path.join(input.worktree, ".git");
    yield* fileSystem.writeFileString(pointer, `gitdir: ${admin}\n`);
    yield* fileSystem.writeFileString(path.join(admin, "gitdir"), `${pointer}\n`);
    yield* fileSystem.writeFileString(path.join(admin, "commondir"), "../..\n");
    yield* fileSystem.writeFileString(path.join(admin, "HEAD"), `${input.head}\n`);
  });

interface Machine {
  readonly home: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly claudeProjectsA: string;
  readonly codexHome: string;
  readonly codexDatabase: string;
  readonly rollout: (id: string) => string;
}

/**
 * One person's machine: Claude Code sessions in repo A, Codex threads in repo
 * B, and the kinds of native threads that must stay out.
 */
const setUpMachine = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-native-sync-machine-" });
  const home = path.join(root, "home");
  const repoA = path.join(root, "work", "repo-a");
  const repoB = path.join(root, "work", "repo-b");
  const claudeProjectsA = path.join(
    home,
    ".claude",
    "projects",
    repoA.replace(/[^a-zA-Z0-9]/g, "-"),
  );
  const codexHome = path.join(home, ".codex");
  const dayDir = path.join(codexHome, "sessions", "2026", "10", "01");
  const rollout = (id: string) => path.join(dayDir, `rollout-2026-10-01T10-00-00-${id}.jsonl`);
  for (const directory of [repoA, repoB, claudeProjectsA, dayDir]) {
    yield* fileSystem.makeDirectory(directory, { recursive: true });
  }
  const claude = (
    sessionId: string,
    texts: ReadonlyArray<string>,
    options: { readonly entrypoint?: string; readonly at?: Date } = {},
  ) =>
    writeLines(
      path.join(claudeProjectsA, `${sessionId}.jsonl`),
      texts.map((text, index) =>
        claudeLine({
          type: index % 2 === 0 ? "user" : "assistant",
          text,
          sessionId,
          cwd: repoA,
          minute: index,
          ...(options.entrypoint === undefined ? {} : { entrypoint: options.entrypoint }),
        }),
      ),
      options.at,
    );
  yield* claude(CLAUDE_A, ["Fix the flaky test", "Fixed it"]);
  yield* claude(CLAUDE_B, ["Write the changelog", "Written"]);
  // Idle for longer than Claude Code keeps a session.
  yield* claude(CLAUDE_AGED, ["An old question", "An old answer"], { at: AGED });
  // Another app's SDK session (Tempo and T3 Code run Claude this way).
  yield* claude(CLAUDE_SDK, ["From another app", "Hello"], { entrypoint: "sdk-ts" });
  // Claude Desktop archived this one.
  yield* claude(CLAUDE_RELEASED, ["Archived in Desktop", "Ok"]);
  yield* fileSystem.writeFileString(
    path.join(claudeProjectsA, `${CLAUDE_RELEASED}.desktop-released.json`),
    JSON.stringify({ reason: "archive" }),
  );

  yield* writeLines(
    rollout(CODEX_A),
    codexLines({ id: CODEX_A, cwd: repoB, turns: [["Add the migration", "Added"]] }),
  );
  yield* writeLines(
    rollout(CODEX_T3),
    codexLines({
      id: CODEX_T3,
      cwd: repoB,
      originator: "T3 Code",
      source: "vscode",
      turns: [["Tempo's own", "Yes"]],
    }),
  );
  yield* writeLines(
    rollout(CODEX_SUBAGENT),
    codexLines({
      id: CODEX_SUBAGENT,
      cwd: repoB,
      source: { subagent: { thread_spawn: { parent_thread_id: CODEX_A, depth: 1 } } },
      turns: [["Sub-agent task", "Done"]],
    }),
  );
  const archivedDir = path.join(codexHome, "archived_sessions");
  yield* fileSystem.makeDirectory(archivedDir, { recursive: true });
  const archivedRollout = path.join(
    archivedDir,
    `rollout-2026-10-01T09-00-00-${CODEX_ARCHIVED}.jsonl`,
  );
  yield* writeLines(
    archivedRollout,
    codexLines({ id: CODEX_ARCHIVED, cwd: repoB, turns: [["Archived in Codex", "Ok"]] }),
  );

  const codexDatabase = path.join(codexHome, "state_5.sqlite");
  const database = new NodeSqlite.DatabaseSync(codexDatabase);
  database.exec(
    "CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0, name TEXT, source TEXT NOT NULL, thread_source TEXT, originator TEXT)",
  );
  const insert = database.prepare(
    "INSERT INTO threads (id, rollout_path, archived, name, source, thread_source, originator) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insert.run(CODEX_A, rollout(CODEX_A), 0, "Migration work", "cli", "user", "codex_cli_rs");
  insert.run(CODEX_T3, rollout(CODEX_T3), 0, null, "vscode", null, "T3 Code");
  insert.run(CODEX_ARCHIVED, archivedRollout, 1, null, "cli", "user", "codex_cli_rs");
  database.close();

  return {
    home,
    repoA,
    repoB,
    claudeProjectsA,
    codexHome,
    codexDatabase,
    rollout,
  } satisfies Machine;
});

/** The native files' bytes and modification times: the sync must never change them. */
const nativeFingerprint = (machine: Machine) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const files = [
      ...(yield* fileSystem.readDirectory(machine.claudeProjectsA)).map((entry) =>
        path.join(machine.claudeProjectsA, entry),
      ),
      machine.rollout(CODEX_A),
      machine.codexDatabase,
    ];
    return yield* Effect.forEach(files.toSorted(), (file) =>
      Effect.gen(function* () {
        const info = yield* fileSystem.stat(file);
        const digest = yield* crypto.digest("SHA-256", yield* fileSystem.readFile(file));
        return `${file} ${Hex.encode(digest)} ${Option.getOrUndefined(info.mtime)?.getTime()}`;
      }),
    );
  });

const appendLines = (file: string, lines: ReadonlyArray<string>, at?: Date) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const current = yield* fileSystem.readFileString(file);
    yield* fileSystem.writeFileString(file, `${current}${lines.join("\n")}\n`);
    const mtime = at ?? (yield* settled);
    yield* fileSystem.utimes(file, mtime, mtime);
  });

/**
 * File watches the test drives: each is ready as it starts, and `change`
 * reports `name` changing in a watched folder, as the watch names it (an entry
 * of the folder, or a path under one watched whole), returning once its watcher
 * took it.
 */
const makeWatches = Effect.gen(function* () {
  const queues = new Map<string, Queue.Queue<FileSystem.WatchEvent>>();
  const taken = yield* Queue.unbounded<void>();
  const backend = FileSystem.WatchBackend.of({
    register: (folder, _info, options) =>
      Option.some(
        Stream.unwrap(
          Effect.gen(function* () {
            const queue = yield* Queue.unbounded<FileSystem.WatchEvent>();
            queues.set(folder, queue);
            options?.onReady?.();
            let first = true;
            // Each pull after the first means the watcher handled the change before it.
            return Stream.fromEffectRepeat(
              Effect.suspend(() => {
                const handled = first ? Effect.void : Queue.offer(taken, undefined);
                first = false;
                return handled.pipe(Effect.andThen(Queue.take(queue)));
              }),
            );
          }),
        ),
      ),
  });
  const change = (folder: string, name: string) =>
    Effect.gen(function* () {
      const queue = queues.get(folder);
      if (queue === undefined) return yield* Effect.die(new Error(`${folder} is not watched`));
      yield* Queue.offer(queue, { _tag: "Update", path: name });
      yield* Queue.take(taken);
    });
  return { backend, change, watched: () => [...queues.keys()].toSorted() };
});

/** A host on `platform`, whose native homes' watches the test drives. */
interface Host {
  readonly platform: NodeJS.Platform;
  readonly watches: Effect.Success<typeof makeWatches>;
}

/** The watches on what a sweep reads in `machine`'s homes, while it has no automations or Codex app database. */
const homeWatches = (machine: Machine, path: Path.Path, homes: ReadonlyArray<"claude" | "codex">) =>
  homes
    .flatMap((home) =>
      home === "claude"
        ? [path.join(machine.home, ".claude"), path.join(machine.home, ".claude", "projects")]
        : [
            machine.codexHome,
            path.join(machine.codexHome, "archived_sessions"),
            path.join(machine.codexHome, "sessions"),
          ],
    )
    .toSorted();

// Tempo's side: its own database and projections, the real importer and scanner,
// and stand-ins for the orchestrator's thread commands and the scheduler that
// apply what they are asked to the same projections.
const layerOrchestratorReads = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectionError = (threadId: ThreadId) => (cause: unknown) =>
      new Orchestrator.OrchestratorProjectionError({ threadId, cause });
    return Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) =>
        projections.getThreadShell(threadId).pipe(Effect.mapError(projectionError(threadId))),
      getThreadRecords: (threadId, fields) =>
        projections
          .getThreadRecords(threadId, fields)
          .pipe(Effect.mapError(projectionError(threadId))),
      getThreadProjection: (threadId) =>
        projections.getThreadProjection(threadId).pipe(Effect.mapError(projectionError(threadId))),
    });
  }),
);

const layerThreadManagement = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sink = yield* EventSink.EventSinkV2;
    let sequence = 0;
    const apply = (
      type: "thread.archived" | "thread.unarchived" | "thread.metadata-updated",
      threadId: ThreadId,
      change: (now: DateTime.Utc) => Record<string, unknown>,
    ) =>
      Effect.gen(function* () {
        const { thread } = yield* projections.getThreadRecords(threadId, []);
        const now = yield* DateTime.now;
        const payload = { ...thread, ...change(now), updatedAt: now };
        sequence += 1;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`test:lifecycle:${sequence}`),
              type,
              threadId,
              occurredAt: now,
              payload,
            },
          ],
        });
        return { sequence, storedEvents: [] };
      }).pipe(Effect.orDie);
    return Layer.mock(ThreadManagement.ThreadManagementService)({
      dispatch: (command) => {
        switch (command.type) {
          case "thread.archive":
            return apply("thread.archived", command.threadId, (now) => ({ archivedAt: now }));
          case "thread.unarchive":
            return apply("thread.unarchived", command.threadId, () => ({ archivedAt: null }));
          case "thread.metadata.update":
            return apply("thread.metadata-updated", command.threadId, () =>
              command.title === undefined ? {} : { title: command.title },
            );
          default:
            return Effect.die(new Error(`Native sync does not dispatch ${command.type}.`));
        }
      },
    });
  }),
);

/** The scheduler's list, upsert, toggle and delete, over a map. */
const layerScheduledTasks = Layer.unwrap(
  Effect.sync(() => {
    const tasks = new Map<string, ScheduledTask>();
    const at = "2026-10-01T10:00:00.000Z";
    return Layer.mock(ScheduledTaskService.ScheduledTaskService)({
      list: () => Effect.sync(() => ({ tasks: [...tasks.values()] })),
      upsert: (input) =>
        Effect.sync(() => {
          const id = input.id ?? ScheduledTaskId.make(`scheduled-task:${tasks.size}`);
          const existing = tasks.get(id);
          const task: ScheduledTask = {
            id,
            title: input.title,
            prompt: input.prompt,
            enabled: input.enabled,
            schedule:
              input.schedule.type === "webhook"
                ? { type: "webhook", signature: null }
                : input.schedule,
            projectId: input.projectId,
            threadId: input.threadId ?? null,
            workspaceStrategy: input.workspaceStrategy,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            createdBy: existing?.createdBy ?? input.createdBy ?? "user",
            creationSource: input.creationSource ?? "web",
            createdAt: existing?.createdAt ?? at,
            updatedAt: at,
            nextRunAt: null,
            lastRunAt: null,
            lastRunStatus: "never",
            lastRunError: null,
            runCount: 0,
          };
          tasks.set(id, task);
          return { task };
        }),
      setEnabled: (input) =>
        Effect.sync(() => {
          const task = { ...tasks.get(input.id)!, enabled: input.enabled };
          tasks.set(input.id, task);
          return { task };
        }),
      delete: (input) =>
        Effect.sync(() => {
          tasks.delete(input.id);
          return { id: input.id };
        }),
    });
  }),
);

const layerProjectMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
    invalidate: () => Effect.void,
  }),
);

const layerFor = (machine: Machine) =>
  NativeAgentSync.layer.pipe(
    Layer.provideMerge(
      AgentSessionImporter.layer.pipe(Layer.provideMerge(AgentSessionScanner.layer)),
    ),
    Layer.provideMerge(
      Layer.mergeAll(
        layerOrchestratorReads,
        layerThreadManagement,
        layerScheduledTasks,
        RuntimeLayer.layerProjectService,
        ProviderSessionRuntime.layer,
        IdAllocator.layer,
      ),
    ),
    Layer.provideMerge(RuntimeLayer.layerEventSink),
    Layer.provideMerge(Layer.mergeAll(ProjectionStore.layer, ProjectStore.layer)),
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(layerProjectMetadata),
    Layer.provideMerge(SqlitePersistence.layerMemory),
    Layer.provideMerge(ServerSettings.layerTest()),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-native-sync-" })),
    // This machine's own home: no CODEX_HOME or CLAUDE_CONFIG_DIR, so ~/.codex and ~/.claude.
    Layer.provideMerge(Layer.succeed(HostProcess.HomeDirectory, machine.home)),
    Layer.provideMerge(Layer.succeed(HostProcess.Environment, {})),
  );

/** Runs `body` against a fresh Tempo on `machine`, on `host` when given. */
const onTempo = <A, E>(
  machine: Machine,
  body: Effect.Effect<
    A,
    E,
    | NativeAgentSync.NativeAgentSync
    | Orchestrator.OrchestratorV2
    | ProjectService.ProjectService
    | ScheduledTaskService.ScheduledTaskService
    | ThreadManagement.ThreadManagementService
    | ServerSettings.ServerSettingsService
    | ServerConfig.ServerConfig
    | SqlClient.SqlClient
    | FileSystem.FileSystem
    | Path.Path
  >,
  host?: Host,
) =>
  body.pipe(
    Effect.provide(
      host === undefined
        ? layerFor(machine)
        : layerFor(machine).pipe(
            Layer.provideMerge(
              Layer.merge(
                Layer.succeed(FileSystem.WatchBackend, host.watches.backend),
                Layer.succeed(HostProcess.Platform, host.platform),
              ),
            ),
          ),
    ),
  );

/** The minute loop's looks until one skips, as on a machine where nothing more changes. */
const settle = Effect.gen(function* () {
  const sync = yield* NativeAgentSync.NativeAgentSync;
  for (let look = 0; look < 5; look += 1) {
    if ((yield* sync.syncIfChanged) === null) return;
  }
  assert.fail("every look swept");
});

const messagesOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
    return messages.map((message) => message.text);
  });

const shellOf = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.getThreadShell(threadId);
  });

/** Tempo continuing a thread is a run on it. */
const continueInTempo = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_thread_id, status, requested_at, completed_at, payload_json)
      VALUES (${`run:${threadId}`}, ${threadId}, 1, 'claudeAgent', NULL, 'completed', ${iso(30)}, ${iso(31)}, '{}')
    `;
  });

describe("NativeAgentSync", () => {
  it.live(
    "imports the person's active threads into their folders' projects, leaves the rest out, and changes nothing a second time",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const before = yield* nativeFingerprint(machine);
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            const projects = yield* ProjectService.ProjectService;
            const first = yield* sync.syncNow;
            assert.equal(first.imported, 4);
            assert.isFalse(first.pending);

            const projectA = Option.getOrThrow(yield* projects.getByWorkspaceRoot(machine.repoA));
            const projectB = Option.getOrThrow(yield* projects.getByWorkspaceRoot(machine.repoB));
            assert.equal(projectA.title, "repo-a");
            assert.equal(projectB.title, "repo-b");

            const claude = yield* shellOf(claudeThread(CLAUDE_A));
            assert.equal(claude?.projectId, projectA.id);
            assert.equal(claude?.historyOrigin, "v1_import");
            assert.deepEqual(yield* messagesOf(claudeThread(CLAUDE_A)), [
              "Fix the flaky test",
              "Fixed it",
            ]);
            const codex = yield* shellOf(codexThread(CODEX_A));
            assert.equal(codex?.projectId, projectB.id);
            // The Codex app's own name for the thread.
            assert.equal(codex?.title, "Migration work");
            assert.isNotNull(yield* shellOf(claudeThread(CLAUDE_B)));

            // Another app's sessions, an archived or released one and a sub-agent stay out.
            for (const threadId of [
              claudeThread(CLAUDE_SDK),
              claudeThread(CLAUDE_RELEASED),
              codexThread(CODEX_T3),
              codexThread(CODEX_ARCHIVED),
              codexThread(CODEX_SUBAGENT),
            ]) {
              assert.isNull(yield* shellOf(threadId), threadId);
            }

            const second = yield* sync.syncNow;
            assert.deepEqual(
              [second.imported, second.refreshed, second.archived, second.unarchived],
              [0, 0, 0, 0],
            );
            assert.deepEqual(yield* messagesOf(claudeThread(CLAUDE_A)), [
              "Fix the flaky test",
              "Fixed it",
            ]);
          }),
        );
        assert.deepEqual(yield* nativeFingerprint(machine), before);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "never lists Tempo's own threads from a home it shares with the native apps, nor hundreds of other sessions",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const path = yield* Path.Path;
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            const sql = yield* SqlClient.SqlClient;
            assert.equal((yield* sync.syncNow).imported, 4);
            const threadsBefore =
              yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`;

            // What sharing the folder adds: every transcript Tempo itself wrote, carried over or new.
            const tempoSessions = Array.from(
              { length: 300 },
              (_, index) => `a0000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
            );
            for (const sessionId of tempoSessions) {
              yield* writeLines(path.join(machine.claudeProjectsA, `${sessionId}.jsonl`), [
                claudeLine({
                  type: "user",
                  text: "A thread Tempo runs",
                  sessionId,
                  cwd: machine.repoA,
                  minute: 1,
                  entrypoint: "sdk-ts",
                }),
              ]);
            }
            // A fork of a Claude Desktop session starts with that session's lines, so only Tempo's
            // record of it tells it apart from a thread the person started in Claude Desktop.
            yield* writeLines(path.join(machine.claudeProjectsA, `${CLAUDE_TEMPO_FORK}.jsonl`), [
              claudeLine({
                type: "user",
                text: "Forked here from Claude Desktop",
                sessionId: CLAUDE_TEMPO_FORK,
                cwd: machine.repoA,
                minute: 1,
                entrypoint: "claude-desktop",
              }),
            ]);
            // Codex's database can list a thread Tempo runs as if it were the person's own.
            yield* writeLines(
              machine.rollout(CODEX_TEMPO_OWN),
              codexLines({
                id: CODEX_TEMPO_OWN,
                cwd: machine.repoB,
                turns: [["Tempo's Codex", "Yes"]],
              }),
            );
            const codexDatabase = new NodeSqlite.DatabaseSync(machine.codexDatabase);
            codexDatabase
              .prepare(
                "INSERT INTO threads (id, rollout_path, archived, name, source, thread_source, originator) VALUES (?, ?, 0, NULL, 'vscode', NULL, NULL)",
              )
              .run(CODEX_TEMPO_OWN, machine.rollout(CODEX_TEMPO_OWN));
            codexDatabase.close();
            for (const nativeId of [CLAUDE_TEMPO_FORK, CODEX_TEMPO_OWN]) {
              yield* sql`
                INSERT INTO orchestration_v2_projection_provider_threads
                  (provider_thread_id, thread_id, provider, status, updated_at, payload_json)
                VALUES (
                  ${`provider-thread:${nativeId}`}, ${`thread:${nativeId}`}, 'claudeAgent', 'idle',
                  ${iso(30)}, ${JSON.stringify({ nativeThreadRef: { nativeId } })}
                )
              `;
            }

            const next = yield* sync.syncNow;
            assert.equal(next.imported, 0);
            assert.isFalse(next.pending);
            assert.isNull(yield* shellOf(claudeThread(CLAUDE_TEMPO_FORK)));
            assert.isNull(yield* shellOf(codexThread(CODEX_TEMPO_OWN)));
            assert.deepEqual(
              yield* sql`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`,
              threadsBefore,
            );

            // The person's own new session still arrives.
            yield* writeLines(path.join(machine.claudeProjectsA, `${CLAUDE_NEW}.jsonl`), [
              claudeLine({
                type: "user",
                text: "Started in the terminal",
                sessionId: CLAUDE_NEW,
                cwd: machine.repoA,
                minute: 1,
              }),
            ]);
            assert.equal((yield* sync.syncNow).imported, 1);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "brings threads from a linked worktree into its repository's project, in the worktree, and leaves threads started in the home folder out",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        // The Codex app's own worktree of repo B, on a detached HEAD as the app leaves it.
        const codexWorktree = path.join(machine.codexHome, "worktrees", "4f2a", "repo-b");
        yield* addWorktree({
          repo: machine.repoB,
          worktree: codexWorktree,
          head: "0123456789abcdef0123456789abcdef01234567",
        });
        yield* writeLines(
          machine.rollout(CODEX_WORKTREE),
          codexLines({
            id: CODEX_WORKTREE,
            cwd: codexWorktree,
            turns: [["Try the new parser", "Tried"]],
          }),
        );
        // `claude --worktree` in repo A, on its own branch.
        const claudeWorktree = path.join(machine.repoA, ".claude", "worktrees", "flaky");
        yield* addWorktree({
          repo: machine.repoA,
          worktree: claudeWorktree,
          head: "ref: refs/heads/claude/flaky",
        });
        const claudeProjectsWorktree = path.join(
          machine.home,
          ".claude",
          "projects",
          claudeWorktree.replace(/[^a-zA-Z0-9]/g, "-"),
        );
        yield* fileSystem.makeDirectory(claudeProjectsWorktree, { recursive: true });
        yield* writeLines(
          path.join(claudeProjectsWorktree, `${CLAUDE_WORKTREE}.jsonl`),
          (["Deflake the suite", "Deflaked"] as const).map((text, index) =>
            claudeLine({
              type: index === 0 ? "user" : "assistant",
              text,
              sessionId: CLAUDE_WORKTREE,
              cwd: claudeWorktree,
              minute: index,
            }),
          ),
        );
        // Claude Code keeps that session's durable tasks in the worktree.
        yield* fileSystem.makeDirectory(path.join(claudeWorktree, ".claude"));
        yield* fileSystem.writeFileString(
          path.join(claudeWorktree, ".claude", "scheduled_tasks.json"),
          JSON.stringify({
            tasks: [
              {
                id: "5d6e7f80",
                cron: "*/30 * * * *",
                prompt: "Rerun the flaky suite",
                createdAt: 1_790_000_000_000,
                recurring: true,
                createdBySessionId: CLAUDE_WORKTREE,
              },
            ],
          }),
        );
        // Started in the home folder, and where the Codex app keeps chats without a project.
        const codexChats = path.join(machine.home, "Documents", "Codex", "2026-10-01");
        yield* fileSystem.makeDirectory(codexChats, { recursive: true });
        yield* writeLines(
          machine.rollout(CODEX_HOME_FOLDER),
          codexLines({
            id: CODEX_HOME_FOLDER,
            cwd: machine.home,
            turns: [["What is on my calendar?", "Nothing"]],
          }),
        );
        yield* writeLines(
          machine.rollout(CODEX_CHAT),
          codexLines({ id: CODEX_CHAT, cwd: codexChats, turns: [["Draft an email", "Drafted"]] }),
        );

        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            const projects = yield* ProjectService.ProjectService;
            const scheduler = yield* ScheduledTaskService.ScheduledTaskService;
            assert.equal((yield* sync.syncNow).imported, 6);
            const projectA = Option.getOrThrow(yield* projects.getByWorkspaceRoot(machine.repoA));
            const projectB = Option.getOrThrow(yield* projects.getByWorkspaceRoot(machine.repoB));

            const codex = yield* shellOf(codexThread(CODEX_WORKTREE));
            assert.equal(codex?.projectId, projectB.id);
            assert.equal(codex?.worktreePath, codexWorktree);
            assert.isNull(codex?.branch);
            const claude = yield* shellOf(claudeThread(CLAUDE_WORKTREE));
            assert.equal(claude?.projectId, projectA.id);
            assert.equal(claude?.worktreePath, claudeWorktree);
            assert.equal(claude?.branch, "claude/flaky");
            // A thread from the main checkout runs there.
            assert.isNull((yield* shellOf(codexThread(CODEX_A)))?.worktreePath);

            assert.isNull(yield* shellOf(codexThread(CODEX_HOME_FOLDER)));
            assert.isNull(yield* shellOf(codexThread(CODEX_CHAT)));
            for (const folder of [codexWorktree, claudeWorktree, machine.home, codexChats]) {
              assert.isTrue(Option.isNone(yield* projects.getByWorkspaceRoot(folder)), folder);
            }

            // The worktree session's task, paused, in its thread.
            const rerun = (yield* scheduler.list()).tasks.find(
              (task) => task.prompt === "Rerun the flaky suite",
            );
            assert.equal(rerun?.threadId, claudeThread(CLAUDE_WORKTREE));
            assert.equal(rerun?.projectId, projectA.id);
            assert.isFalse(rerun?.enabled);

            assert.equal((yield* sync.syncNow).imported, 0);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "adds a native thread's new messages unless Tempo has continued it, and follows a native rename",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const path = yield* Path.Path;
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            yield* sync.syncNow;
            yield* continueInTempo(claudeThread(CLAUDE_B));
            const line = (
              sessionId: string,
              type: "user" | "assistant",
              text: string,
              minute: number,
            ) => claudeLine({ type, text, sessionId, cwd: machine.repoA, minute });
            yield* appendLines(path.join(machine.claudeProjectsA, `${CLAUDE_A}.jsonl`), [
              line(CLAUDE_A, "user", "Now the other one", 5),
              line(CLAUDE_A, "assistant", "Also fixed", 6),
              JSON.stringify({ type: "ai-title", sessionId: CLAUDE_A, aiTitle: "Flaky tests" }),
            ]);
            yield* appendLines(path.join(machine.claudeProjectsA, `${CLAUDE_B}.jsonl`), [
              line(CLAUDE_B, "user", "Native only", 5),
            ]);
            // A second turn: the new lines after the session's first.
            yield* appendLines(
              machine.rollout(CODEX_A),
              codexLines({
                id: CODEX_A,
                cwd: machine.repoB,
                turns: [["And the index", "Indexed"]],
              }).slice(1),
            );

            const result = yield* sync.syncNow;
            assert.equal(result.refreshed, 2);
            assert.deepEqual(yield* messagesOf(claudeThread(CLAUDE_A)), [
              "Fix the flaky test",
              "Fixed it",
              "Now the other one",
              "Also fixed",
            ]);
            assert.equal((yield* shellOf(claudeThread(CLAUDE_A)))?.title, "Flaky tests");
            assert.deepEqual(yield* messagesOf(codexThread(CODEX_A)), [
              "Add the migration",
              "Added",
              "And the index",
              "Indexed",
            ]);
            // Continued in Tempo: Tempo's copy wins.
            assert.deepEqual(yield* messagesOf(claudeThread(CLAUDE_B)), [
              "Write the changelog",
              "Written",
            ]);

            const again = yield* sync.syncNow;
            assert.equal(again.refreshed, 0);
            assert.lengthOf(yield* messagesOf(claudeThread(CLAUDE_A)), 4);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "archives a thread archived or deleted natively, unarchives it when it comes back, and leaves continued threads and the person's own unarchive alone",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            const threadManagement = yield* ThreadManagement.ThreadManagementService;
            yield* sync.syncNow;
            yield* continueInTempo(claudeThread(CLAUDE_B));
            const transcriptA = path.join(machine.claudeProjectsA, `${CLAUDE_A}.jsonl`);
            const savedA = yield* fileSystem.readFileString(transcriptA);
            yield* fileSystem.remove(transcriptA);
            yield* fileSystem.remove(path.join(machine.claudeProjectsA, `${CLAUDE_B}.jsonl`));
            // Claude Code's own cleanup of an idle session, not the person deleting it.
            yield* fileSystem.remove(path.join(machine.claudeProjectsA, `${CLAUDE_AGED}.jsonl`));
            // Codex archives: the rollout moves to archived_sessions and its row is flagged.
            const archivedRollout = path.join(
              machine.codexHome,
              "archived_sessions",
              path.basename(machine.rollout(CODEX_A)),
            );
            yield* fileSystem.rename(machine.rollout(CODEX_A), archivedRollout);
            const database = new NodeSqlite.DatabaseSync(machine.codexDatabase);
            database
              .prepare("UPDATE threads SET archived = 1, rollout_path = ? WHERE id = ?")
              .run(archivedRollout, CODEX_A);
            database.close();

            const archived = yield* sync.syncNow;
            assert.equal(archived.archived, 2);
            assert.isNotNull((yield* shellOf(claudeThread(CLAUDE_A)))?.archivedAt);
            assert.isNotNull((yield* shellOf(codexThread(CODEX_A)))?.archivedAt);
            assert.isNull((yield* shellOf(claudeThread(CLAUDE_B)))?.archivedAt);
            assert.isNull((yield* shellOf(claudeThread(CLAUDE_AGED)))?.archivedAt);
            assert.equal((yield* sync.syncNow).archived, 0);

            // The person brings the Codex thread back here; the sync leaves it.
            yield* threadManagement.dispatch({
              type: "thread.unarchive",
              commandId: CommandId.make("test:unarchive"),
              threadId: codexThread(CODEX_A),
            });
            assert.equal((yield* sync.syncNow).archived, 0);
            assert.isNull((yield* shellOf(codexThread(CODEX_A)))?.archivedAt);

            // The Claude session comes back natively.
            yield* fileSystem.writeFileString(transcriptA, savedA);
            const restored = yield* sync.syncNow;
            assert.equal(restored.unarchived, 1);
            assert.isNull((yield* shellOf(claudeThread(CLAUDE_A)))?.archivedAt);
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "imports scheduled tasks paused, follows native edits without turning them on or off, and removes untouched ones the native app deleted",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const claudeTasks = path.join(machine.repoA, ".claude", "scheduled_tasks.json");
        const writeClaudeTasks = (tasks: ReadonlyArray<Record<string, unknown>>) =>
          fileSystem
            .makeDirectory(path.dirname(claudeTasks), { recursive: true })
            .pipe(
              Effect.andThen(fileSystem.writeFileString(claudeTasks, JSON.stringify({ tasks }))),
            );
        const standup = {
          id: "3f9c1a2b",
          cron: "0 9 * * 1-5",
          prompt: "Post the standup",
          createdAt: 1_790_000_000_000,
          recurring: true,
          createdBySessionId: CLAUDE_A,
        };
        const monthly = {
          id: "7e2a9c41",
          cron: "30 14 28 2 *",
          prompt: "Renew the certificate",
          createdAt: 1_790_000_000_000,
          recurring: true,
        };
        const reminder = { id: "11aa22bb", cron: "0 17 1 11 *", prompt: "One-off", createdAt: 1 };
        yield* writeClaudeTasks([standup, monthly, reminder]);
        const automations = path.join(machine.codexHome, "automations");
        yield* fileSystem.makeDirectory(path.join(automations, "weekly-review"), {
          recursive: true,
        });
        yield* fileSystem.writeFileString(
          path.join(automations, "weekly-review", "automation.toml"),
          [
            "version = 1",
            'id = "weekly-review"',
            'kind = "cron"',
            'name = "Weekly review"',
            'prompt = "Review last week\\n\\nList the risky changes."',
            'status = "ACTIVE"',
            'rrule = "FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=8;BYMINUTE=30"',
            'execution_environment = "worktree"',
            `cwds = [${JSON.stringify(machine.repoB)}]`,
            "created_at = 1790000000000",
            "updated_at = 1790000000000",
          ].join("\n"),
        );
        yield* fileSystem.makeDirectory(path.join(automations, "check-in"), { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(automations, "check-in", "automation.toml"),
          [
            'id = "check-in"',
            'kind = "heartbeat"',
            'name = "Check in"',
            'prompt = "See whether CI passed"',
            'status = "PAUSED"',
            'rrule = "FREQ=HOURLY;INTERVAL=2"',
            `target_thread_id = "${CODEX_A}"`,
            "created_at = 1790000000000",
            "updated_at = 1790000000000",
          ].join("\n"),
        );

        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            const scheduler = yield* ScheduledTaskService.ScheduledTaskService;
            const projects = yield* ProjectService.ProjectService;
            const tasks = () => scheduler.list().pipe(Effect.map((result) => [...result.tasks]));
            const byPrompt = (list: ReadonlyArray<ScheduledTask>, prompt: string) =>
              list.find((task) => task.prompt.startsWith(prompt));

            const first = yield* sync.syncNow;
            assert.equal(first.scheduledTasks.created, 4);
            const created = yield* tasks();
            assert.lengthOf(created, 4);
            assert.isTrue(created.every((task) => !task.enabled));
            assert.isTrue(created.every((task) => task.createdBy === "system"));
            const projectA = Option.getOrThrow(yield* projects.getByWorkspaceRoot(machine.repoA));
            const projectB = Option.getOrThrow(yield* projects.getByWorkspaceRoot(machine.repoB));

            const standupTask = byPrompt(created, "Post the standup")!;
            assert.equal(standupTask.threadId, claudeThread(CLAUDE_A));
            assert.equal(standupTask.projectId, projectA.id);
            assert.deepEqual(standupTask.schedule, {
              type: "fixed_time",
              timeOfDay: "09:00",
              weekdays: [1, 2, 3, 4, 5],
            });
            assert.equal(standupTask.title, "Post the standup (Claude Code)");
            // Tempo cannot run on a date: the nearest schedule, and the cron in the title.
            const monthlyTask = byPrompt(created, "Renew the certificate")!;
            assert.isNull(monthlyTask.threadId);
            assert.include(monthlyTask.title, "cron 30 14 28 2 *");
            const review = byPrompt(created, "Review last week")!;
            assert.equal(review.prompt, "Review last week\n\nList the risky changes.");
            assert.equal(review.title, "Weekly review (Codex)");
            assert.equal(review.projectId, projectB.id);
            assert.isNull(review.threadId);
            assert.equal(review.workspaceStrategy.type, "worktree");
            assert.deepEqual(review.schedule, {
              type: "fixed_time",
              timeOfDay: "08:30",
              weekdays: [1, 3],
            });
            const checkIn = byPrompt(created, "See whether CI passed")!;
            assert.equal(checkIn.threadId, codexThread(CODEX_A));
            assert.deepEqual(checkIn.schedule, { type: "interval", everyMs: 2 * 60 * 60_000 });

            // The person turns the standup on here and removes the review.
            yield* scheduler.setEnabled({ id: standupTask.id, enabled: true });
            yield* scheduler.delete({ id: review.id });
            assert.deepEqual(Object.values((yield* sync.syncNow).scheduledTasks), [0, 0, 0]);

            // The standup changes natively: it follows, and stays on.
            yield* writeClaudeTasks([{ ...standup, prompt: "Post the standup in #eng" }, monthly]);
            assert.equal((yield* sync.syncNow).scheduledTasks.updated, 1);
            const edited = byPrompt(yield* tasks(), "Post the standup")!;
            assert.equal(edited.prompt, "Post the standup in #eng");
            assert.isTrue(edited.enabled);
            assert.isUndefined(byPrompt(yield* tasks(), "Review last week"));

            // A file caught mid-write deletes nothing.
            yield* fileSystem.writeFileString(claudeTasks, '{"tasks": [');
            assert.equal((yield* sync.syncNow).scheduledTasks.removed, 0);
            assert.lengthOf(yield* tasks(), 3);

            // Both Claude tasks are deleted natively: the untouched one goes, the one on stays.
            yield* writeClaudeTasks([]);
            assert.equal((yield* sync.syncNow).scheduledTasks.removed, 1);
            const remaining = yield* tasks();
            assert.isDefined(byPrompt(remaining, "Post the standup in #eng"));
            assert.isUndefined(byPrompt(remaining, "Renew the certificate"));
          }),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("changes nothing while its state cannot be read", () =>
    Effect.gen(function* () {
      const machine = yield* setUpMachine;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* onTempo(
        machine,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const statePath = path.join(config.stateDir, "native-agent-sync.json");
          yield* fileSystem.makeDirectory(config.stateDir, { recursive: true });
          yield* fileSystem.writeFileString(statePath, "{ not json");
          const sync = yield* NativeAgentSync.NativeAgentSync;
          assert.equal((yield* sync.syncNow).imported, 0);
          assert.isNull(yield* shellOf(claudeThread(CLAUDE_A)));
          assert.equal(yield* fileSystem.readFileString(statePath), "{ not json");
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("does nothing while the setting is off", () =>
    Effect.gen(function* () {
      const machine = yield* setUpMachine;
      yield* onTempo(
        machine,
        Effect.gen(function* () {
          const settings = yield* ServerSettings.ServerSettingsService;
          yield* settings.updateSettings({ tempoNativeAgentSync: false });
          const sync = yield* NativeAgentSync.NativeAgentSync;
          const result = yield* sync.syncNow;
          assert.isFalse(result.enabled);
          assert.isNull(yield* sync.syncIfChanged);
          assert.isNull(yield* shellOf(claudeThread(CLAUDE_A)));
          assert.isTrue(
            Option.isNone(
              yield* (yield* ProjectService.ProjectService).getByWorkspaceRoot(machine.repoA),
            ),
          );
        }),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "on a Mac, sweeps a minute only when a native home, Tempo's projects or a project's Claude Code tasks changed",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const watches = yield* makeWatches;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const claudeHome = path.join(machine.home, ".claude");
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            const projects = yield* ProjectService.ProjectService;
            const scheduler = yield* ScheduledTaskService.ScheduledTaskService;
            assert.equal((yield* sync.syncIfChanged)?.imported, 4);
            yield* settle;
            assert.deepEqual(watches.watched(), homeWatches(machine, path, ["claude", "codex"]));

            // A new Claude Code session waits for its home's watch to report it.
            const session = path.join(
              path.basename(machine.claudeProjectsA),
              `${CLAUDE_NEW}.jsonl`,
            );
            yield* writeLines(path.join(machine.claudeProjectsA, `${CLAUDE_NEW}.jsonl`), [
              claudeLine({
                type: "user",
                text: "A new question",
                sessionId: CLAUDE_NEW,
                cwd: machine.repoA,
                minute: 0,
              }),
            ]);
            assert.isNull(yield* sync.syncIfChanged);
            yield* watches.change(path.join(claudeHome, "projects"), session);
            assert.equal((yield* sync.syncIfChanged)?.imported, 1);
            assert.isNotNull(yield* shellOf(claudeThread(CLAUDE_NEW)));
            yield* settle;

            // A folder becomes a project here, and the Claude Code tasks kept in it arrive.
            const repoC = path.join(path.dirname(machine.repoA), "repo-c");
            const tasksFile = path.join(repoC, ".claude", "scheduled_tasks.json");
            const writeTasks = (prompt: string) =>
              fileSystem.writeFileString(
                tasksFile,
                JSON.stringify({
                  tasks: [
                    {
                      id: "9b8c7d6e",
                      cron: "0 8 * * *",
                      prompt,
                      createdAt: 1_790_000_000_000,
                      recurring: true,
                    },
                  ],
                }),
              );
            yield* fileSystem.makeDirectory(path.dirname(tasksFile), { recursive: true });
            yield* writeTasks("Check the nightly build");
            assert.isNull(yield* sync.syncIfChanged);
            yield* projects.create({
              commandId: CommandId.make("test:project:repo-c"),
              projectId: ProjectId.make("project-repo-c"),
              title: "repo-c",
              workspaceRoot: repoC,
            });
            assert.equal((yield* sync.syncIfChanged)?.scheduledTasks.created, 1);
            yield* settle;

            // The tasks changing there count too, though no native home changed.
            yield* writeTasks("Check the nightly build and the deploy");
            assert.equal((yield* sync.syncIfChanged)?.scheduledTasks.updated, 1);
            assert.isDefined(
              (yield* scheduler.list()).tasks.find(
                (task) => task.prompt === "Check the nightly build and the deploy",
              ),
            );
          }),
          { platform: "darwin", watches },
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "on a Mac, refreshes a session a minute after it was last written, and sweeps at least every 15 minutes",
    () =>
      Effect.gen(function* () {
        // Native files carry real modification times.
        yield* TestClock.setTime(yield* TestClock.withLive(Clock.currentTimeMillis));
        const machine = yield* setUpMachine;
        const watches = yield* makeWatches;
        const path = yield* Path.Path;
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            yield* settle;

            // Claude Code is still writing the session.
            yield* appendLines(
              path.join(machine.claudeProjectsA, `${CLAUDE_A}.jsonl`),
              [
                claudeLine({
                  type: "user",
                  text: "One more thing",
                  sessionId: CLAUDE_A,
                  cwd: machine.repoA,
                  minute: 5,
                }),
              ],
              DateTime.toDateUtc(yield* DateTime.now),
            );
            yield* watches.change(
              path.join(machine.home, ".claude", "projects"),
              path.join(path.basename(machine.claudeProjectsA), `${CLAUDE_A}.jsonl`),
            );
            assert.equal((yield* sync.syncIfChanged)?.refreshed, 0);
            // Once it has been quiet for a minute, the next look takes it up.
            yield* TestClock.adjust("1 minute");
            assert.equal((yield* sync.syncIfChanged)?.refreshed, 1);
            assert.deepEqual(yield* messagesOf(claudeThread(CLAUDE_A)), [
              "Fix the flaky test",
              "Fixed it",
              "One more thing",
            ]);
            yield* settle;

            yield* TestClock.adjust("14 minutes");
            assert.isNull(yield* sync.syncIfChanged);
            yield* TestClock.adjust("1 minute");
            assert.isNotNull(yield* sync.syncIfChanged);
          }),
          { platform: "darwin", watches },
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("watches a native home once it appears, and sweeps what it holds", () =>
    Effect.gen(function* () {
      const machine = yield* setUpMachine;
      const watches = yield* makeWatches;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const aside = `${machine.codexHome}-aside`;
      yield* fileSystem.rename(machine.codexHome, aside);
      yield* onTempo(
        machine,
        Effect.gen(function* () {
          const sync = yield* NativeAgentSync.NativeAgentSync;
          assert.equal((yield* sync.syncIfChanged)?.imported, 3);
          yield* settle;
          assert.deepEqual(watches.watched(), homeWatches(machine, path, ["claude"]));

          yield* fileSystem.rename(aside, machine.codexHome);
          assert.equal((yield* sync.syncIfChanged)?.imported, 1);
          assert.deepEqual(watches.watched(), homeWatches(machine, path, ["claude", "codex"]));
        }),
        { platform: "darwin", watches },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "on a Mac, watches only what a sweep reads in a native home, and a read folder once it appears",
    () =>
      Effect.gen(function* () {
        const machine = yield* setUpMachine;
        const watches = yield* makeWatches;
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const codexHome = machine.codexHome;
        const automation = path.join(codexHome, "automations", "nightly", "automation.toml");
        const writeAutomation = (prompt: string) =>
          fileSystem.writeFileString(
            automation,
            [
              'id = "nightly"',
              'kind = "cron"',
              'name = "Nightly"',
              `prompt = "${prompt}"`,
              'status = "ACTIVE"',
              'rrule = "FREQ=DAILY;BYHOUR=2;BYMINUTE=0"',
              `cwds = [${JSON.stringify(machine.repoB)}]`,
            ].join("\n"),
          );
        yield* onTempo(
          machine,
          Effect.gen(function* () {
            const sync = yield* NativeAgentSync.NativeAgentSync;
            yield* settle;

            // The Codex app's own worktrees, logs and caches are no sweep's business.
            yield* fileSystem.makeDirectory(path.join(codexHome, "worktrees", "x"), {
              recursive: true,
            });
            yield* fileSystem.writeFileString(path.join(codexHome, "worktrees", "x", "a.js"), "1");
            for (const entry of ["worktrees", "logs_2.sqlite-wal", "state_5.sqlite-shm"]) {
              yield* watches.change(codexHome, entry);
            }
            assert.isNull(yield* sync.syncIfChanged);
            assert.deepEqual(watches.watched(), homeWatches(machine, path, ["claude", "codex"]));

            // A rollout written under sessions/, or Codex's state database, are.
            const rollout = path.relative(
              path.join(codexHome, "sessions"),
              machine.rollout(CODEX_A),
            );
            yield* watches.change(path.join(codexHome, "sessions"), rollout);
            assert.isNotNull(yield* sync.syncIfChanged);
            yield* settle;
            yield* watches.change(codexHome, "state_5.sqlite-wal");
            assert.isNotNull(yield* sync.syncIfChanged);
            yield* settle;

            // automations/ appearing is seen in the home, and watched from then on.
            yield* fileSystem.makeDirectory(path.dirname(automation), { recursive: true });
            yield* writeAutomation("Run the nightly checks");
            yield* watches.change(codexHome, "automations");
            assert.equal((yield* sync.syncIfChanged)?.scheduledTasks.created, 1);
            assert.include(watches.watched(), path.join(codexHome, "automations"));
            yield* settle;
            yield* writeAutomation("Run the nightly checks and report");
            yield* watches.change(path.join(codexHome, "automations"), "nightly/automation.toml");
            assert.equal((yield* sync.syncIfChanged)?.scheduledTasks.updated, 1);
          }),
          { platform: "darwin", watches },
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("sweeps every minute where it cannot watch the native homes", () =>
    Effect.gen(function* () {
      const machine = yield* setUpMachine;
      const watches = yield* makeWatches;
      const path = yield* Path.Path;
      yield* onTempo(
        machine,
        Effect.gen(function* () {
          const sync = yield* NativeAgentSync.NativeAgentSync;
          assert.equal((yield* sync.syncIfChanged)?.imported, 4);
          assert.isNotNull(yield* sync.syncIfChanged);
          yield* writeLines(path.join(machine.claudeProjectsA, `${CLAUDE_NEW}.jsonl`), [
            claudeLine({
              type: "user",
              text: "A new question",
              sessionId: CLAUDE_NEW,
              cwd: machine.repoA,
              minute: 0,
            }),
          ]);
          assert.equal((yield* sync.syncIfChanged)?.imported, 1);
          assert.deepEqual(watches.watched(), []);
        }),
        { platform: "linux", watches },
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
