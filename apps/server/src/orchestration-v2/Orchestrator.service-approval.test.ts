import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  TEMPO_SERVICE_APPROVAL_REQUEST_ID_PREFIX,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as ServiceWriteApproval from "../mcp/toolkits/services/serviceWriteApproval.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
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
        { name: "service-approval" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(NodeCrypto.layer),
);

const threadId = ThreadId.make("thread:service-approval");
const sessionId = ProviderSessionId.make("session:service-approval");
const tool = {
  name: "mcp__t3-code__openrouter_key_delete",
  input: '{"service":"openrouter","operation":"Delete key","target":"hash-1"}',
  firstArg: "hash-1",
  subtitle: "openrouter · Delete key hash-1",
};

/** A thread whose turn is running on a live provider session. */
const runningThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:service-approval"),
    title: "Service write",
    modelSelection: { instanceId, model: "gpt-5.1-codex" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("send"),
    threadId,
    messageId: MessageId.make("message:service-approval"),
    text: "Delete the old key",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const started = yield* orchestrator.getThreadProjection(threadId);
  const now = yield* DateTime.now;
  let sequence = 0;
  const apply = (event: Omit<OrchestrationV2DomainEvent, "id">) =>
    projections.apply({
      ...event,
      id: EventId.make(`event:service-approval:${sequence++}`),
    } as OrchestrationV2DomainEvent);
  yield* apply({
    type: "provider-session.attached",
    threadId,
    occurredAt: now,
    payload: {
      id: sessionId,
      driver: adapter.driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/repo",
      model: "gpt-5.1-codex",
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
  });
  yield* apply({
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: { ...started.providerThreads[0]!, providerSessionId: sessionId },
  });
  const run = { ...started.runs[0]!, status: "running" as const };
  yield* apply({ type: "run.updated", threadId, occurredAt: now, payload: run });
  return run;
});

const record = (requestId: RuntimeRequestId, status: "pending" | "cancelled") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
    return yield* orchestrator.dispatch({
      type: "service_approval.record",
      commandId: CommandId.make(`record:${requestId}:${status}`),
      threadId,
      runId: run.id,
      requestId,
      tool,
      status,
    });
  });

const respond = (requestId: RuntimeRequestId, decision: "accept" | "decline") =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "runtime-request.respond",
      commandId: CommandId.make(`respond:${requestId}`),
      threadId,
      requestId,
      decision,
    });
  });

const approval = (requestId: RuntimeRequestId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const request = projection.runtimeRequests.find((entry) => entry.id === requestId);
    const item = projection.turnItems.find(
      (entry) => entry.type === "approval_request" && entry.requestId === requestId,
    );
    const node = projection.nodes.find((entry) => entry.runtimeRequestId === requestId);
    return { request, item, node };
  });

const providerResponses = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly effect_id: string }>`
    SELECT effect_id FROM orchestration_v2_effect_outbox
    WHERE effect_type = 'runtime-request.respond'`;
  return rows.length;
});

const requestId = RuntimeRequestId.make(`${TEMPO_SERVICE_APPROVAL_REQUEST_ID_PREFIX}test`);

it.effect("recording a service approval raises a live Allow once / Deny card", () =>
  Effect.gen(function* () {
    const run = yield* runningThread;
    yield* record(requestId, "pending");
    const { request, item, node } = yield* approval(requestId);
    assert.equal(request?.status, "pending");
    assert.equal(request?.kind, "permission");
    assert.deepEqual(request?.responseCapability, { type: "live", providerSessionId: sessionId });
    assert.equal(node?.status, "waiting");
    assert.equal(node?.parentNodeId, run.rootNodeId);
    assert.equal(item?.type, "approval_request");
    if (item?.type !== "approval_request") return;
    assert.equal(item.status, "waiting");
    assert.deepEqual(item.tool, tool);
    assert.deepEqual(
      item.options?.map((option) => option.decision),
      ["decline", "accept"],
    );

    yield* record(requestId, "cancelled");
    const closed = yield* approval(requestId);
    assert.equal(closed.request?.status, "cancelled");
    assert.equal(closed.item?.status, "cancelled");
    assert.equal(closed.node?.status, "cancelled");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses an approval without an active turn or the service prefix", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const run = yield* runningThread;
    const wrongId = yield* Effect.exit(
      orchestrator.dispatch({
        type: "service_approval.record",
        commandId: CommandId.make("record:wrong-id"),
        threadId,
        runId: run.id,
        requestId: RuntimeRequestId.make("runtime-request:provider"),
        tool,
        status: "pending",
      }),
    );
    assert.isTrue(Exit.isFailure(wrongId));
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt"),
      threadId,
      runId: run.id,
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(record(requestId, "pending"))));
    assert.isUndefined((yield* approval(requestId)).request);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("never forwards the user's answer to the provider", () =>
  Effect.gen(function* () {
    yield* runningThread;
    yield* record(requestId, "pending");
    yield* respond(requestId, "accept");
    const { request, item } = yield* approval(requestId);
    assert.equal(request?.status, "resolved");
    assert.equal(request?.decision, "accept");
    assert.equal(item?.status, "completed");
    assert.equal(yield* providerResponses, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("still forwards the answer to an ordinary approval to the provider", () =>
  Effect.gen(function* () {
    const run = yield* runningThread;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const providerRequestId = RuntimeRequestId.make("runtime-request:provider");
    const now = yield* DateTime.now;
    yield* projections.apply({
      id: EventId.make("event:service-approval:provider-request"),
      type: "runtime-request.updated",
      threadId,
      runId: run.id,
      nodeId: run.rootNodeId!,
      occurredAt: now,
      payload: {
        id: providerRequestId,
        nodeId: run.rootNodeId!,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "permission",
        status: "pending",
        responseCapability: { type: "live", providerSessionId: sessionId },
        createdAt: now,
        resolvedAt: null,
      },
    } as OrchestrationV2DomainEvent);
    yield* respond(providerRequestId, "accept");
    assert.equal(yield* providerResponses, 1);
  }).pipe(Effect.provide(layerTest)),
);

/** Starts a service write that waits on its card; returns the waiting call and the card's id. */
const askInBackground = Effect.gen(function* () {
  const run = yield* runningThread;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  // Subscribed before the fork, so the card's commit cannot be missed.
  const raised = yield* orchestrator.streamDomainEvents.pipe(
    Stream.filter(
      (event) => event.type === "runtime-request.updated" && event.payload.status === "pending",
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  const ask = yield* ServiceWriteApproval.make;
  const waiting = yield* ask({
    tool: "openrouter_key_delete",
    service: "openrouter",
    operation: "Delete key",
    target: "hash-1",
  }).pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment:service-approval"),
      requestNamespace: "service-approval",
      thread: {
        threadId,
        providerSessionId: sessionId,
        providerInstanceId: run.providerInstanceId,
      },
      client: undefined,
      issuedAt: 0,
      capabilities: new Set<McpInvocationContext.McpCapability>(["services"]),
    }),
    Effect.forkChild,
  );
  yield* Fiber.join(raised);
  const card = (yield* orchestrator.getThreadProjection(threadId)).runtimeRequests.find(
    (request) => request.status === "pending",
  );
  return { run, waiting, cardId: card!.id };
});

const askAndAnswer = (decision: "accept" | "decline") =>
  Effect.gen(function* () {
    const { waiting, cardId } = yield* askInBackground;
    yield* respond(cardId, decision);
    yield* TestClock.adjust("1 second");
    return yield* Fiber.await(waiting);
  });

it.effect("Allow once lets the waiting write run", () =>
  Effect.gen(function* () {
    const exit = yield* askAndAnswer("accept");
    assert.isTrue(Exit.isSuccess(exit));
    assert.equal(yield* providerResponses, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("Deny stops the waiting write with a plain error", () =>
  Effect.gen(function* () {
    const exit = yield* askAndAnswer("decline");
    assert.isTrue(Exit.isFailure(exit));
    assert.include(
      String(Exit.isFailure(exit) ? exit.cause : ""),
      "The user denied this service write",
    );
    assert.equal(yield* providerResponses, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("Stop closes the waiting card, and a later Allow cannot run the write", () =>
  Effect.gen(function* () {
    const { run, waiting, cardId } = yield* askInBackground;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "run.interrupt",
      commandId: CommandId.make("interrupt"),
      threadId,
      runId: run.id,
    });
    yield* TestClock.adjust("1 second");
    const { request, item } = yield* approval(cardId);
    assert.equal(request?.status, "cancelled");
    assert.equal(item?.status, "cancelled");
    assert.isTrue(Exit.isFailure(yield* Effect.exit(respond(cardId, "accept"))));
    const exit = yield* Fiber.await(waiting);
    assert.include(String(Exit.isFailure(exit) ? exit.cause : "succeeded"), "the turn ended");
  }).pipe(Effect.provide(layerTest)),
);
