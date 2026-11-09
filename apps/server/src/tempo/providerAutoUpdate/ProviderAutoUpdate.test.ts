import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstallState,
  type ServerProvider,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as CodexInstallation from "../../provider/CodexInstallation.ts";
import * as ProviderMaintenanceRunner from "../../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as ProviderAutoUpdate from "./ProviderAutoUpdate.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CLAUDE_ID = ProviderInstanceId.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const CODEX_ID = ProviderInstanceId.make("codex");
const CHECKED_AT = "2026-10-22T00:00:00.000Z";

const provider = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: CLAUDE_ID,
  driver: CLAUDE,
  enabled: true,
  installed: true,
  version: "2.1.300",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: CHECKED_AT,
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

/** Claude on 2.1.300 with `latestVersion` out, as its version check reports it. */
const behind = (latestVersion: string, overrides: Partial<ServerProvider> = {}) =>
  provider({
    versionAdvisory: {
      status: "behind_latest",
      currentVersion: "2.1.300",
      latestVersion,
      updateCommand: "claude update",
      canUpdate: true,
      checkedAt: CHECKED_AT,
      message: null,
    },
    ...overrides,
  });

const codexProvider = provider({ instanceId: CODEX_ID, driver: CODEX, version: "0.156.1" });

const codexInstalled = (installedVersion: string, pinnedVersion: string): ProviderInstallState => ({
  driver: CODEX,
  operationId: null,
  phase: "idle",
  downloadedBytes: 0,
  totalBytes: null,
  version: pinnedVersion,
  installedVersion,
  source: "managed",
  canRemove: true,
  message: null,
});

/**
 * Fakes for what the service reads and runs. The runner behaves like the real one: an update
 * that succeeds leaves the provider current, one that fails leaves it behind.
 */
const makeHarness = Effect.fn("makeHarness")(function* (input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly codex?: ProviderInstallState;
  readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
}) {
  const providers = yield* Ref.make(input.providers);
  const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
  const firstRead = yield* Deferred.make<void>();
  const outcome = yield* Ref.make<"succeeded" | "failed">("succeeded");
  const updates = yield* Ref.make<ReadonlyArray<ProviderInstanceId>>([]);
  const updated = yield* Deferred.make<void>();
  const codex = yield* Ref.make(input.codex ?? codexInstalled("0.156.1", "0.156.1"));
  const codexInstalls = yield* Ref.make(0);

  const registry = Layer.mock(ProviderRegistry.ProviderRegistry)({
    getProviders: Ref.get(providers).pipe(Effect.tap(() => Deferred.succeed(firstRead, undefined))),
    streamChanges: Stream.fromQueue(changes),
    refresh: () => Ref.get(providers),
  });
  const runner = Layer.mock(ProviderMaintenanceRunner.ProviderMaintenanceRunner)({
    updateProvider: (target) =>
      Effect.gen(function* () {
        const instanceId =
          typeof target === "string" ? CLAUDE_ID : (target.instanceId ?? CLAUDE_ID);
        yield* Ref.update(updates, (current) => [...current, instanceId]);
        const succeeded = (yield* Ref.get(outcome)) === "succeeded";
        const next = yield* Ref.updateAndGet(providers, (current) =>
          current.map((entry): ServerProvider => {
            if (entry.instanceId !== instanceId || entry.versionAdvisory === undefined) {
              return entry;
            }
            const updateState = {
              status: succeeded ? ("succeeded" as const) : ("failed" as const),
              startedAt: CHECKED_AT,
              finishedAt: CHECKED_AT,
              message: succeeded ? "Provider updated." : "Update command exited with code 1.",
              output: null,
            };
            return succeeded
              ? {
                  ...entry,
                  version: entry.versionAdvisory.latestVersion,
                  versionAdvisory: { ...entry.versionAdvisory, status: "current" },
                  updateState,
                }
              : { ...entry, updateState };
          }),
        );
        yield* Deferred.succeed(updated, undefined);
        return { providers: next };
      }),
  });
  const codexInstallation = Layer.mock(CodexInstallation.CodexInstallation)({
    managedDirectory: "/tmp/tempo-test/tools/codex",
    changes: Stream.empty,
    state: Ref.get(codex),
    start: Ref.update(codexInstalls, (count) => count + 1).pipe(
      Effect.andThen(
        Ref.updateAndGet(codex, (state) => ({ ...state, phase: "downloading" as const })),
      ),
    ),
  });
  const layer = ProviderAutoUpdate.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        registry,
        runner,
        codexInstallation,
        ServerSettingsService.layerTest(input.settings ?? {}),
        NodeSqliteClient.layer({ filename: ":memory:" }),
      ),
    ),
  );
  return {
    layer,
    providers,
    changes,
    firstRead,
    outcome,
    updates,
    updated,
    codex,
    codexInstalls,
  };
});

const createRunsTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE orchestration_v2_projection_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      provider TEXT NOT NULL,
      provider_instance_id TEXT,
      status TEXT NOT NULL,
      requested_at TEXT NOT NULL,
      payload_json TEXT NOT NULL
    )
  `;
});

const insertRun = (runId: string, instanceId: ProviderInstanceId, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, provider_instance_id, status, requested_at, payload_json)
      VALUES (${runId}, ${`thread-${runId}`}, 1, ${instanceId}, ${instanceId}, ${status}, '', '{}')
    `;
  });

const setRunStatus = (runId: string, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE run_id = ${runId}`;
  });

describe("ProviderAutoUpdate", () => {
  it.effect("updates a provider that is behind while it is idle, once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [behind("2.1.400")] });
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        const autoUpdate = yield* ProviderAutoUpdate.ProviderAutoUpdate;

        assert.isFalse(yield* autoUpdate.updateDue);
        assert.isFalse(yield* autoUpdate.updateDue);

        assert.deepStrictEqual(yield* Ref.get(harness.updates), [CLAUDE_ID]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("waits while a run on that provider is under way", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [behind("2.1.400"), codexProvider] });
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        yield* insertRun("codex-run", CODEX_ID, "running");
        yield* insertRun("claude-run", CLAUDE_ID, "waiting");
        const autoUpdate = yield* ProviderAutoUpdate.ProviderAutoUpdate;

        assert.isTrue(yield* autoUpdate.updateDue);
        assert.deepStrictEqual(yield* Ref.get(harness.updates), []);

        // A run on another provider does not hold Claude back.
        yield* setRunStatus("claude-run", "completed");
        assert.isFalse(yield* autoUpdate.updateDue);
        assert.deepStrictEqual(yield* Ref.get(harness.updates), [CLAUDE_ID]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("does not retry a failed update until the version changes or a day passes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [behind("2.1.400")] });
      yield* Ref.set(harness.outcome, "failed");
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        const autoUpdate = yield* ProviderAutoUpdate.ProviderAutoUpdate;

        yield* autoUpdate.updateDue;
        yield* TestClock.adjust("23 hours");
        yield* autoUpdate.updateDue;
        assert.strictEqual((yield* Ref.get(harness.updates)).length, 1);

        yield* TestClock.adjust("1 hour");
        yield* autoUpdate.updateDue;
        assert.strictEqual((yield* Ref.get(harness.updates)).length, 2);

        yield* Ref.set(harness.providers, [behind("2.1.401")]);
        yield* autoUpdate.updateDue;
        assert.strictEqual((yield* Ref.get(harness.updates)).length, 3);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("updates nothing when turned off, and never installs a broken version", () =>
    Effect.gen(function* () {
      const off = yield* makeHarness({
        providers: [behind("2.1.400")],
        codex: codexInstalled("0.156.1", "0.160.0"),
        settings: { tempoAutoUpdateProviders: false },
      });
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        assert.isFalse(yield* (yield* ProviderAutoUpdate.ProviderAutoUpdate).updateDue);
      }).pipe(Effect.provide(off.layer));
      assert.deepStrictEqual(yield* Ref.get(off.updates), []);
      assert.strictEqual(yield* Ref.get(off.codexInstalls), 0);

      const broken = yield* makeHarness({
        providers: [
          behind("2.1.400", {
            compatibilityAdvisory: {
              status: "supported",
              latestVersionStatus: "broken",
              message: null,
              recommendedVersion: null,
              recommendedRange: null,
            },
          }),
        ],
      });
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        yield* (yield* ProviderAutoUpdate.ProviderAutoUpdate).updateDue;
      }).pipe(Effect.provide(broken.layer));
      assert.deepStrictEqual(yield* Ref.get(broken.updates), []);
    }),
  );

  it.effect(
    "installs the Codex release this build pins when it is newer than the installed one",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          providers: [codexProvider],
          codex: codexInstalled("0.156.1", "0.160.0"),
        });
        yield* Effect.gen(function* () {
          yield* createRunsTable;
          yield* insertRun("codex-run", CODEX_ID, "running");
          const autoUpdate = yield* ProviderAutoUpdate.ProviderAutoUpdate;

          assert.isTrue(yield* autoUpdate.updateDue);
          assert.strictEqual(yield* Ref.get(harness.codexInstalls), 0);

          yield* setRunStatus("codex-run", "completed");
          yield* autoUpdate.updateDue;
          yield* autoUpdate.updateDue;
          assert.strictEqual(yield* Ref.get(harness.codexInstalls), 1);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("checks again a minute later while a run holds an update back", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [behind("2.1.400")] });
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        yield* insertRun("claude-run", CLAUDE_ID, "running");
        yield* (yield* ProviderAutoUpdate.ProviderAutoUpdate).start();

        yield* TestClock.adjust("5 minutes");
        assert.deepStrictEqual(yield* Ref.get(harness.updates), []);

        yield* setRunStatus("claude-run", "completed");
        yield* TestClock.adjust("1 minute");
        yield* Deferred.await(harness.updated);
        assert.deepStrictEqual(yield* Ref.get(harness.updates), [CLAUDE_ID]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("updates a provider as soon as its version check finds it behind", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ providers: [provider()] });
      yield* Effect.gen(function* () {
        yield* createRunsTable;
        yield* (yield* ProviderAutoUpdate.ProviderAutoUpdate).start();
        yield* Deferred.await(harness.firstRead);

        const next = [behind("2.1.400")];
        yield* Ref.set(harness.providers, next);
        yield* Queue.offer(harness.changes, next);
        yield* Deferred.await(harness.updated);
        assert.deepStrictEqual(yield* Ref.get(harness.updates), [CLAUDE_ID]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
