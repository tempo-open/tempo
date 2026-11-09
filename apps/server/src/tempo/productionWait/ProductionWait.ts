/**
 * tempo: Waiting for Production. A thread whose work is merged to staging waits for the next
 * promotion to production of the repository TEMPO_PRODUCTION_REPOSITORY names, then is woken. `setWaiting` is the one way in and out (RPC, MCP tool,
 * client menus). One two-minute sweep serves all waits, reading GitHub only while a thread waits.
 * A wait also ends when its thread settles, is archived or moves away.
 */
import {
  CommandId,
  TempoProductionWaitFailedError,
  TempoProductionWaitRefusedError,
  MessageId,
  ThreadId,
  tempoProductionWaitRefusal,
  type TempoProductionWaitError,
  type TempoProductionWaitSetInput,
  type TempoProductionWaitSetResult,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../../serverActivation.ts";
import * as ProductionDeployments from "./ProductionDeployments.ts";
import {
  PRODUCTION_PROMOTED_MESSAGE,
  PRODUCTION_PROMOTED_NOTIFICATION,
  PRODUCTION_WAIT_SWEEP_MINUTES,
  promotionFor,
} from "./productionWaitDecision.ts";

export class ProductionWait extends Context.Service<
  ProductionWait,
  {
    /** Starts (keeping an earlier start) or stops a thread's wait for the next promotion. */
    readonly setWaiting: (
      input: TempoProductionWaitSetInput,
    ) => Effect.Effect<TempoProductionWaitSetResult, TempoProductionWaitError>;
    /** One pass: wakes every waiting thread whose promotion has landed. */
    readonly sweep: Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/tempo/productionWait/ProductionWait") {}

const logFailure =
  (message: string, fields: Record<string, unknown>) =>
  <E>(cause: Cause.Cause<E>): Effect.Effect<void> =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.interrupt
      : Effect.logWarning(message, { ...fields, cause });

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const deployments = yield* ProductionDeployments.ProductionDeployments;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  // A machine without access to the repository fails every sweep the same way: warn once.
  let readFailing = false;

  const setWaiting: ProductionWait["Service"]["setWaiting"] = Effect.fn(
    "ProductionWait.setWaiting",
  )(function* (input) {
    yield* Effect.annotateCurrentSpan({ threadId: input.threadId, waiting: input.waiting });
    const failed = (cause: unknown) =>
      new TempoProductionWaitFailedError({ threadId: input.threadId, cause });
    const shell = yield* orchestrator.getThreadShell(input.threadId).pipe(Effect.mapError(failed));
    if (shell === null || shell.deletedAt !== null) {
      return yield* new TempoProductionWaitRefusedError({
        threadId: input.threadId,
        reason: "notFound",
      });
    }
    const since = shell.waitingForProductionSince ?? null;
    // Already as asked: nothing to record.
    if (input.waiting === (since !== null)) return { waitingForProductionSince: since };
    const reason = !input.waiting
      ? null
      : deployments.target === null
        ? ("unconfigured" as const)
        : tempoProductionWaitRefusal(shell);
    if (reason !== null) {
      return yield* new TempoProductionWaitRefusedError({ threadId: input.threadId, reason });
    }
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.mapError(failed));
    yield* orchestrator
      .dispatch({
        type: "thread.production-wait.set",
        commandId: CommandId.make(`server:production-wait:${input.threadId}:${uuid}`),
        threadId: input.threadId,
        waiting: input.waiting,
      })
      .pipe(Effect.mapError(failed));
    const after = yield* orchestrator.getThreadShell(input.threadId).pipe(Effect.mapError(failed));
    return { waitingForProductionSince: after?.waitingForProductionSince ?? null };
  });

  // Threads that wait, oldest wait first. Settling and archiving end a wait, so
  // this reads only the threads the sweep may wake.
  const waitingThreads = sql<{ readonly threadId: string; readonly since: string }>`
    SELECT thread_id AS "threadId",
      json_extract(payload_json, '$.waitingForProductionSince') AS since
    FROM orchestration_v2_projection_threads
    WHERE deleted_at IS NULL
      AND json_extract(payload_json, '$.waitingForProductionSince') IS NOT NULL
      AND json_extract(payload_json, '$.archivedAt') IS NULL
    ORDER BY since ASC, thread_id ASC
  `;

  /** Ends the wait that started at `since` and wakes the thread, unless it changed meanwhile. */
  const resume = Effect.fn("ProductionWait.resume")(function* (
    threadId: ThreadId,
    since: string,
    deploymentId: number,
  ) {
    const uuid = yield* crypto.randomUUIDv4();
    yield* orchestrator.dispatch({
      type: "thread.production-wait.resume",
      commandId: CommandId.make(`server:production-wait:resume:${threadId}:${uuid}`),
      threadId,
      since,
      wake: {
        messageId: MessageId.make(`message:production-wait:${uuid}`),
        text: PRODUCTION_PROMOTED_MESSAGE,
        notification: PRODUCTION_PROMOTED_NOTIFICATION,
      },
    });
    const now = yield* Clock.currentTimeMillis;
    yield* Effect.logInfo("production promotion woke a waiting thread", {
      threadId,
      deploymentId,
      waitedMinutes: Math.max(0, Math.round((now - Date.parse(since)) / 60_000)),
    });
  });

  const wakePromoted = Effect.fnUntraced(function* (
    waiting: ReadonlyArray<{ readonly threadId: string; readonly since: string }>,
  ) {
    const read = yield* Effect.exit(deployments.recent);
    if (read._tag === "Failure") {
      if (Cause.hasInterruptsOnly(read.cause)) return yield* Effect.interrupt;
      const log = readFailing ? Effect.logDebug : Effect.logWarning;
      readFailing = true;
      return yield* log("production wait could not read deployments", {
        waitingThreads: waiting.length,
        cause: read.cause,
      });
    }
    readFailing = false;
    yield* Effect.forEach(
      waiting,
      ({ threadId, since }) => {
        const promotion = promotionFor(since, read.value, deployments.target?.workflow);
        return promotion === undefined
          ? Effect.void
          : // A wait that ended or restarted while the deployments were read is refused.
            resume(ThreadId.make(threadId), since, promotion.id).pipe(
              Effect.catchCause(
                logFailure("production wait could not wake a thread", { threadId }),
              ),
            );
      },
      { discard: true },
    );
  });
  // Nearly every scan finds no thread waiting, so it stays out of the trace; a sweep with
  // waiting threads is traced.
  const sweepFailed = logFailure("production wait sweep failed", {});
  const sweep = waitingThreads.pipe(
    Effect.withTracerEnabled(false),
    Effect.flatMap((waiting) =>
      waiting.length === 0
        ? Effect.void
        : wakePromoted(waiting).pipe(
            Effect.catchCause(sweepFailed),
            Effect.withSpan("ProductionWait.sweep"),
          ),
    ),
    Effect.catchCause(sweepFailed),
  );

  const start: ProductionWait["Service"]["start"] = () =>
    forkParked(
      sweep.pipe(
        Effect.repeat(Schedule.spaced(`${PRODUCTION_WAIT_SWEEP_MINUTES} minutes`)),
        Effect.asVoid,
      ),
    );

  return ProductionWait.of({ setWaiting, sweep, start });
});

export const layer = Layer.effect(ProductionWait, make);
