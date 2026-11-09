import { assert, describe, it } from "@effect/vitest";
import {
  AuthSessionId,
  EventId,
  MessageId,
  ProviderInstanceId,
  RpcClientId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as HostPowerMonitor from "../background/HostPowerMonitor.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SweepAttention from "./SweepAttention.ts";

const THREAD_ID = ThreadId.make("thread-1");

const layerAttention = (
  events: PubSub.PubSub<OrchestrationV2DomainEvent>,
  settings: Parameters<typeof ServerSettings.layerTest>[0] = {},
) =>
  SweepAttention.layer.pipe(
    Layer.provideMerge(BackgroundPolicy.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.effect(HostPowerMonitor.HostPowerMonitor, HostPowerMonitor.make()),
        ServerSettings.layerTest(settings),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.fromPubSub(events),
        }),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );

const createRunsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
});

const insertRun = (ordinal: number, status: OrchestrationV2Run["status"]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES (${`run-${ordinal}`}, ${THREAD_ID}, ${ordinal}, 'codex', ${status}, '', '{}')
    `;
  });

function runUpdated(status: OrchestrationV2Run["status"]): OrchestrationV2DomainEvent {
  const runId = RunId.make("run-2");
  const at = DateTime.makeUnsafe("2026-10-21T00:00:00.000Z");
  return {
    type: "run.updated",
    id: EventId.make(`event:${status}`),
    threadId: THREAD_ID,
    runId,
    occurredAt: at,
    payload: {
      id: runId,
      threadId: THREAD_ID,
      ordinal: 2,
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      providerThreadId: null,
      userMessageId: MessageId.make("message-2"),
      rootNodeId: null,
      activeAttemptId: null,
      status,
      requestedAt: at,
      startedAt: at,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

describe("SweepAttention", () => {
  it.effect(
    "waits the slow interval while nothing could notice, until a window is on screen, focused or not",
    () =>
      Effect.gen(function* () {
        const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        yield* Effect.gen(function* () {
          yield* createRunsTable;
          const attention = yield* SweepAttention.SweepAttention;
          const policy = yield* BackgroundPolicy.BackgroundPolicy;
          assert.isFalse(yield* attention.attended);

          const quiet = yield* Effect.forkChild(attention.pause("1 minute"));
          yield* TestClock.adjust("14 minutes");
          assert.isUndefined(quiet.pollUnsafe());
          yield* TestClock.adjust("1 minute");
          yield* Fiber.join(quiet);

          const waiting = yield* Effect.forkChild(attention.pause("1 minute"));
          yield* TestClock.adjust("5 minutes");
          assert.isUndefined(waiting.pollUnsafe());
          yield* policy.reportClientActivity(AuthSessionId.make("session-1"), RpcClientId.make(1), {
            clientId: "client-1",
            clientKind: "desktop-renderer",
            visible: true,
            focused: false,
            recentlyInteracted: false,
            scopes: [],
            ttlMs: 45_000,
            observedAt: yield* DateTime.now,
          });
          yield* Fiber.join(waiting);
          assert.isTrue(yield* attention.attended);
        }).pipe(Effect.provide(layerAttention(events)));
      }),
  );

  it.effect("counts a run under way, and a run starting ends a pause", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        yield* insertRun(1, "completed");
        const attention = yield* SweepAttention.SweepAttention;
        assert.isFalse(yield* attention.attended);

        const waiting = yield* Effect.forkChild(attention.pause("1 minute"));
        yield* TestClock.adjust("5 minutes");
        assert.isUndefined(waiting.pollUnsafe());
        yield* insertRun(2, "running");
        yield* PubSub.publish(events, runUpdated("running"));
        yield* Fiber.join(waiting);
        assert.isTrue(yield* attention.attended);
      }).pipe(Effect.provide(layerAttention(events)));
    }),
  );

  it.effect("counts auto-settling as attention, since it acts on what a sweep finds", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        const attention = yield* SweepAttention.SweepAttention;
        assert.isTrue(yield* attention.attended);
      }).pipe(Effect.provide(layerAttention(events, { sidebarAutoSettleOnMerge: true })));
    }),
  );
});
