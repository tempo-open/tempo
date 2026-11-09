import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  ScheduledTaskUpsertInput,
  ThreadId,
  type TempoScheduledWait,
  type TempoWatcherWakeWhen,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as SecretRequests from "../../secrets/SecretRequests.ts";
import { ServerActivation } from "../../serverActivation.ts";
import { WatcherCheckError, WatcherCheckRunner } from "./WatcherCheckRunner.ts";
import type { WatcherCheckRun } from "./watcherDecision.ts";

const threadId = ThreadId.make("thread-watched");
const T0 = "2026-10-22T10:00:00.000Z";

const check = (overrides: Partial<WatcherCheckRun> = {}): WatcherCheckRun => ({
  exitCode: 0,
  timedOut: false,
  stdout: "",
  stderr: "",
  ...overrides,
});

/**
 * The scheduled task service with this test's thread and checks: each check
 * takes the next scripted result (a string fails the check with that message),
 * and the thread records what it was sent and the waits it was told about.
 */
function arrange() {
  const state = {
    checks: [] as Array<WatcherCheckRun | string>,
    sent: [] as Array<string>,
    waits: [] as ReadonlyArray<TempoScheduledWait>,
    waitCommands: 0,
  };
  const layer = ScheduledTaskService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        NodeCrypto.layer,
        Scheduler.layer,
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({
          launch: () => Effect.die("watchers never launch threads"),
        }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          sendToThread: (input) =>
            Effect.sync(() => {
              state.sent.push(input.text);
            }) as never,
          getThreadRecords: () =>
            Effect.sync(() => ({
              thread: { id: threadId, deletedAt: null, tempoScheduledWaits: state.waits },
            })) as never,
          dispatch: (command) =>
            Effect.sync(() => {
              if (command.type === "thread.scheduled-waits.set") {
                state.waits = command.waits;
                state.waitCommands += 1;
              }
              return { sequence: 1, storedEvents: [] };
            }),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
        Layer.succeed(WatcherCheckRunner, () =>
          Effect.suspend(() => {
            const next = state.checks.shift();
            if (next === undefined) return Effect.die("no check was scripted");
            return typeof next === "string"
              ? Effect.fail(new WatcherCheckError({ message: next }))
              : Effect.succeed(next);
          }),
        ),
      ),
    ),
  );
  return { state, layer };
}

const decodeInput = Schema.decodeUnknownSync(ScheduledTaskUpsertInput);
const taskInput = (overrides: Record<string, unknown> = {}) =>
  decodeInput({
    title: "API recovers",
    prompt: "Retry the import.",
    enabled: true,
    schedule: { type: "interval", everyMs: 300_000 },
    projectId: "project-watchers",
    threadId,
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "agent",
    creationSource: "mcp",
    ...overrides,
  });
const watcherInput = (wakeWhen: TempoWatcherWakeWhen) => ({
  ...taskInput(),
  threadId,
  check: { command: "curl -fsS https://api.example.com/health", wakeWhen },
});

const withService = <A, E>(
  harness: ReturnType<typeof arrange>,
  test: (
    service: ScheduledTaskService.ScheduledTaskService["Service"],
  ) => Effect.Effect<A, E, never>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(T0));
    return yield* Effect.flatMap(ScheduledTaskService.ScheduledTaskService, test).pipe(
      Effect.provide(harness.layer),
    );
  }).pipe(
    // Park the scheduler and the startup reconcile: each test drives its own runs.
    Effect.provideService(ServerActivation, Effect.never),
    Effect.provide(SqlitePersistence.layerMemory),
  );

describe("watchers", () => {
  it.effect("arm nothing when the first check already meets the condition", () => {
    const harness = arrange();
    harness.state.checks.push(check({ exitCode: 0, stdout: "healthy" }));
    return withService(harness, (service) =>
      Effect.gen(function* () {
        const armed = yield* service.armWatcher(watcherInput("succeeds"));
        assert.isNull(armed.task);
        assert.equal(armed.firstCheck.exitCode, 0);
        assert.deepEqual((yield* service.list()).tasks, []);
        assert.equal(harness.state.waitCommands, 0);
      }),
    );
  });

  it.effect("check quietly, wake the thread once the condition holds, then go away", () => {
    const harness = arrange();
    harness.state.checks.push(check({ exitCode: 22, stderr: "curl: (22) error: 429" }));
    return withService(harness, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.armWatcher(watcherInput("succeeds"));
        assert.isNotNull(task);
        if (task === null) return;
        assert.equal(task.nextRunAt, "2026-10-22T10:05:00.000Z");
        assert.equal(task.watcher?.expiresAt, "2026-10-29T10:00:00.000Z");
        assert.equal(task.watcher?.lastCheck?.output, "curl: (22) error: 429");
        assert.deepEqual(harness.state.waits, [
          { taskId: task.id, title: "API recovers", kind: "watcher" },
        ]);

        harness.state.checks.push(check({ exitCode: 22 }));
        yield* TestClock.adjust("5 minutes");
        const quiet = yield* service.runNow({ id: task.id });
        assert.isNull(quiet.threadId);
        assert.equal(quiet.task.lastRunStatus, "succeeded");
        assert.deepEqual(harness.state.sent, []);
        const [listed] = (yield* service.list()).tasks;
        assert.equal(listed?.watcher?.lastCheck?.checkedAt, "2026-10-22T10:05:00.000Z");

        harness.state.checks.push(check({ exitCode: 0, stdout: "healthy" }));
        yield* TestClock.adjust("5 minutes");
        const fired = yield* service.runNow({ id: task.id });
        assert.equal(fired.threadId, threadId);
        assert.isFalse(fired.task.enabled);
        assert.lengthOf(harness.state.sent, 1);
        const [wake] = harness.state.sent;
        assert.isTrue(wake?.startsWith("Retry the import.\n\n"));
        assert.include(wake, "exited 0 at 2026-10-22T10:10:00.000Z");
        assert.include(wake, "healthy");
        assert.deepEqual((yield* service.list()).tasks, []);
        assert.deepEqual(harness.state.waits, []);
      }),
    );
  });

  it.effect("compare output with the first check that exited 0", () => {
    const harness = arrange();
    harness.state.checks.push(check({ stdout: "in_progress\n" }));
    return withService(harness, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.armWatcher(watcherInput("output_changes"));
        if (task === null) return assert.fail("output_changes never fires on its first check");
        harness.state.checks.push(
          check({ exitCode: 6, stderr: "could not resolve host" }),
          check({ stdout: "in_progress" }),
          check({ stdout: "completed\n" }),
        );
        for (let run = 0; run < 2; run += 1) {
          yield* TestClock.adjust("5 minutes");
          yield* service.runNow({ id: task.id });
        }
        assert.deepEqual(harness.state.sent, []);
        yield* TestClock.adjust("5 minutes");
        yield* service.runNow({ id: task.id });
        assert.lengthOf(harness.state.sent, 1);
        assert.include(harness.state.sent[0], "printed new output");
        assert.include(harness.state.sent[0], "completed");
      }),
    );
  });

  it.effect("tell the thread when a watcher expires or its check cannot run", () => {
    const harness = arrange();
    harness.state.checks.push(check({ exitCode: 1 }), check({ exitCode: 1 }));
    return withService(harness, (service) =>
      Effect.gen(function* () {
        const expiring = (yield* service.armWatcher(watcherInput("succeeds"))).task;
        const broken = (yield* service.armWatcher(watcherInput("succeeds"))).task;
        if (expiring === null || broken === null) return assert.fail("both should be armed");

        harness.state.checks.push("its thread no longer exists");
        yield* service.runNow({ id: broken.id });
        assert.include(harness.state.sent[0], "could not run (its thread no longer exists)");

        // Past its lifetime the check does not even run.
        yield* TestClock.adjust("7 days");
        yield* service.runNow({ id: expiring.id });
        assert.include(harness.state.sent[1], "did not succeed within 7 days");
        assert.isTrue(harness.state.sent[1]?.endsWith("Retry the import."));
        assert.deepEqual((yield* service.list()).tasks, []);
        assert.deepEqual(harness.state.waits, []);
      }),
    );
  });

  it.effect("leave Waiting while paused, and arm afresh on resume", () => {
    const harness = arrange();
    harness.state.checks.push(check({ exitCode: 22 }));
    return withService(harness, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.armWatcher(watcherInput("succeeds"));
        if (task === null) return assert.fail("the watcher should be armed");
        yield* service.setEnabled({ id: task.id, enabled: false });
        assert.deepEqual(harness.state.waits, []);

        yield* TestClock.adjust("1 day");
        const resumed = yield* service.setEnabled({ id: task.id, enabled: true });
        assert.equal(resumed.task.watcher?.expiresAt, "2026-10-30T10:00:00.000Z");
        assert.deepEqual(
          harness.state.waits.map((wait) => wait.kind),
          ["watcher"],
        );

        // A watcher stays an interval task bound to its thread.
        const moved = yield* service
          .upsert({
            ...taskInput({ schedule: { type: "fixed_time", timeOfDay: "09:00" } }),
            id: task.id,
            requireExisting: true,
          })
          .pipe(Effect.flip);
        assert.include(moved.message, "A watcher runs on an interval");
      }),
    );
  });

  it.effect("record a recurring task bound to a thread among its waits", () => {
    const harness = arrange();
    return withService(harness, (service) =>
      Effect.gen(function* () {
        const { task } = yield* service.upsert(taskInput({ title: "Daily summary" }));
        assert.deepEqual(harness.state.waits, [
          { taskId: task.id, title: "Daily summary", kind: "schedule" },
        ]);
        const commands = harness.state.waitCommands;
        // A task that launches a fresh thread per run waits on no thread.
        yield* service.upsert(taskInput({ title: "Fresh thread", threadId: null }));
        assert.equal(harness.state.waitCommands, commands);

        yield* service.delete({ id: task.id });
        assert.deepEqual(harness.state.waits, []);

        // Settling a thread deletes every task bound to it at once.
        yield* service.upsert(taskInput({ title: "Weekly summary" }));
        yield* service.deleteForThread(threadId);
        assert.deepEqual(harness.state.waits, []);
      }),
    );
  });
});
