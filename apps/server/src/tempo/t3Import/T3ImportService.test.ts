import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  TempoThreadMoveId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ChatAttachment,
  type TempoT3ImportRunProject,
  type TempoT3ImportScanProject,
  type TempoThreadMoveMessage,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as WorkspacePaths from "../../workspace/WorkspacePaths.ts";
import { buildMovedThreadEvents, movedThreadId } from "../threadMove/ThreadMoveThread.ts";
import * as T3ImportService from "./T3ImportService.ts";

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const archivedAt = DateTime.makeUnsafe("2026-10-02T09:00:00.000Z");
const iso = DateTime.formatIso(at);
/** When the snooze test imports: one wake time has passed by then, the other has not. */
const today = DateTime.makeUnsafe("2026-10-14T12:00:00.000Z");
const wokeAt = DateTime.makeUnsafe("2026-10-05T09:00:00.000Z");
const wakesAt = DateTime.makeUnsafe("2026-10-20T09:00:00.000Z");
const isoOrNull = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.formatIso(value);
const codex = ProviderInstanceId.make("codex");
const T3_ENVIRONMENT_ID = "t3-laptop-environment";

// The Tempo side: its own database, the real project service, and orchestrator
// reads straight from its projections, so the import sees exactly what it wrote.
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

const layerProjectMetadata = Layer.merge(
  Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, {
    resolve: () => Effect.succeed(null),
  }),
  Layer.succeed(ProjectFaviconResolver.ProjectFaviconResolver, {
    resolvePath: () => Effect.succeed(null),
    invalidate: () => Effect.void,
  }),
);

const layerTest = T3ImportService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerOrchestratorReads,
      RuntimeLayer.layerEventSink,
      RuntimeLayer.layerProjectService,
      // This machine has none of the imported threads' providers.
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.succeed([]),
      }),
    ),
  ),
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(ProjectEnrichmentService.layer),
  Layer.provideMerge(WorkspacePaths.layer),
  Layer.provideMerge(layerProjectMetadata),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-t3-import-" })),
  Layer.provideMerge(NodeServices.layer),
);

/**
 * T3 Code's own writer: this repo's migrations, pragmas and event sink on a
 * database file. Fresh, so it shares no memoized layer with the Tempo side.
 */
const layerT3Writer = (databasePath: string) => {
  const database = SqlitePersistence.layerFromPath(databasePath);
  const stores = Layer.mergeAll(
    EventStore.layer.pipe(Layer.provideMerge(database)),
    ProjectionStore.layer.pipe(Layer.provideMerge(database)),
  );
  return Layer.fresh(EventSink.layer.pipe(Layer.provideMerge(stores)));
};

function image(id: string): ChatAttachment {
  return { type: "image", id, name: "screen.png", mimeType: "image/png", sizeBytes: 3 };
}

function message(
  role: TempoThreadMoveMessage["role"],
  text: string,
  attachments: ReadonlyArray<ChatAttachment> = [],
): TempoThreadMoveMessage {
  return { role, text, attachments, createdAt: at, updatedAt: at };
}

/** A thread as T3 Code's database holds one, with its attachments under their own ids. */
function t3Thread(input: {
  readonly id: string;
  readonly projectId: string;
  readonly title?: string;
  readonly messages: ReadonlyArray<TempoThreadMoveMessage>;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly shell?: Partial<
    Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }>["payload"]
  >;
}): ReadonlyArray<OrchestrationV2DomainEvent> {
  const threadId = ThreadId.make(input.id);
  const events = buildMovedThreadEvents({
    eventPrefix: `t3-seed:${input.id}`,
    thread: {
      title: input.title ?? input.id,
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at,
    },
    messages: input.messages,
    threadId,
    projectId: ProjectId.make(input.projectId),
    branch: input.branch ?? null,
    worktreePath: input.worktreePath ?? null,
    movedFrom: {
      moveId: TempoThreadMoveId.make("seed"),
      environmentId: EnvironmentId.make("seed"),
      environmentLabel: "Seed",
      threadId,
      movedAt: iso,
    },
    now: at,
    pathMappings: [],
    attachmentIds: new Map(
      input.messages.flatMap((entry) =>
        entry.attachments.map((attachment) => [attachment.id, attachment.id] as const),
      ),
    ),
    lifecycle: { updatedAt: at, archivedAt: null, settledOverride: null, settledAt: null },
  });
  return events.map((event) =>
    event.type === "thread.created" && input.shell !== undefined
      ? { ...event, payload: { ...event.payload, ...input.shell } }
      : event,
  );
}

interface Machine {
  readonly userHome: string;
  readonly t3Home: string;
  readonly t3Database: string;
  readonly t3Attachments: string;
  readonly repoA: string;
  readonly repoB: string;
  readonly gone: string;
  readonly screenshotId: string;
}

/**
 * One machine with T3 Code on it: three projects (one whose folder is gone)
 * and threads in every state the import sorts by. T3 Code's server is off.
 */
const setUpT3 = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-t3-import-machine-" });
  const userHome = path.join(root, "home");
  const t3Home = path.join(userHome, ".t3");
  const machine: Machine = {
    userHome,
    t3Home,
    t3Database: path.join(t3Home, "userdata", "statev2.sqlite"),
    t3Attachments: path.join(t3Home, "userdata", "attachments"),
    repoA: path.join(root, "repo-a"),
    repoB: path.join(root, "repo-b"),
    gone: path.join(root, "gone"),
    screenshotId: "t3-thread-a1-00000000-0000-4000-8000-000000000001",
  };
  yield* fileSystem.makeDirectory(machine.repoA, { recursive: true });
  yield* fileSystem.makeDirectory(machine.repoB, { recursive: true });
  yield* fileSystem.makeDirectory(machine.t3Attachments, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(t3Home, "userdata", "environment-id"),
    `${T3_ENVIRONMENT_ID}\n`,
  );
  yield* fileSystem.writeFile(
    path.join(machine.t3Attachments, `${machine.screenshotId}.png`),
    new Uint8Array([1, 2, 3]),
  );

  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const sink = yield* EventSink.EventSinkV2;
    for (const [projectId, title, workspaceRoot] of [
      ["t3-project-a", "Repo A", machine.repoA],
      ["t3-project-b", "Repo B", machine.repoB],
      ["t3-project-gone", "Gone", machine.gone],
    ] as const) {
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES (${projectId}, ${title}, ${workspaceRoot}, '[]', ${iso}, ${iso}, NULL)
      `;
    }
    const threads = [
      // In a T3 Code worktree, with a screenshot and a plan.
      t3Thread({
        id: "t3-thread-a1",
        projectId: "t3-project-a",
        title: "Fix the importer",
        branch: "t3code/fix-importer",
        worktreePath: path.join(t3Home, "worktrees", "repo-a", "fix-importer"),
        messages: [
          message("user", "Look at this", [image(machine.screenshotId)]),
          message("assistant", "Fixed it."),
          { ...message("assistant", "1. Ship the importer"), kind: "plan" },
        ],
      }),
      // Its attachment's file is gone from T3 Code's disk.
      t3Thread({
        id: "t3-thread-a2",
        projectId: "t3-project-a",
        messages: [
          message("user", "Second", [image("t3-thread-a2-00000000-0000-4000-8000-000000000002")]),
          message("assistant", "Done."),
        ],
      }),
      t3Thread({
        id: "t3-thread-live",
        projectId: "t3-project-a",
        messages: [message("user", "Running")],
      }),
      t3Thread({
        id: "t3-thread-v1",
        projectId: "t3-project-a",
        messages: [message("user", "Old")],
      }),
      t3Thread({
        id: "t3-thread-broken",
        projectId: "t3-project-a",
        messages: [message("user", "?")],
      }),
      t3Thread({
        id: "t3-thread-sub",
        projectId: "t3-project-a",
        messages: [message("user", "Subagent")],
        shell: {
          lineage: {
            parentThreadId: ThreadId.make("t3-thread-a1"),
            relationshipToParent: "subagent",
            rootThreadId: ThreadId.make("t3-thread-a1"),
          },
        },
      }),
      t3Thread({
        id: "t3-thread-deleted",
        projectId: "t3-project-a",
        messages: [message("user", "Deleted")],
        shell: { deletedAt: at },
      }),
      t3Thread({
        id: "t3-thread-b1",
        projectId: "t3-project-b",
        messages: [message("user", "In B")],
      }),
      t3Thread({
        id: "t3-thread-gone",
        projectId: "t3-project-gone",
        messages: [message("user", "Lost")],
      }),
    ];
    for (const events of threads) yield* sink.write({ events });
    // Work T3 Code would pick up again: this thread is still changing.
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
      VALUES ('effect-live', 'command-live', 't3-thread-live', 'provider.turn.start', '{}', 'pending', ${iso}, ${iso}, ${iso})
    `;
    // A thread from before T3 Code's database update whose history it never loaded.
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, transcript_imported_at, imported_message_count, last_error)
      VALUES ('t3-thread-v1', ${iso}, ${iso}, NULL, 0, NULL)
    `;
    yield* sql`
      UPDATE orchestration_v2_projection_threads SET payload_json = '{"broken":true}'
      WHERE thread_id = 't3-thread-broken'
    `;
  }).pipe(Effect.provide(layerT3Writer(machine.t3Database)), Effect.scoped);
  return machine;
});

/** The thread id an imported T3 Code thread has here. */
const importedThreadId = (t3ThreadId: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode(t3ThreadId));
    return movedThreadId(TempoThreadMoveId.make(`t3-${Hex.encode(digest).slice(0, 32)}`));
  });

/** The database file's bytes, size and modification time. */
const fingerprint = (file: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const crypto = yield* Crypto.Crypto;
    const info = yield* fileSystem.stat(file);
    const digest = yield* crypto.digest("SHA-256", yield* fileSystem.readFile(file));
    return {
      sha256: Hex.encode(digest),
      size: Number(info.size),
      mtime: Option.getOrUndefined(info.mtime)?.getTime(),
    };
  });

function byTitle<A extends { readonly title: string }>(projects: ReadonlyArray<A>, title: string) {
  const project = projects.find((entry) => entry.title === title);
  assert.isDefined(project, `no project ${title}`);
  return project!;
}

describe("T3ImportService", () => {
  it.effect(
    "scans and imports T3 Code's threads, imports nothing the second time, and leaves T3 Code's database as it was",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const config = yield* ServerConfig.ServerConfig;
        const imports = yield* T3ImportService.T3ImportService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projects = yield* ProjectService.ProjectService;
        const machine = yield* setUpT3;
        // Tempo already has a project for repo B.
        yield* projects.create({
          commandId: CommandId.make("tempo:create-repo-b"),
          projectId: ProjectId.make("tempo-project-b"),
          title: "B in Tempo",
          workspaceRoot: machine.repoB,
        });
        // T3 Code's server is up, so the thread it would resume is still changing.
        yield* fileSystem.writeFileString(
          path.join(machine.t3Home, "userdata", "server-runtime.json"),
          JSON.stringify({
            version: 1,
            pid: process.pid,
            port: 3773,
            origin: "http://127.0.0.1:3773",
            startedAt: iso,
          }),
        );
        const before = yield* fingerprint(machine.t3Database);

        // The default home, ~/.t3, resolves under this test's home folder.
        const scan = yield* imports
          .scan({})
          .pipe(Effect.provideService(HostProcess.HomeDirectory, machine.userHome));
        assert.equal(scan.t3Home, machine.t3Home);
        assert.isTrue(scan.found);
        assert.isTrue(scan.t3Running);
        assert.isNull(scan.incompatibility);
        assert.equal(scan.sizeBytes, before.size);
        assert.deepEqual(
          scan.projects.map((project) => project.title),
          ["Repo A", "Repo B", "Gone"],
        );
        assert.deepEqual(byTitle<TempoT3ImportScanProject>(scan.projects, "Repo A"), {
          t3ProjectId: ProjectId.make("t3-project-a"),
          title: "Repo A",
          workspaceRoot: machine.repoA,
          tempoProject: null,
          toImport: 2,
          alreadyImported: 0,
          skipped: [
            { reason: "live", count: 1 },
            { reason: "notHydrated", count: 1 },
            { reason: "unreadable", count: 1 },
          ],
        });
        assert.deepEqual(byTitle(scan.projects, "Repo B").tempoProject, {
          id: ProjectId.make("tempo-project-b"),
          title: "B in Tempo",
        });
        assert.equal(byTitle(scan.projects, "Repo B").toImport, 1);
        assert.deepEqual(byTitle(scan.projects, "Gone").skipped, [
          { reason: "folderMissing", count: 1 },
        ]);
        assert.equal(byTitle(scan.projects, "Gone").toImport, 0);

        const run = yield* imports.run({ t3Home: machine.t3Home });
        const repoA = byTitle<TempoT3ImportRunProject>(run.projects, "Repo A");
        assert.equal(repoA.imported, 2);
        assert.isTrue(repoA.createdProject);
        assert.isNotNull(repoA.tempoProject);
        assert.equal(byTitle(run.projects, "Repo B").imported, 1);
        assert.isFalse(byTitle(run.projects, "Repo B").createdProject);
        assert.equal(byTitle(run.projects, "Gone").imported, 0);
        assert.equal(run.missingAttachments, 1);
        assert.equal(run.needsModel, 3);

        // Repo A's new project, at T3 Code's folder.
        const created = yield* projects.getById(repoA.tempoProject!.id);
        assert.isTrue(Option.isSome(created));
        assert.equal(Option.getOrThrow(created).workspaceRoot, machine.repoA);
        assert.equal(Option.getOrThrow(created).title, "Repo A");

        // History only, in T3 Code's worktree, marked as from T3 Code.
        const threadId = yield* importedThreadId("t3-thread-a1");
        const imported = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(imported.thread.projectId, repoA.tempoProject!.id);
        assert.equal(imported.thread.title, "Fix the importer");
        assert.equal(imported.thread.historyOrigin, "v1_import");
        assert.equal(imported.thread.branch, "t3code/fix-importer");
        assert.equal(
          imported.thread.worktreePath,
          path.join(machine.t3Home, "worktrees", "repo-a", "fix-importer"),
        );
        assert.equal(imported.thread.movedFrom?.environmentLabel, "T3 Code");
        assert.equal(imported.thread.movedFrom?.environmentId, T3_ENVIRONMENT_ID);
        assert.equal(imported.thread.movedFrom?.threadId, "t3-thread-a1");
        assert.lengthOf(imported.runs, 0);
        assert.deepEqual(
          imported.messages.map((entry) => entry.text),
          ["Look at this", "Fixed it."],
        );
        assert.isDefined(imported.turnItems.find((item) => item.type === "proposed_plan"));
        // The screenshot, copied under an id of the imported thread's own.
        const screenshot = imported.messages[0]?.attachments[0];
        assert.isDefined(screenshot);
        assert.notEqual(screenshot!.id, machine.screenshotId);
        assert.deepEqual(
          Array.from(
            yield* fileSystem.readFile(path.join(config.attachmentsDir, `${screenshot!.id}.png`)),
          ),
          [1, 2, 3],
        );
        // The thread whose attachment file was gone arrives without it.
        const second = yield* orchestrator.getThreadProjection(
          yield* importedThreadId("t3-thread-a2"),
        );
        assert.deepEqual(second.messages[0]?.attachments, []);
        // Threads that stayed behind are not here.
        for (const t3ThreadId of [
          "t3-thread-live",
          "t3-thread-v1",
          "t3-thread-sub",
          "t3-thread-gone",
        ]) {
          assert.isNull(yield* orchestrator.getThreadShell(yield* importedThreadId(t3ThreadId)));
        }

        // A second scan and run find everything already here.
        const again = yield* imports.scan({ t3Home: machine.t3Home });
        assert.equal(byTitle(again.projects, "Repo A").toImport, 0);
        assert.equal(byTitle(again.projects, "Repo A").alreadyImported, 2);
        assert.deepEqual(byTitle(again.projects, "Repo A").tempoProject, repoA.tempoProject);
        const rerun = yield* imports.run({ t3Home: machine.t3Home });
        assert.deepEqual(
          rerun.projects.map((project) => [
            project.title,
            project.imported,
            project.alreadyImported,
          ]),
          [
            ["Repo A", 0, 2],
            ["Repo B", 0, 1],
            ["Gone", 0, 0],
          ],
        );

        // Read-only on T3 Code's side: same bytes, same size, same modification time.
        assert.deepEqual(yield* fingerprint(machine.t3Database), before);
        const log = yield* fileSystem.stat(`${machine.t3Database}-wal`).pipe(
          Effect.map((info) => Number(info.size)),
          Effect.option,
        );
        assert.isTrue(Option.isNone(log) || Option.getOrThrow(log) === 0);
        assert.isTrue(
          yield* fileSystem.exists(path.join(machine.t3Attachments, `${machine.screenshotId}.png`)),
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("brings the threads a closed T3 Code left unfinished", () =>
    Effect.gen(function* () {
      const imports = yield* T3ImportService.T3ImportService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const machine = yield* setUpT3;

      // Nothing resumes the work it recorded until T3 Code starts again.
      const scan = yield* imports.scan({ t3Home: machine.t3Home });
      assert.isFalse(scan.t3Running);
      const repoA = byTitle<TempoT3ImportScanProject>(scan.projects, "Repo A");
      assert.equal(repoA.toImport, 3);
      assert.isUndefined(repoA.skipped.find((entry) => entry.reason === "live"));

      const run = yield* imports.run({ t3Home: machine.t3Home });
      assert.equal(byTitle(run.projects, "Repo A").imported, 3);
      const live = yield* orchestrator.getThreadProjection(
        yield* importedThreadId("t3-thread-live"),
      );
      assert.deepEqual(
        live.messages.map((entry) => entry.text),
        ["Running"],
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect(
    "leaves settled and archived threads in T3 Code unless asked, and keeps snoozes and pull requests",
    () =>
      Effect.gen(function* () {
        const imports = yield* T3ImportService.T3ImportService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const machine = yield* setUpT3;
        yield* TestClock.setTime(DateTime.toEpochMillis(today));
        const pullRequest = {
          host: "github.com",
          repository: "acme/app",
          number: 42,
          url: "https://github.com/acme/app/pull/42",
          source: "created",
          linkedAt: iso,
          snapshot: null,
          stack: null,
        } as const;
        const linkedPullRequest = {
          projectId: ProjectId.make("t3-project-b"),
          repository: pullRequest.repository,
          number: pullRequest.number,
          url: pullRequest.url,
        };
        yield* Effect.gen(function* () {
          const sink = yield* EventSink.EventSinkV2;
          const threads = [
            t3Thread({
              id: "t3-thread-settled",
              projectId: "t3-project-b",
              messages: [message("user", "Done")],
              shell: { settledOverride: "settled", settledAt: at },
            }),
            t3Thread({
              id: "t3-thread-archived",
              projectId: "t3-project-b",
              messages: [message("user", "Shelved")],
              shell: { archivedAt },
            }),
            // Snoozed, with its pull request still watched in T3 Code.
            t3Thread({
              id: "t3-thread-snoozed",
              projectId: "t3-project-b",
              messages: [message("user", "Later")],
              shell: {
                snoozedUntil: wakesAt,
                snoozedAt: at,
                linkedPullRequest,
                pullRequests: [
                  {
                    ...pullRequest,
                    watch: {
                      startedAt: iso,
                      headSha: null,
                      failedChecks: [],
                      passed: false,
                      passedChecks: [],
                      remarksThrough: iso,
                      remarkIds: [],
                      conflicting: false,
                      wakes: 0,
                    },
                  },
                ],
              },
            }),
            // Its wake time has passed, so it reads as awake there and here.
            t3Thread({
              id: "t3-thread-woke",
              projectId: "t3-project-b",
              messages: [message("user", "Back")],
              shell: { snoozedUntil: wokeAt, snoozedAt: at },
            }),
            // Settled underneath, but T3 Code lists it under Snoozed until it wakes.
            t3Thread({
              id: "t3-thread-settled-snoozed",
              projectId: "t3-project-b",
              messages: [message("user", "Remind me")],
              shell: {
                settledOverride: "settled",
                settledAt: at,
                snoozedUntil: wakesAt,
                snoozedAt: at,
              },
            }),
          ];
          for (const events of threads) yield* sink.write({ events });
        }).pipe(Effect.provide(layerT3Writer(machine.t3Database)), Effect.scoped);
        const threadOf = (t3ThreadId: string) =>
          importedThreadId(t3ThreadId).pipe(
            Effect.flatMap((threadId) => orchestrator.getThreadProjection(threadId)),
            Effect.map((projection) => projection.thread),
          );

        // Settled and archived threads stay behind, counted.
        const scan = yield* imports.scan({ t3Home: machine.t3Home });
        assert.equal(byTitle(scan.projects, "Repo B").toImport, 4);
        assert.deepEqual(byTitle(scan.projects, "Repo B").skipped, [
          { reason: "settled", count: 2 },
        ]);
        const run = yield* imports.run({ t3Home: machine.t3Home });
        assert.equal(byTitle(run.projects, "Repo B").imported, 4);
        assert.deepEqual(byTitle(run.projects, "Repo B").skipped, [
          { reason: "settled", count: 2 },
        ]);
        for (const t3ThreadId of ["t3-thread-settled", "t3-thread-archived"]) {
          assert.isNull(yield* orchestrator.getThreadShell(yield* importedThreadId(t3ThreadId)));
        }

        // Snoozed threads stay snoozed; the pull request comes without T3 Code's watch.
        const snoozed = yield* threadOf("t3-thread-snoozed");
        assert.equal(isoOrNull(snoozed.snoozedUntil), DateTime.formatIso(wakesAt));
        assert.equal(isoOrNull(snoozed.snoozedAt), iso);
        assert.isNull(snoozed.settledOverride);
        assert.deepEqual(snoozed.linkedPullRequest, linkedPullRequest);
        assert.deepEqual(snoozed.pullRequests, [pullRequest]);
        // A wake time already past is kept as it was.
        assert.equal(
          isoOrNull((yield* threadOf("t3-thread-woke")).snoozedUntil),
          DateTime.formatIso(wokeAt),
        );
        const settledSnoozed = yield* threadOf("t3-thread-settled-snoozed");
        assert.equal(settledSnoozed.settledOverride, "settled");
        assert.equal(isoOrNull(settledSnoozed.snoozedUntil), DateTime.formatIso(wakesAt));

        // Asked to, the import brings them too, settled and archived as they were.
        const withSettled = yield* imports.scan({ t3Home: machine.t3Home, includeSettled: true });
        assert.equal(byTitle(withSettled.projects, "Repo B").toImport, 2);
        assert.deepEqual(byTitle(withSettled.projects, "Repo B").skipped, []);
        const rerun = yield* imports.run({ t3Home: machine.t3Home, includeSettled: true });
        assert.equal(byTitle(rerun.projects, "Repo B").imported, 2);
        const settled = yield* threadOf("t3-thread-settled");
        assert.equal(settled.settledOverride, "settled");
        assert.equal(isoOrNull(settled.settledAt), iso);
        assert.equal(
          isoOrNull((yield* threadOf("t3-thread-archived")).archivedAt),
          DateTime.formatIso(archivedAt),
        );
      }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("names a running T3 Code and keeps a removed project's threads in T3 Code", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imports = yield* T3ImportService.T3ImportService;
      const projects = yield* ProjectService.ProjectService;
      const machine = yield* setUpT3;
      const first = yield* imports.run({ t3Home: machine.t3Home });
      const repoA = byTitle(first.projects, "Repo A").tempoProject!;
      // The user removes the project the import made; T3 Code gains a thread there meanwhile.
      yield* projects.delete({
        commandId: CommandId.make("tempo:delete-repo-a"),
        projectId: repoA.id,
        force: true,
      });
      yield* Effect.gen(function* () {
        const sink = yield* EventSink.EventSinkV2;
        yield* sink.write({
          events: t3Thread({
            id: "t3-thread-a3",
            projectId: "t3-project-a",
            messages: [message("user", "Later")],
          }),
        });
      }).pipe(Effect.provide(layerT3Writer(machine.t3Database)), Effect.scoped);
      // T3 Code's server is up.
      yield* fileSystem.writeFileString(
        path.join(machine.t3Home, "userdata", "server-runtime.json"),
        JSON.stringify({
          version: 1,
          pid: process.pid,
          port: 3773,
          origin: "http://127.0.0.1:3773",
          startedAt: iso,
        }),
      );

      const scan = yield* imports.scan({ t3Home: machine.t3Home });
      assert.isTrue(scan.t3Running);
      const project = byTitle(scan.projects, "Repo A");
      assert.isNull(project.tempoProject);
      assert.equal(project.toImport, 0);
      // The first import ran with T3 Code closed, so it brought the unfinished thread too.
      assert.equal(project.alreadyImported, 3);
      assert.deepEqual(
        project.skipped.find((entry) => entry.reason === "projectRemoved"),
        { reason: "projectRemoved", count: 1 },
      );
      const run = yield* imports.run({ t3Home: machine.t3Home });
      assert.equal(byTitle(run.projects, "Repo A").imported, 0);
      assert.isTrue(Option.isSome(yield* projects.getById(repoA.id, { includeDeleted: true })));
      assert.isTrue(Option.isNone(yield* projects.getById(repoA.id)));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("refuses T3 Code data this Tempo cannot read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const imports = yield* T3ImportService.T3ImportService;

      // Newer: T3 Code recorded a migration this build does not know.
      const newer = yield* setUpT3;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (999, 'FromTheFuture')`;
      }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: newer.t3Database })),
        Effect.scoped,
      );
      const before = yield* fingerprint(newer.t3Database);
      const scan = yield* imports.scan({ t3Home: newer.t3Home });
      assert.equal(scan.incompatibility, "tooNew");
      assert.deepEqual(scan.projects, []);
      const refused = yield* imports.run({ t3Home: newer.t3Home }).pipe(Effect.flip);
      assert.equal(refused._tag, "TempoT3ImportIncompatibleError");
      assert.equal(
        refused._tag === "TempoT3ImportIncompatibleError" ? refused.reason : null,
        "tooNew",
      );
      assert.deepEqual(yield* fingerprint(newer.t3Database), before);

      // Older: a database from before T3 Code's orchestration tables.
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-t3-import-old-" });
      const olderDatabase = path.join(root, "userdata", "statev2.sqlite");
      yield* fileSystem.makeDirectory(path.dirname(olderDatabase), { recursive: true });
      yield* runMigrations({ toMigrationInclusive: 54 }).pipe(
        Effect.provide(NodeSqliteClient.layer({ filename: olderDatabase })),
        Effect.scoped,
      );
      assert.equal((yield* imports.scan({ t3Home: root })).incompatibility, "tooOld");
      assert.equal(
        (yield* imports.run({ t3Home: root }).pipe(Effect.flip))._tag,
        "TempoT3ImportIncompatibleError",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("reports a machine without T3 Code, and refuses Tempo's own data", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig.ServerConfig;
      const imports = yield* T3ImportService.T3ImportService;
      const empty = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-t3-import-none-" });
      const scan = yield* imports.scan({ t3Home: empty });
      assert.deepEqual(scan, {
        t3Home: empty,
        found: false,
        sizeBytes: 0,
        t3Running: false,
        incompatibility: null,
        projects: [],
      });
      assert.equal(
        (yield* imports.run({ t3Home: empty }).pipe(Effect.flip))._tag,
        "TempoT3ImportNotFoundError",
      );
      assert.equal(
        (yield* imports.scan({ t3Home: config.baseDir }).pipe(Effect.flip))._tag,
        "TempoT3ImportOwnDataError",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
