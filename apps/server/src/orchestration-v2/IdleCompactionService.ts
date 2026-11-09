import {
  CommandId,
  globalIdleCompaction,
  IDLE_COMPACTION_TEXT,
  MessageId,
  ProviderInstanceId,
  resolveIdleCompaction,
  resolveProjectProviderInstanceEnabled,
  type ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  idleCompactionCandidate,
  idleCompactionWindow,
  MAX_PROMPT_CACHE_TTL_MS,
} from "./IdleCompaction.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

class IdleCompactionServiceV2 extends Context.Service<
  IdleCompactionServiceV2,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/IdleCompactionService/IdleCompactionServiceV2") {}

/**
 * tempo: whether any thread can compact before its prompt cache expires: the default
 * mode or an instance's override. Tempo runs that mode for every compacting driver.
 */
const beforeCacheExpiresAnywhere = (settings: Parameters<typeof resolveIdleCompaction>[0]) =>
  globalIdleCompaction(settings) === "beforeCacheExpires" ||
  Object.keys(settings.providerInstances).some(
    (instanceId) =>
      resolveIdleCompaction(settings, ProviderInstanceId.make(instanceId)) === "beforeCacheExpires",
  );

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const instances = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const config = yield* ServerConfig.ServerConfig;

  // tempo: most minutes find no thread due, so the settings read (which spares the query when
  // compaction is off) and the candidate query stay out of the trace; a sweep that reaches a
  // due thread is traced as before.
  const sweep = Effect.fnUntraced(function* (threadId?: ThreadId) {
    const sweepSettings = yield* settings.getSettings.pipe(Effect.withTracerEnabled(false));
    // tempo: compaction near a provider's limit has its own setting.
    const { tempoCompactNearLimit } = sweepSettings;
    if (!tempoCompactNearLimit && !beforeCacheExpiresAnywhere(sweepSettings)) return;
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    // Runs that completed before the longest TTL can never be due again.
    const lookbackMs = Math.max(MAX_PROMPT_CACHE_TTL_MS, (config.idleCompactionDelayMs ?? 0) * 2);
    const candidates = yield* projections
      .getIdleCompactionCandidates({
        completedAfter: DateTime.makeUnsafe(nowMs - lookbackMs),
        ...(threadId === undefined ? {} : { threadId }),
      })
      .pipe(Effect.withTracerEnabled(false));
    const compactThread = Effect.fn("IdleCompactionServiceV2.compactThread")(
      function* (candidate: (typeof candidates)[number]) {
        // Only due threads load their history. The minute scan stays independent
        // of transcript size, like the settlement worker's candidate query.
        const projection = yield* projections.getThreadProjection(candidate.threadId);
        const currentSettings = yield* settings.getSettings;
        const instanceEnabled = resolveProjectProviderInstanceEnabled(
          currentSettings,
          projection.thread.projectId,
          projection.thread.providerInstanceId,
        );
        const current = idleCompactionCandidate(
          projection,
          resolveIdleCompaction(currentSettings, projection.thread.providerInstanceId) ===
            "beforeCacheExpires" && instanceEnabled,
          nowMs,
          currentSettings.tempoCompactNearLimit && instanceEnabled,
        );
        if (current === null || current.runId !== candidate.runId) return;
        // tempo: due by the reloaded thread and settings, which may no longer be near the limit.
        const window = idleCompactionWindow(
          current.completedAt,
          current.driver,
          config.idleCompactionDelayMs,
          current.nearLimit,
        );
        if (nowMs < window.startMs || nowMs >= window.endMs) return;
        const instance = yield* instances.getInstance(projection.thread.providerInstanceId);
        // Enablement is the project-resolved value above; a project can enable
        // an instance that is disabled machine-wide.
        if (instance === undefined || instance.driverKind !== current.driver) return;
        // Earlier candidates in this sweep can push this one past its cache TTL.
        if (DateTime.toEpochMillis(yield* DateTime.now) >= window.endMs) return;
        // One idempotent command per completed run survives concurrent scans and
        // restarts; dispatch rechecks eligibility under the thread's lock.
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`server:idle-compact:${current.threadId}:${current.runId}`),
          messageId: MessageId.make(`idle-compact:${current.threadId}:${current.runId}`),
          threadId: current.threadId,
          text: IDLE_COMPACTION_TEXT,
          attachments: [],
          createdBy: "system",
          creationSource: "server",
          idleCompactionOfRunId: current.runId,
          // tempo: near-limit compactions also run inside the cache window, so they share this label.
          idleCompaction: "beforeCacheExpires",
          dispatchMode: { type: "start_immediately" },
        });
      },
      (effect, candidate) =>
        effect.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.logWarning("idle compaction skipped", {
                threadId: candidate.threadId,
                cause: Cause.pretty(cause),
              }),
          ),
        ),
    );
    // tempo: compactThread returns at once for a thread outside its window, so only due ones go to it.
    const due = candidates.filter((candidate) => {
      const nearLimit = tempoCompactNearLimit && candidate.nearLimit;
      if (
        !nearLimit &&
        resolveIdleCompaction(sweepSettings, candidate.providerInstanceId) !== "beforeCacheExpires"
      )
        return false;
      const window = idleCompactionWindow(
        candidate.completedAt,
        candidate.driver,
        config.idleCompactionDelayMs,
        nearLimit,
      );
      return nowMs >= window.startMs && nowMs < window.endMs;
    });
    if (due.length === 0) return;
    yield* Effect.forEach(due, compactThread, { discard: true }).pipe(
      Effect.withSpan("IdleCompactionServiceV2.sweep"),
    );
  });
  const worker = yield* makeDrainableWorker((threadId: ThreadId | undefined) =>
    sweep(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("idle compaction sweep failed", { cause: Cause.pretty(cause) }),
      ),
    ),
  );
  const start: IdleCompactionServiceV2["Service"]["start"] = Effect.fn(
    "IdleCompactionServiceV2.start",
  )(function* () {
    const changes = yield* settings.subscribeChanges;
    let enabled = yield* settings.getSettings.pipe(Effect.orDie);
    yield* forkParked(
      Effect.gen(function* () {
        yield* worker.enqueue(undefined);
        yield* worker.drain;
      }).pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.asVoid),
    );
    yield* forkParked(
      Stream.runForEach(changes, (next) => {
        // tempo: either trigger's setting.
        if (
          beforeCacheExpiresAnywhere(next) === beforeCacheExpiresAnywhere(enabled) &&
          next.tempoCompactNearLimit === enabled.tempoCompactNearLimit
        )
          return Effect.void;
        enabled = next;
        return worker.enqueue(undefined);
      }),
    );
    yield* forkParked(
      Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
        event.type === "run.updated" && event.payload.status === "completed"
          ? worker.enqueue(event.threadId)
          : Effect.void,
      ),
    );
  });
  return { start, drain: worker.drain } satisfies IdleCompactionServiceV2["Service"];
});
