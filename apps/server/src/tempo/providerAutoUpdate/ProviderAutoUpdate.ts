/**
 * tempo: servers update their provider CLIs themselves (ProviderMaintenanceRunner.updateProvider),
 * skipping versions known broken or unsupported. An update waits until no run of that provider is
 * under way, and a version is tried at most once a day, so failures never loop. Codex installs its
 * build's pinned managed release beside the old one. `tempoAutoUpdateProviders` turns it all off.
 */
import {
  ProviderDriverKind,
  type ProviderInstallState,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as CodexInstallation from "../../provider/CodexInstallation.ts";
import * as ProviderMaintenanceRunner from "../../provider/providerMaintenanceRunner.ts";
import * as ProviderRegistry from "../../provider/ProviderRegistry.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import { forkParked } from "../../serverActivation.ts";

const BUSY_RECHECK = Duration.minutes(1);
const RETRY_AFTER = Duration.days(1);
/** So a server no client watches still finds new versions. */
const REFRESH_INTERVAL = Duration.hours(6);
const CODEX = ProviderDriverKind.make("codex");

export class ProviderAutoUpdate extends Context.Service<
  ProviderAutoUpdate,
  {
    /** One pass: runs each due update in turn. True when one waits for a run to end. */
    readonly updateDue: Effect.Effect<boolean>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/tempo/providerAutoUpdate/ProviderAutoUpdate") {}

interface DueUpdate {
  readonly key: string;
  readonly driver: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | null;
  readonly version: string;
  /** Runs on any of these hold the update back: instances of one driver can share a CLI. */
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly run: Effect.Effect<void>;
}

/** The one-click update Settings → Providers offers (`canUpdateEnvironmentProvider` on mobile). */
function latestVersionToInstall(provider: ServerProvider): string | null {
  const advisory = provider.versionAdvisory;
  const compatibility = provider.compatibilityAdvisory?.latestVersionStatus;
  return provider.enabled &&
    provider.installed &&
    provider.availability !== "unavailable" &&
    advisory?.status === "behind_latest" &&
    advisory.canUpdate &&
    advisory.updateCommand !== null &&
    compatibility !== "broken" &&
    compatibility !== "unsupported" &&
    provider.updateState?.status !== "queued" &&
    provider.updateState?.status !== "running"
    ? advisory.latestVersion
    : null;
}

const installing = (state: ProviderInstallState) =>
  state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying";

const make = Effect.gen(function* () {
  const registry = yield* ProviderRegistry.ProviderRegistry;
  const runner = yield* ProviderMaintenanceRunner.ProviderMaintenanceRunner;
  const codexInstallation = yield* CodexInstallation.CodexInstallation;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const wake = yield* Queue.sliding<void>(1);
  const signal = Queue.offer(wake, undefined).pipe(Effect.asVoid);
  const attempts = yield* Ref.make<ReadonlyMap<string, { version: string; at: number }>>(new Map());

  // Reading the settings loads every stored secret, so the two switches are kept here.
  const switches = yield* Ref.make({ autoUpdate: false, updateChecks: false });
  const noteSettings = (current: ServerSettings) =>
    Ref.getAndSet(switches, {
      autoUpdate: current.tempoAutoUpdateProviders,
      updateChecks: current.enableProviderUpdateChecks,
    }).pipe(
      Effect.flatMap((previous) =>
        previous.autoUpdate === current.tempoAutoUpdateProviders ? Effect.void : signal,
      ),
    );
  const settingsChanges = yield* settings.subscribeChanges;
  yield* settings.getSettings.pipe(
    Effect.flatMap(noteSettings),
    Effect.catch((cause) =>
      Effect.logWarning("provider auto-update could not read settings", { cause }),
    ),
  );
  yield* Stream.runForEach(settingsChanges, noteSettings).pipe(Effect.forkScoped);

  // The first term matches the recovery index's predicate, so SQLite reads only that small index.
  // While an update waits, every pass asks again, so the check stays out of the trace.
  const runUnderWay = (instanceIds: ReadonlyArray<ProviderInstanceId>) =>
    sql<{ readonly found: number }>`
      SELECT 1 AS found FROM orchestration_v2_projection_runs
      WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
        AND status <> 'queued'
        AND provider_instance_id IN ${sql.in(instanceIds)}
      LIMIT 1
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      // Unknown counts as under way; the next check tries again.
      Effect.orElseSucceed(() => true),
      Effect.withTracerEnabled(false),
    );

  const updateProvider = (provider: ServerProvider, version: string) =>
    runner.updateProvider({ provider: provider.driver, instanceId: provider.instanceId }).pipe(
      Effect.map(
        ({ providers }) =>
          providers.find((candidate) => candidate.instanceId === provider.instanceId)?.updateState
            ?.status ?? "unknown",
      ),
      Effect.catchTags({ ServerProviderUpdateError: (error) => Effect.succeed(error.reason) }),
      Effect.flatMap((outcome) =>
        Effect.logInfo("provider auto-update finished", {
          driver: provider.driver,
          instanceId: provider.instanceId,
          version,
          outcome,
        }),
      ),
    );

  // The new release goes beside the running one, and new sessions pick it up once it is active.
  const installCodex = (version: string) =>
    codexInstallation.start.pipe(
      Effect.flatMap(() => Effect.logInfo("provider auto-update installing Codex", { version })),
      Effect.catchTags({
        CodexInstallationError: (error) =>
          Effect.logWarning("provider auto-update could not install Codex", {
            version,
            operation: error.operation,
          }),
      }),
    );

  const findDue = Effect.gen(function* () {
    if (!(yield* Ref.get(switches)).autoUpdate) return [];
    const providers = yield* registry.getProviders;
    const instanceIdsOf = (driver: ProviderDriverKind) =>
      providers
        .filter((provider) => provider.driver === driver)
        .map(({ instanceId }) => instanceId);
    const due = providers.flatMap((provider): ReadonlyArray<DueUpdate> => {
      const version = latestVersionToInstall(provider);
      return version === null
        ? []
        : [
            {
              key: `instance:${provider.instanceId}`,
              driver: provider.driver,
              instanceId: provider.instanceId,
              version,
              instanceIds: instanceIdsOf(provider.driver),
              run: updateProvider(provider, version),
            },
          ];
    });
    const codex = yield* codexInstallation.state;
    if (
      providers.some((provider) => provider.driver === CODEX && provider.enabled) &&
      codex.source === "managed" &&
      codex.version !== null &&
      codex.installedVersion !== null &&
      !installing(codex) &&
      compareSemverVersions(codex.version, codex.installedVersion) > 0
    ) {
      due.push({
        key: "codex-runtime",
        driver: CODEX,
        instanceId: null,
        version: codex.version,
        instanceIds: instanceIdsOf(CODEX),
        run: installCodex(codex.version),
      });
    }
    const now = yield* Clock.currentTimeMillis;
    const tried = yield* Ref.get(attempts);
    return due.filter((update) => {
      const last = tried.get(update.key);
      return last?.version !== update.version || now - last.at >= Duration.toMillis(RETRY_AFTER);
    });
  });

  const runUpdate = Effect.fn("ProviderAutoUpdate.update")(function* (update: DueUpdate) {
    yield* Effect.annotateCurrentSpan({
      driver: update.driver,
      instanceId: update.instanceId,
      version: update.version,
    });
    const at = yield* Clock.currentTimeMillis;
    yield* Ref.update(attempts, (current) =>
      new Map(current).set(update.key, { version: update.version, at }),
    );
    yield* update.run;
  });

  const updateDue: ProviderAutoUpdate["Service"]["updateDue"] = Effect.gen(function* () {
    let waiting = false;
    for (const update of yield* findDue) {
      if (yield* runUnderWay(update.instanceIds)) waiting = true;
      else yield* runUpdate(update);
    }
    return waiting;
  }).pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning("provider auto-update pass failed", { cause }).pipe(Effect.as(false)),
    ),
  );

  // A host with no client watching probes its providers only at startup, so their advisories
  // would never learn of a newer version.
  const refreshProviders = Effect.sleep(REFRESH_INTERVAL).pipe(
    Effect.andThen(Ref.get(switches)),
    Effect.flatMap(({ autoUpdate, updateChecks }) =>
      autoUpdate && updateChecks ? registry.refresh().pipe(Effect.andThen(signal)) : Effect.void,
    ),
    Effect.forever,
  );

  const start: ProviderAutoUpdate["Service"]["start"] = () =>
    forkParked(
      Effect.all(
        [
          Stream.runForEach(registry.streamChanges, () => signal),
          refreshProviders,
          updateDue.pipe(
            Effect.flatMap((waiting) =>
              waiting
                ? Queue.take(wake).pipe(Effect.timeoutOption(BUSY_RECHECK))
                : Queue.take(wake),
            ),
            Effect.forever,
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );

  return ProviderAutoUpdate.of({ updateDue, start });
});

export const layer = Layer.effect(ProviderAutoUpdate, make);
