/**
 * Tempo's provider instance registry: the two drivers, hydrated from the provider policy instead of
 * `settings.providerInstances`. It replaces `ProviderInstanceRegistryHydration.layer` in the
 * server's layer graph (upstream's layer stays for its own tests). Only instances whose envelope
 * changed are rebuilt.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as AcpRegistrySupport from "@t3tools/provider-acp-registry/server/AcpRegistrySupport";
import type * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";

import type * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import type * as ServerConfig from "../config.ts";
import type * as PortScanner from "../preview/PortScanner.ts";
import * as ProviderHostLive from "../provider/ProviderHostLive.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderInstanceRegistryMutator from "../provider/ProviderInstanceRegistryMutator.ts";
import * as ProviderOrchestrationAdapterInfrastructure from "../provider/ProviderOrchestrationAdapterInfrastructure.ts";
import * as Settings from "../serverSettings.ts";
import * as TempoManagedProviders from "./TempoManagedProviders.ts";

type TempoProviderRegistryEnv =
  | Exclude<
      TempoManagedProviders.TempoProviderDriversEnv,
      | ProviderOrchestrationAdapterInfrastructure.ProviderOrchestrationAdapterInfrastructure
      | AcpRegistrySupport.AcpRegistryCatalog
      | ProviderHost.ProviderHost
    >
  | TempoManagedProviders.TempoManagedProvidersEnv
  | Settings.ServerSettingsService
  // Requirements of the `ProviderHost.ProviderHost` the drivers receive.
  | BackgroundPolicy.BackgroundPolicy
  | PortScanner.PortDiscovery
  | ServerConfig.ServerConfig;

const layerWatcher = Layer.effectDiscard(
  Effect.gen(function* () {
    const mutator = yield* ProviderInstanceRegistryMutator.ProviderInstanceRegistryMutator;
    const serverSettings = yield* Settings.ServerSettingsService;
    const settingsChanges = yield* serverSettings.subscribeChanges;
    yield* settingsChanges.pipe(
      Stream.runForEach((settings) =>
        Effect.gen(function* () {
          yield* mutator.reconcile(yield* TempoManagedProviders.configMap(settings));
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("ProviderInstanceRegistry reconcile failed", cause),
          ),
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("Tempo provider registry watcher stopped", cause),
      ),
      Effect.forkScoped,
    );
  }),
);

export const layer: Layer.Layer<
  ProviderInstanceRegistry.ProviderInstanceRegistry,
  never,
  TempoProviderRegistryEnv
> = Layer.unwrap(
  Effect.gen(function* () {
    const serverSettings = yield* Settings.ServerSettingsService;
    const initialSettings = yield* serverSettings.getSettings.pipe(
      Effect.orElseSucceed(() => ({ providerInstances: {} })),
    );
    const layerMutable = ProviderInstanceRegistry.layer({
      drivers: TempoManagedProviders.TEMPO_PROVIDER_DRIVERS,
      configMap: yield* TempoManagedProviders.configMap(initialSettings),
    }).pipe(
      Layer.provide(ProviderOrchestrationAdapterInfrastructure.layer),
      Layer.provide(AcpRegistrySupport.layerFromHost),
      Layer.provide(ProviderHostLive.layer),
    );
    return layerWatcher.pipe(Layer.provideMerge(layerMutable));
  }),
);
