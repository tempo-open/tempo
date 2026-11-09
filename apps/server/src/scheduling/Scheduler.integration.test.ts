import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as Tracer from "effect/Tracer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Scheduler from "./Scheduler.ts";

it.effect("idle scheduler ticks leave nothing in the trace", () =>
  Effect.gen(function* () {
    const spans: Array<string> = [];
    const tracer = Tracer.make({
      span: (options) => {
        spans.push(options.name);
        return new Tracer.NativeSpan(options);
      },
    });
    const layerWorkers = Layer.mergeAll(ScheduledTasks.layer, UsageLimitRecoveryWorker.layer).pipe(
      Layer.provide(
        Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () => Effect.succeed([]),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
        ),
      ),
      Layer.provide(Scheduler.layer),
    );
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("5 seconds");
      const started = spans.length;
      yield* TestClock.adjust("15 seconds");
      assert.deepEqual(spans.slice(started), []);
    }).pipe(Effect.provide(layerWorkers), Effect.withTracer(tracer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);
