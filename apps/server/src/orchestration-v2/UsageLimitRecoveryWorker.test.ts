import { assert, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";

it.effect("reads settings only on a scheduler tick that finds a limited thread", () =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    const limited: ProjectionStore.ProjectionLimitRecoveryCandidate = {
      id: ThreadId.make("thread:limited"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      status: "failed",
      lastErrorClass: "usage_limit",
      latestRunId: RunId.make("run:limited"),
      usageLimitResetAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
      archivedAt: null,
      settledOverride: null,
      pendingRuntimeRequest: null,
      latestRunCompletedAt: now,
      updatedAt: now,
    };
    const candidates = yield* Ref.make<
      ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>
    >([]);
    const queries = yield* Queue.unbounded<{
      readonly autoResume: boolean;
      readonly snooze: boolean;
    }>();
    const settingsReads = yield* Ref.make(0);
    const preferencesOn = yield* Ref.make(false);
    // What the worker did for a limited thread: "arm", or another command's type.
    const commands = yield* Ref.make<ReadonlyArray<string>>([]);
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: ({ autoResume, snooze }) =>
              Queue.offer(queries, { autoResume, snooze }).pipe(
                Effect.andThen(Ref.get(candidates)),
              ),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Ref.update(settingsReads, (count) => count + 1).pipe(
              Effect.andThen(Ref.get(preferencesOn)),
              Effect.map((on) => ({
                ...DEFAULT_SERVER_SETTINGS,
                autoResumeLimitedThreads: on,
                snoozeLimitedThreads: on,
              })),
            ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            dispatch: (command) =>
              Ref.update(commands, (all) => [...all, command.type]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
          // Arming goes through the orchestrator.
          Layer.mock(Orchestrator.OrchestratorV2)({
            autoArmLimitRecovery: () => Ref.update(commands, (all) => [...all, "arm"]),
          }),
        ),
      ),
    );

    yield* Effect.gen(function* () {
      // The query asks for every candidate the preferences could act on.
      assert.deepEqual(yield* Queue.take(queries), { autoResume: true, snooze: true });
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(queries);
      assert.equal(yield* Ref.get(settingsReads), 0);

      // The preferences still decide: off, a limited thread is left alone.
      yield* Ref.set(candidates, [limited]);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(queries);
      assert.equal(yield* Ref.get(settingsReads), 1);
      assert.deepEqual(yield* Ref.get(commands), []);

      yield* Ref.set(preferencesOn, true);
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(queries);
      assert.deepEqual(yield* Ref.get(commands), ["arm"]);
    }).pipe(Effect.provide(layer));
  }),
);
