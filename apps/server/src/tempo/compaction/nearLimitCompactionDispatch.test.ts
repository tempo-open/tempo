import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Runs here never reach a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerWith = (serverSettings: {
  readonly compactIdleThreads: boolean;
  readonly tempoCompactNearLimit: boolean;
}) => {
  const layerDatabase = SqlitePersistence.layerMemory;
  return Layer.mergeAll(
    layerDatabase,
    ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
    ProviderReplayHarness.layerWithRegistry(
      { name: "near-limit-compaction" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: layerDatabase, runEffectWorker: false, serverSettings },
    ),
  );
};

/**
 * Sends the compaction the worker would for a thread whose turn just ended `usedTokens`
 * into Codex's reported 258,400-token window; the orchestrator rechecks it under the
 * thread's lock with the settings it reads then.
 */
const compactAfterTurn = Effect.fn("compactAfterTurn")(function* (usedTokens: number) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make("thread:near-limit");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create"),
    threadId,
    projectId: ProjectId.make("project:near-limit"),
    title: "Near the limit",
    modelSelection: { instanceId, model: "gpt-5" },
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
    messageId: MessageId.make("message:send"),
    text: "Refactor the parser",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const started = yield* orchestrator.getThreadProjection(threadId);
  const run = started.runs[0]!;
  const now = yield* DateTime.now;
  yield* projections.apply({
    id: EventId.make("turn-completed"),
    type: "run.updated",
    threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: "completed", startedAt: now, completedAt: now },
  });
  yield* projections.apply({
    id: EventId.make("turn-usage"),
    type: "provider-thread.updated",
    threadId,
    occurredAt: now,
    payload: { ...started.providerThreads[0]!, contextUsage: { usedTokens, maxTokens: 258_400 } },
  });
  const sent = yield* orchestrator
    .dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`server:idle-compact:${threadId}:${run.id}`),
      messageId: MessageId.make(`idle-compact:${threadId}:${run.id}`),
      threadId,
      text: "/compact",
      attachments: [],
      createdBy: "system",
      creationSource: "server",
      idleCompactionOfRunId: run.id,
      dispatchMode: { type: "start_immediately" },
    })
    .pipe(Effect.exit);
  const after = yield* orchestrator.getThreadProjection(threadId);
  return {
    accepted: Exit.isSuccess(sent),
    compactionRuns: after.runs.filter((candidate) => candidate.idleCompactionOfRunId === run.id),
  };
});

it.effect("accepts a compaction near the limit when only its own setting is on", () =>
  Effect.gen(function* () {
    const { accepted, compactionRuns } = yield* compactAfterTurn(230_000);
    assert.isTrue(accepted);
    assert.lengthOf(compactionRuns, 1);
  }).pipe(Effect.provide(layerWith({ compactIdleThreads: false, tempoCompactNearLimit: true }))),
);

it.effect.each([
  { name: "with its setting off", usedTokens: 230_000, tempoCompactNearLimit: false },
  { name: "below the margin", usedTokens: 219_799, tempoCompactNearLimit: true },
])("refuses it $name while idle compaction is off", ({ usedTokens, tempoCompactNearLimit }) =>
  Effect.gen(function* () {
    const { accepted, compactionRuns } = yield* compactAfterTurn(usedTokens);
    assert.isFalse(accepted);
    assert.lengthOf(compactionRuns, 0);
  }).pipe(Effect.provide(layerWith({ compactIdleThreads: false, tempoCompactNearLimit }))),
);
