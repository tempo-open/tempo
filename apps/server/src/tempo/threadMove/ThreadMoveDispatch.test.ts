import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointScopeId,
  CommandId,
  ContextTransferId,
  TempoThreadMoveId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as ThreadForkService from "../../orchestration-v2/ThreadForkService.ts";
import { userFacingDispatchErrorMessage } from "../../orchestration-v2/UserFacingErrors.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { movedAwayRefusal } from "./ThreadMoveGuard.ts";
import { buildMovedThreadEvents, movedAwayThread, movedThreadId } from "./ThreadMoveThread.ts";

const layerPlatform = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "tempo-thread-move-dispatch-",
});

// Turns are accepted but never started: the effect worker is not drained here.
const codex = ProviderInstanceId.make("codex");
const codexDriver = ProviderDriverKind.make("codex");
const codexInstance = {
  instanceId: codex,
  driverKind: codexDriver,
  continuationIdentity: { driverKind: codexDriver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: codex,
    driver: codexDriver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("moved-thread dispatch tests never open a session"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

// The real orchestrator over an in-memory database.
const layerTest = Layer.mergeAll(RuntimeLayer.layer, RuntimeLayer.layerEventSink).pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatform),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === codexInstance.instanceId ? codexInstance : undefined),
      listInstances: Effect.succeed([codexInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(Layer.mock(GitWorkflow.GitWorkflowService)({})),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(layerPlatform),
);

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");

/** A thread that moved here, as an import writes it: history and a plan, no runs. */
const seedMovedThread = (moveId: TempoThreadMoveId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const threadId = movedThreadId(moveId);
    yield* sink.write({
      events: buildMovedThreadEvents({
        eventPrefix: `tempo-move:${moveId}`,
        thread: {
          title: "Moved",
          modelSelection: { instanceId: codex, model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: at,
        },
        messages: [
          { role: "user", text: "hello", attachments: [], createdAt: at, updatedAt: at },
          { role: "assistant", text: "Hi.", attachments: [], createdAt: at, updatedAt: at },
          {
            role: "assistant",
            kind: "plan",
            text: "1. Ship the importer",
            attachments: [],
            createdAt: at,
            updatedAt: at,
          },
        ],
        threadId,
        projectId: ProjectId.make("project"),
        branch: "main",
        worktreePath: "/repo",
        movedFrom: {
          moveId,
          environmentId: EnvironmentId.make("office"),
          environmentLabel: "Office",
          threadId: ThreadId.make("origin"),
          movedAt: "2026-10-01T09:00:00.000Z",
        },
        now: at,
        pathMappings: [],
        attachmentIds: new Map(),
      }),
    });
    return threadId;
  });

/** A moved-in thread that then moved on again: a stub on this machine. */
const seedStub = (moveId: TempoThreadMoveId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = yield* seedMovedThread(moveId);
    const records = yield* orchestrator.getThreadRecords(threadId, []);
    const stub = movedAwayThread(
      records.thread,
      {
        moveId: TempoThreadMoveId.make(`${moveId}-2`),
        environmentId: EnvironmentId.make("desk"),
        environmentLabel: "Desk Mac",
        threadId: ThreadId.make("over-there"),
        movedAt: "2026-10-01T10:00:00.000Z",
      },
      at,
    );
    yield* sink.write({
      events: [
        {
          id: EventId.make(`tempo-move:${moveId}:moved-away`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: at,
          payload: stub,
        },
      ],
    });
    return stub;
  });

it.effect("a thread that moved away refuses new messages without touching its history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = (yield* seedStub(TempoThreadMoveId.make("dispatch-test"))).id;
    const before = yield* orchestrator.getThreadEventSequence(threadId);

    const refused = yield* orchestrator
      .dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:tempo-moved:message"),
        threadId,
        messageId: MessageId.make("message:tempo-moved:message"),
        text: "One more thing.",
        attachments: [],
        dispatchMode: { type: "start_immediately" },
      })
      .pipe(Effect.flip);

    assert.equal(refused._tag, "OrchestratorCommandRejectedError");
    assert.equal(userFacingDispatchErrorMessage(refused), "This thread already moved to Desk Mac.");
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), before);
    const after = yield* orchestrator.getThreadRecords(threadId, ["messages", "runs"]);
    assert.lengthOf(after.runs, 0);
    assert.deepEqual(
      after.messages.map((message) => message.text),
      ["hello", "Hi."],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a moved thread keeps going in a fresh session that gets its history", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = yield* seedMovedThread(TempoThreadMoveId.make("continue-test"));

    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make("command:tempo-moved:continue"),
      threadId,
      messageId: MessageId.make("message:tempo-moved:continue"),
      text: "Keep going on the desk Mac.",
      attachments: [],
      dispatchMode: { type: "start_immediately" },
    });

    // The handoff is decided with the run, so the committed dispatch already holds it.
    const projection = yield* orchestrator.getThreadProjection(threadId);
    assert.lengthOf(projection.runs, 1);
    const run = projection.runs[0]!;
    const handoff = projection.contextHandoffs.find(
      (candidate) => candidate.id === run.contextHandoffId,
    );
    assert.equal(handoff?.strategy, "manual_context");
    assert.equal(handoff?.targetRunId, run.id);
    // The moved conversation, plan included, is what the new session starts from.
    assert.deepEqual(
      handoff?.history?.messages.map((message) => [message.kind, message.text]),
      [
        ["user_message", "hello"],
        ["assistant_message", "Hi."],
        ["proposed_plan", "1. Ship the importer"],
      ],
    );
    assert.deepEqual(
      projection.providerThreads.map((providerThread) => providerThread.nativeThreadRef),
      [null],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a stub refuses rollback, retried preparation and resumed queues", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = (yield* seedStub(TempoThreadMoveId.make("history-test"))).id;
    const before = yield* orchestrator.getThreadEventSequence(threadId);
    const commands = [
      {
        type: "checkpoint.rollback",
        commandId: CommandId.make("command:tempo-moved:rollback"),
        threadId,
        scopeId: CheckpointScopeId.make("scope:tempo-moved"),
        checkpointId: CheckpointId.make("checkpoint:tempo-moved"),
        restoreFiles: true,
      },
      {
        type: "prepared-run.retry",
        commandId: CommandId.make("command:tempo-moved:retry"),
        threadId,
        runId: RunId.make("run:tempo-moved"),
      },
      {
        type: "queue.resume",
        commandId: CommandId.make("command:tempo-moved:resume"),
        threadId,
      },
    ] as const;
    for (const command of commands) {
      const refused = yield* orchestrator.dispatch(command).pipe(Effect.flip);
      assert.equal(
        userFacingDispatchErrorMessage(refused),
        "This thread already moved to Desk Mac.",
        command.type,
      );
    }
    assert.equal(yield* orchestrator.getThreadEventSequence(threadId), before);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a fork of a stub is a live thread of its own", () =>
  Effect.gen(function* () {
    const stub = yield* seedStub(TempoThreadMoveId.make("fork-test"));
    const forkedAt = DateTime.makeUnsafe("2026-10-01T11:00:00.000Z");
    const run: OrchestrationV2Run = {
      id: RunId.make("run:tempo-stub"),
      threadId: stub.id,
      ordinal: 1,
      providerInstanceId: stub.modelSelection.instanceId,
      modelSelection: stub.modelSelection,
      providerThreadId: ProviderThreadId.make("provider-thread:tempo-stub"),
      userMessageId: MessageId.make("message:tempo-stub"),
      rootNodeId: null,
      activeAttemptId: null,
      status: "completed",
      queuePosition: null,
      requestedAt: forkedAt,
      startedAt: forkedAt,
      completedAt: forkedAt,
      checkpointId: null,
      contextHandoffId: null,
    };
    const plan = yield* ThreadForkService.ThreadForkServiceV2.pipe(
      Effect.flatMap((forks) =>
        forks.plan({
          sourceProjection: { thread: stub },
          sourceRun: run,
          sourceProviderThread: undefined,
          canonicalSourcePoint: { threadId: stub.id, runId: run.id },
          transferId: ContextTransferId.make("context-transfer:tempo-stub"),
          targetThreadId: ThreadId.make("fork-of-stub"),
          createdBy: "user",
          creationSource: "web",
          createdAt: forkedAt,
        }),
      ),
      Effect.provide(ThreadForkService.layer),
    );
    assert.isNotNull(stub.movedTo);
    assert.isNull(plan.targetThread.movedTo);
    assert.isNull(plan.targetThread.movedFrom);
    assert.isNull(movedAwayRefusal(plan.targetThread));
  }).pipe(Effect.provide(layerTest)),
);
