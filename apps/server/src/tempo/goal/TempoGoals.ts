/**
 * tempo: thread goals (`tempoGoal.ts` in contracts). `update` serves the WebSocket RPC (goal banner,
 * a composer's `/goal pause|resume|clear`) and the agent's `update_goal` tool; a `/goal` message
 * goes through the orchestrator itself. When a run ends, the reactor queues the next turn toward
 * the goal, or after a failure holds the goal until a usage limit resets or the user resumes.
 */
import {
  CommandId,
  TempoGoalFailedError,
  TempoGoalRefusedError,
  MessageId,
  ThreadId,
  tempoGoalRefusal,
  type TempoGoal,
  type TempoGoalChange,
  type TempoGoalError,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import { CONNECTION_LOST_CODE } from "../connectionFailure.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import { forkParked } from "../../serverActivation.ts";
import { isGoalPursued } from "./tempoGoalDecision.ts";

export class TempoGoals extends Context.Service<
  TempoGoals,
  {
    /** Applies a change to a thread's goal and returns the goal it leaves. */
    readonly update: (input: {
      readonly threadId: ThreadId;
      readonly change: TempoGoalChange;
    }) => Effect.Effect<{ readonly goal: TempoGoal | null }, TempoGoalError>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Waits until every run end seen so far has been reacted to. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/tempo/goal/TempoGoals") {}

const FAILED_TURN_NOTE = "Paused because a turn failed. Resume to keep going.";

interface RunEnd {
  readonly threadId: ThreadId;
  readonly runId: OrchestrationV2Run["id"];
  readonly status: "completed" | "failed";
}

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const update: TempoGoals["Service"]["update"] = Effect.fn("TempoGoals.update")(function* (input) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId, change: input.change.type });
    const failed = (cause: unknown) =>
      new TempoGoalFailedError({ threadId: input.threadId, cause });
    const refused = (reason: TempoGoalRefusedError["reason"]) =>
      new TempoGoalRefusedError({ threadId: input.threadId, reason });
    const shell = yield* orchestrator.getThreadShell(input.threadId).pipe(Effect.mapError(failed));
    if (shell === null || shell.deletedAt !== null) return yield* refused("notFound");
    if (shell.movedTo != null) return yield* refused("movedAway");
    const thread = yield* projections.getThread(input.threadId).pipe(Effect.mapError(failed));
    const reason = tempoGoalRefusal(thread.tempoGoal, input.change);
    if (reason !== null) return yield* refused(reason);
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.mapError(failed));
    yield* orchestrator
      .dispatch({
        type: "thread.goal.update",
        commandId: CommandId.make(`server:tempo-goal:${input.threadId}:${uuid}`),
        threadId: input.threadId,
        change: input.change,
        messageId: MessageId.make(`message:tempo-goal:${uuid}`),
      })
      .pipe(Effect.mapError(failed));
    const after = yield* projections.getThread(input.threadId).pipe(Effect.mapError(failed));
    return { goal: after.tempoGoal ?? null };
  });

  /**
   * Continues or holds the goal of the thread whose run ended. One command per
   * run, so the live reaction and the startup catch-up cannot both act; the
   * orchestrator rechecks the goal under the thread's lock.
   */
  const react = Effect.fn("TempoGoals.react")(function* (ended: RunEnd) {
    const thread = yield* projections.getThread(ended.threadId);
    const goal = thread.tempoGoal;
    if (
      !isGoalPursued(goal) ||
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      thread.settledOverride === "settled" ||
      thread.settledAt !== null ||
      thread.movedTo != null
    ) {
      return;
    }
    let change: TempoGoalChange = { type: "continue", setAt: goal.setAt };
    if (ended.status === "failed") {
      const shell = yield* orchestrator.getThreadShell(ended.threadId);
      // The turn continues by itself when the connection returns, and that run's end decides.
      if (shell?.lastErrorCode === CONNECTION_LOST_CODE) return;
      change =
        shell?.lastErrorClass === "usage_limit"
          ? { type: "halt", setAt: goal.setAt, status: "usage_limited" }
          : { type: "halt", setAt: goal.setAt, status: "paused", note: FAILED_TURN_NOTE };
    }
    yield* orchestrator.dispatch({
      type: "thread.goal.update",
      commandId: CommandId.make(`server:tempo-goal:${ended.threadId}:${ended.runId}`),
      threadId: ended.threadId,
      change,
      messageId: MessageId.make(`message:tempo-goal:${ended.threadId}:${ended.runId}`),
    });
  });

  const worker = yield* makeDrainableWorker((ended: RunEnd) =>
    react(ended).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("goal could not continue", {
            threadId: ended.threadId,
            runId: ended.runId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  // Threads whose goal may be waiting on a run that ended while the server was down.
  const pursuingThreads = sql<{ readonly threadId: string }>`
    SELECT thread_id AS "threadId"
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.tempoGoal.status') IN ('active', 'usage_limited')
      AND json_extract(payload_json, '$.archivedAt') IS NULL
  `;

  const catchUp = Effect.gen(function* () {
    for (const { threadId } of yield* pursuingThreads) {
      const shell = yield* orchestrator.getThreadShell(ThreadId.make(threadId));
      if (shell === null || shell.latestRunId === null || shell.activeRunId !== null) continue;
      if (shell.status !== "completed" && shell.status !== "failed") continue;
      yield* worker.enqueue({ threadId: shell.id, runId: shell.latestRunId, status: shell.status });
    }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("goal catch-up failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start: TempoGoals["Service"]["start"] = Effect.fn("TempoGoals.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" &&
        (event.payload.status === "completed" || event.payload.status === "failed") &&
        // Idle compaction keeps a finished thread's context small; it is not a turn toward a goal.
        event.payload.idleCompactionOfRunId === undefined
          ? worker.enqueue({
              threadId: event.threadId,
              runId: event.payload.id,
              status: event.payload.status,
            })
          : Effect.void,
      ),
    );
    yield* forkParked(catchUp);
  });

  return TempoGoals.of({ update, start, drain: worker.drain });
});

export const layer = Layer.effect(TempoGoals, make);
