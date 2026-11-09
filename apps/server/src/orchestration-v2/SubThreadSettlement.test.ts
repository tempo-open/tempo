import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type RuntimeMode,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import { DispatchModeLimit } from "./DispatchModeLimit.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { isAutoSettlementCandidate } from "./ThreadSettlementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "sub-thread-settlement" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const decodeEffectRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(EffectOutbox.OrchestrationEffectRequestV2),
);

const createThread = (threadId: ThreadId, runtimeMode: RuntimeMode = "full-access") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:sub-thread-settlement"),
      title: threadId,
      modelSelection,
      runtimeMode,
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const send = (threadId: ThreadId, text: string, senderThreadId?: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${threadId}:${text}`),
      threadId,
      messageId: MessageId.make(`message:${threadId}:${text}`),
      text,
      attachments: [],
      dispatchMode: { type: "start_immediately" },
      ...(senderThreadId === undefined
        ? { createdBy: "user" as const, creationSource: "web" as const }
        : { createdBy: "agent" as const, creationSource: "mcp" as const, senderThreadId }),
    });
  });

/** A chat another chat started, the way thread launch and create_threads do. */
const createSubChat = (
  threadId: ThreadId,
  creatorThreadId: ThreadId,
  runtimeMode: RuntimeMode = "full-access",
) =>
  createThread(threadId, runtimeMode).pipe(
    Effect.andThen(send(threadId, "start", creatorThreadId)),
    Effect.andThen(finishRuns(threadId)),
  );

/** Ends a thread's runs as if its turns completed. */
const finishRuns = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    for (const run of (yield* orchestrator.getThreadProjection(threadId)).runs) {
      yield* projections.apply({
        id: EventId.make(`event:finish:${run.id}`),
        type: "run.updated",
        threadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status: "completed", startedAt: now, completedAt: now },
      });
    }
  });

const delegate = (parentThreadId: ThreadId, task: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.at(-1)!;
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      commandId: CommandId.make(`delegate:${task}`),
      parentThreadId,
      parentRunId: parentRun.id,
      parentNodeId: parentRun.rootNodeId!,
      task,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
      createdBy: "agent",
      creationSource: "mcp",
    });
    const projection = yield* orchestrator.getThreadProjection(parentThreadId);
    return projection.subagents.find((candidate) => candidate.prompt === task)!.childThreadId!;
  });

/**
 * Runs pending sub-thread effects the way the effect worker would, each once,
 * until none is left.
 */
const runSubThreadEffects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  while (true) {
    const rows = yield* sql<{
      readonly effect_id: string;
      readonly command_id: string;
      readonly thread_id: string;
      readonly payload_json: string;
    }>`
      SELECT effect_id, command_id, thread_id, payload_json
      FROM orchestration_v2_effect_outbox
      WHERE effect_type IN ('sub-threads.settle', 'sub-threads.unsettle')
        AND status = 'pending'
      ORDER BY created_at ASC, effect_id ASC
    `;
    if (rows.length === 0) return;
    for (const row of rows) {
      yield* sql`
        UPDATE orchestration_v2_effect_outbox SET status = 'succeeded'
        WHERE effect_id = ${row.effect_id}
      `;
      const request = decodeEffectRequest(row.payload_json);
      const input = {
        threadId: ThreadId.make(row.thread_id),
        commandId: CommandId.make(row.command_id),
      };
      if (request.type === "sub-threads.settle") {
        yield* threads.settleSubThreads({
          ...input,
          settledAt: request.settledAt,
          modeLimit: request.modeLimit,
          agentThreadId: request.agentThreadId,
        });
      } else if (request.type === "sub-threads.unsettle") {
        yield* threads.unsettleSubThreads({ ...input, modeLimit: request.modeLimit });
      }
    }
  }
});

/** The commands that queued a walk of the chats under them. */
const subThreadWalkCommands = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly command_id: string }>`
    SELECT command_id FROM orchestration_v2_effect_outbox
    WHERE effect_type IN ('sub-threads.settle', 'sub-threads.unsettle')
    ORDER BY command_id
  `;
  return rows.map((row) => row.command_id);
});

const settleState = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      settled: projection.thread.settledOverride,
      settledAt: projection.thread.settledAt,
      runs: projection.runs.map((run) => run.status),
    };
  });

const settle = (threadId: ThreadId, commandId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.settle",
      commandId: CommandId.make(commandId),
      threadId,
    });
  });

const unsettle = (threadId: ThreadId, commandId: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.unsettle",
      commandId: CommandId.make(commandId),
      threadId,
      reason: "user",
    });
  });

it.effect("settling a chat settles every chat under it, and unsettling brings them back", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const parent = ThreadId.make("thread:cascade-parent");
    const subChat = ThreadId.make("thread:cascade-sub-chat");
    const grandchild = ThreadId.make("thread:cascade-grandchild");
    const settledEarlier = ThreadId.make("thread:cascade-settled-earlier");
    yield* createThread(parent);
    yield* send(parent, "work");
    const delegated = yield* delegate(parent, "cascade task");
    yield* createSubChat(subChat, parent);
    yield* createSubChat(grandchild, subChat);
    yield* createSubChat(settledEarlier, parent);
    yield* settle(settledEarlier, "settle-earlier");
    const earlier = yield* settleState(settledEarlier);
    assert.include(
      ["preparing", "starting", "running", "waiting"],
      (yield* settleState(delegated)).runs[0],
    );
    yield* TestClock.adjust("1 second");

    yield* settle(parent, "settle-parent");
    yield* runSubThreadEffects;

    for (const threadId of [parent, delegated, subChat, grandchild]) {
      assert.equal((yield* settleState(threadId)).settled, "settled", threadId);
    }
    // The working delegated task stopped, the way settling it directly stops it.
    assert.deepEqual((yield* settleState(delegated)).runs, ["interrupted"]);
    // Its own settle stops it as a direct Settle does. No tasks run under it, so Stop queues no
    // `delegated-tasks.stop`, and its run never reached a provider, so there is no turn to interrupt.
    const delegatedEffects = yield* sql<{ readonly effect_type: string }>`
      SELECT effect_type FROM orchestration_v2_effect_outbox
      WHERE thread_id = ${delegated} AND command_id = ${`settle-parent:settle:${delegated}`}
    `;
    assert.deepEqual(
      delegatedEffects.map((row) => row.effect_type),
      ["scheduled-tasks.cleanup"],
    );
    // A chat that was already settled keeps its own settle time.
    assert.deepEqual(yield* settleState(settledEarlier), earlier);
    // One walk covered the whole tree: the chats it settled did not cascade again.
    assert.deepEqual(yield* subThreadWalkCommands, ["settle-earlier", "settle-parent"]);

    yield* TestClock.adjust("1 second");
    yield* unsettle(parent, "unsettle-parent");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(parent)).settled, "active");
    // Back to how they were before the parent settled, not pinned active.
    for (const threadId of [delegated, subChat, grandchild]) {
      const state = yield* settleState(threadId);
      assert.isNull(state.settled, threadId);
      assert.isNull(state.settledAt, threadId);
    }
    // It settled before its parent did, so it was not the parent's to bring back.
    assert.equal((yield* settleState(settledEarlier)).settled, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a chat its parent's unsettle brings back can settle on its own again", () =>
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = ThreadId.make("thread:restore-parent");
    const child = ThreadId.make("thread:restore-child");
    const keptActive = ThreadId.make("thread:restore-kept-active");
    yield* createThread(parent);
    yield* createSubChat(child, parent);
    yield* createSubChat(keptActive, parent);
    // Unsettled by hand before the parent settles: the parent's settle still takes it.
    yield* settle(keptActive, "settle-kept-active");
    yield* unsettle(keptActive, "unsettle-kept-active");
    yield* TestClock.adjust("1 second");

    yield* settle(parent, "settle-restore-parent");
    yield* runSubThreadEffects;
    assert.equal((yield* settleState(child)).settled, "settled");
    assert.equal((yield* settleState(keptActive)).settled, "settled");
    yield* TestClock.adjust("1 second");
    yield* unsettle(parent, "unsettle-restore-parent");
    yield* runSubThreadEffects;

    const [candidate] = yield* projections.getSettlementCandidates(child);
    assert.isDefined(candidate);
    assert.isTrue(
      isAutoSettlementCandidate(candidate!, DateTime.toEpochMillis(yield* DateTime.now)),
    );
    // Its own unsettle before the parent's settle stands.
    assert.equal((yield* settleState(keptActive)).settled, "active");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an agent settling a chat above its own keeps its own turn running", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parent = ThreadId.make("thread:agent-above-parent");
    const sibling = ThreadId.make("thread:agent-above-sibling");
    const own = ThreadId.make("thread:agent-above-own");
    yield* createThread(parent);
    yield* createSubChat(sibling, parent);
    yield* createSubChat(own, parent);
    yield* send(own, "working");
    const ownTask = yield* delegate(own, "own chat task");
    const ownRuns = (yield* settleState(own)).runs;
    assert.include(["preparing", "starting", "running", "waiting"], ownRuns.at(-1));

    // The sub chat's agent settles the chat that started it.
    yield* threads.settleThread({
      threadId: parent,
      commandId: CommandId.make("agent-settles-above"),
      byOwnAgent: false,
      agentThreadId: own,
    });
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(parent)).settled, "settled");
    assert.equal((yield* settleState(sibling)).settled, "settled");
    // Its turn keeps going; it settles when the turn ends, as settling itself would.
    assert.deepEqual(yield* settleState(own), { settled: null, settledAt: null, runs: ownRuns });
    // The chats under it follow as usual.
    assert.equal((yield* settleState(ownTask)).settled, "settled");
    assert.deepEqual((yield* settleState(ownTask)).runs, ["interrupted"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a chat waiting on the person keeps the work under it", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const parent = ThreadId.make("thread:waiting-parent");
    const waiting = ThreadId.make("thread:waiting-child");
    const underWaiting = ThreadId.make("thread:waiting-sub-chat");
    yield* createThread(parent);
    yield* createSubChat(waiting, parent);
    yield* send(waiting, "asking");
    const task = yield* delegate(waiting, "waiting chat task");
    yield* createSubChat(underWaiting, waiting);
    const run = (yield* orchestrator.getThreadProjection(waiting)).runs.at(-1)!;
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:waiting:request"),
      type: "runtime-request.updated",
      threadId: waiting,
      runId: run.id,
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make("request:waiting"),
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input",
        status: "pending",
        responseCapability: { type: "not_resumable", reason: "Asked in the app." },
        createdAt: now,
        resolvedAt: null,
      },
    });
    const taskRuns = (yield* settleState(task)).runs;

    yield* settle(parent, "settle-waiting-parent");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(parent)).settled, "settled");
    assert.isNull((yield* settleState(waiting)).settled);
    assert.deepEqual(yield* settleState(task), { settled: null, settledAt: null, runs: taskRuns });
    assert.isNull((yield* settleState(underWaiting)).settled);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("automatic and idle-only settles leave the chats under them alone", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const autoParent = ThreadId.make("thread:auto-parent");
    const autoChild = ThreadId.make("thread:auto-child");
    const agentParent = ThreadId.make("thread:own-agent-parent");
    const agentChild = ThreadId.make("thread:own-agent-child");
    yield* createThread(autoParent);
    yield* createSubChat(autoChild, autoParent);
    yield* createThread(agentParent);
    yield* createSubChat(agentChild, agentParent);

    yield* orchestrator.dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle-parent"),
      threadId: autoParent,
      snapshotAt: yield* DateTime.now,
    });
    // An agent settling its own chat.
    yield* threads.settleThread({
      threadId: agentParent,
      commandId: CommandId.make("own-agent-settle"),
      byOwnAgent: true,
    });
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(autoParent)).settled, "settled");
    assert.equal((yield* settleState(agentParent)).settled, "settled");
    assert.isNull((yield* settleState(autoChild)).settled);
    assert.isNull((yield* settleState(agentChild)).settled);
    assert.deepEqual(yield* subThreadWalkCommands, []);
    // Only automatic settlement keeps the chat's schedules and watchers.
    const sql = yield* SqlClient.SqlClient;
    const scheduleCleanups = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_v2_effect_outbox
      WHERE effect_type = 'scheduled-tasks.cleanup'
    `;
    assert.deepEqual(
      scheduleCleanups.map((row) => row.command_id),
      ["own-agent-settle"],
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("an agent settling another chat settles only the chats its modes reach", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const parent = ThreadId.make("thread:limited-parent");
    const reachable = ThreadId.make("thread:limited-reachable");
    const above = ThreadId.make("thread:limited-above");
    const underAbove = ThreadId.make("thread:limited-under-above");
    yield* createThread(parent, "auto-accept-edits");
    yield* createSubChat(reachable, parent, "auto-accept-edits");
    yield* createSubChat(above, parent, "full-access");
    yield* createSubChat(underAbove, above, "auto-accept-edits");

    yield* threads
      .settleThread({
        threadId: parent,
        commandId: CommandId.make("agent-settles-parent"),
        byOwnAgent: false,
      })
      .pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: "auto-accept-edits",
          interactionMode: "default",
        }),
      );
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(parent)).settled, "settled");
    assert.equal((yield* settleState(reachable)).settled, "settled");
    // Above the agent's modes, and nothing is reached through it.
    assert.isNull((yield* settleState(above)).settled);
    assert.isNull((yield* settleState(underAbove)).settled);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("unsettling a chat brings back only what its own settle settled", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = ThreadId.make("thread:provenance-parent");
    const followed = ThreadId.make("thread:provenance-followed");
    const resettled = ThreadId.make("thread:provenance-resettled");
    const afterAutoSettle = ThreadId.make("thread:provenance-after-auto");
    const autoParent = ThreadId.make("thread:provenance-auto-parent");
    yield* createThread(parent);
    yield* createSubChat(followed, parent);
    yield* createSubChat(resettled, parent);

    yield* settle(parent, "settle-provenance-parent");
    yield* runSubThreadEffects;
    yield* TestClock.adjust("1 second");
    // The person settles this one again themselves: now it's their settle, not the parent's.
    yield* settle(resettled, "settle-by-hand");
    yield* TestClock.adjust("1 second");
    yield* unsettle(parent, "unsettle-provenance-parent");
    yield* runSubThreadEffects;

    assert.isNull((yield* settleState(followed)).settled);
    assert.equal((yield* settleState(resettled)).settled, "settled");

    // Automatic settlement back-dates its settle time; a chat settled by hand after it
    // still isn't the parent's to bring back.
    yield* createThread(autoParent);
    yield* createSubChat(afterAutoSettle, autoParent);
    const now = yield* DateTime.now;
    yield* orchestrator.dispatch({
      type: "thread.auto-settle",
      commandId: CommandId.make("auto-settle-back-dated"),
      threadId: autoParent,
      snapshotAt: now,
      settledAt: DateTime.subtract(now, { days: 1 }),
    });
    yield* settle(afterAutoSettle, "settle-after-auto");
    yield* unsettle(autoParent, "unsettle-auto-parent");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(autoParent)).settled, "active");
    assert.equal((yield* settleState(afterAutoSettle)).settled, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("settling again leaves a chat unsettled by hand since alone", () =>
  Effect.gen(function* () {
    const parent = ThreadId.make("thread:resettle-parent");
    const child = ThreadId.make("thread:resettle-child");
    const grandchild = ThreadId.make("thread:resettle-grandchild");
    yield* createThread(parent);
    yield* createSubChat(child, parent);
    yield* createSubChat(grandchild, child);

    yield* settle(parent, "settle-first");
    yield* runSubThreadEffects;
    yield* TestClock.adjust("1 second");
    yield* unsettle(grandchild, "unsettle-grandchild-by-hand");
    yield* TestClock.adjust("1 second");
    yield* settle(parent, "settle-again");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(child)).settled, "settled");
    assert.equal((yield* settleState(grandchild)).settled, "active");

    // A fresh settle after unsettling the parent takes everything again.
    yield* TestClock.adjust("1 second");
    yield* unsettle(parent, "unsettle-parent");
    yield* runSubThreadEffects;
    yield* TestClock.adjust("1 second");
    yield* settle(parent, "settle-fresh");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(child)).settled, "settled");
    assert.equal((yield* settleState(grandchild)).settled, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a deliberate settle takes a pinned chat along and walks through an archived one", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = ThreadId.make("thread:walk-parent");
    const pinned = ThreadId.make("thread:walk-pinned");
    const archived = ThreadId.make("thread:walk-archived");
    const underArchived = ThreadId.make("thread:walk-under-archived");
    yield* createThread(parent);
    yield* createSubChat(pinned, parent);
    yield* createSubChat(archived, parent);
    yield* createSubChat(underArchived, archived);
    yield* orchestrator.dispatch({
      type: "thread.pin",
      commandId: CommandId.make("pin-child"),
      threadId: pinned,
    });
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-child"),
      threadId: archived,
    });

    yield* settle(parent, "settle-walk-parent");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(pinned)).settled, "settled");
    assert.isNull((yield* settleState(archived)).settled);
    assert.equal((yield* settleState(underArchived)).settled, "settled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a creator loop settles each chat once and ends", () =>
  Effect.gen(function* () {
    const first = ThreadId.make("thread:loop-first");
    const second = ThreadId.make("thread:loop-second");
    yield* createThread(first);
    yield* createThread(second);
    // Each chat's first message came from the other.
    yield* send(second, "from first", first);
    yield* send(first, "from second", second);
    yield* finishRuns(first);
    yield* finishRuns(second);

    yield* settle(first, "settle-loop");
    yield* runSubThreadEffects;

    assert.equal((yield* settleState(first)).settled, "settled");
    assert.equal((yield* settleState(second)).settled, "settled");
    const sql = yield* SqlClient.SqlClient;
    const settles = yield* sql<{ readonly command_id: string }>`
      SELECT command_id FROM orchestration_command_receipts
      WHERE command_type = 'thread.settle' ORDER BY command_id
    `;
    assert.deepEqual(
      settles.map((row) => row.command_id),
      ["settle-loop", `settle-loop:settle:${second}`],
    );
  }).pipe(Effect.provide(layerTest)),
);
