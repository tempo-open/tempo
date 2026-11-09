/**
 * TempoManagedProviders - what the provider registry runs in Tempo: the two drivers and the instance
 * map the provider policy derives from settings, plus the refusals for setup operations Tempo runs
 * itself (installs, ChatGPT handoff, ACP registry agents).
 *
 * @module TempoManagedProviders
 */
import {
  AcpRegistryOperationError,
  TEMPO_PROVIDERS_MANAGED_MESSAGE,
  type ProviderInstanceConfigMap,
  type ProviderInstanceId,
  type ProviderInstanceMutation,
  ProviderSetupError,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import type { AnyProviderDriver } from "@t3tools/provider-core/server/driver";

import * as ServerConfig from "../config.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import * as Settings from "../serverSettings.ts";
import {
  TempoClaudeDriver,
  TempoCodexDriver,
  type TempoProviderDriversEnv,
} from "./TempoProviderDrivers.ts";
import { resolveNativeHomes } from "./nativeAgentSync/nativeHomes.ts";
import {
  checkSettingsWrite,
  codexHomeOf,
  tempoProviderSettingsView,
  managedProviderInstanceConfigMap,
} from "./ProviderPolicy.ts";

export type { TempoProviderDriversEnv } from "./TempoProviderDrivers.ts";

/** The only drivers the registry knows in Tempo. */
export const TEMPO_PROVIDER_DRIVERS: ReadonlyArray<AnyProviderDriver<TempoProviderDriversEnv>> = [
  TempoCodexDriver,
  TempoClaudeDriver,
];

/** Services `configMap` reads. */
export type TempoManagedProvidersEnv = ServerConfig.ServerConfig | Path.Path;

/** Where Codex runs: this Mac's own Codex home (see `codexHomeOf`). */
const resolveCodexHome = Effect.fn("TempoManagedProviders.resolveCodexHome")(function* () {
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  const { codex } = yield* resolveNativeHomes({ baseDir });
  return codexHomeOf(codex, baseDir, path.join);
});

/** Claude and Codex for these settings, each on this Mac's own sign-in. */
export const configMap = Effect.fn("TempoManagedProviders.configMap")(function* (
  settings: Pick<ServerSettings, "providerInstances">,
): Effect.fn.Return<ProviderInstanceConfigMap, never, TempoManagedProvidersEnv> {
  return managedProviderInstanceConfigMap(settings, yield* resolveCodexHome());
});

/**
 * The settings service every server component reads, with the provider
 * policy applied (see `tempoProviderSettingsView`): only Claude and Codex,
 * always enabled, with the homes they run from.
 */
export const serverSettingsLayer = Layer.unwrap(
  Effect.gen(function* () {
    // Decided once: this view runs on every settings read.
    const codexHome = yield* resolveCodexHome();
    return Settings.layerWithReadView((settings) => tempoProviderSettingsView(settings, codexHome));
  }),
);

/** The Codex runtime Tempo runs: only the release this build pins, never a `codex` on PATH. */
export const codexInstallationLayer = Layer.effect(
  CodexInstallation.CodexInstallation,
  Effect.gen(function* () {
    const { baseDir } = yield* ServerConfig.ServerConfig;
    return yield* CodexInstallation.makeCodexInstallation({ baseDir, pinned: true });
  }),
);

/**
 * Refuses a settings write that would add a provider, remove Claude or Codex,
 * change how they launch, or turn one off for a project. Nothing reads such
 * entries anyway; this tells the client why its edit did nothing.
 */
export const guardSettingsWrite = Effect.fn("TempoManagedProviders.guardSettingsWrite")(function* (
  patch: Pick<ServerSettingsPatch, "providerInstances" | "projectSettingsOverrides">,
  mutation: ProviderInstanceMutation | undefined,
) {
  if (
    mutation === undefined &&
    patch.providerInstances === undefined &&
    patch.projectSettingsOverrides === undefined
  ) {
    return;
  }
  const settings = yield* (yield* Settings.ServerSettingsService).getSettings;
  const refusal = checkSettingsWrite(settings, patch, mutation);
  if (refusal !== undefined) return yield* refusal;
});

const refuse = (operation: string) => (input: { readonly instanceId: ProviderInstanceId }) =>
  Effect.fail(
    new ProviderSetupError({
      instanceId: input.instanceId,
      operation,
      detail: TEMPO_PROVIDERS_MANAGED_MESSAGE,
    }),
  );

const refuseStream = (operation: string) => (input: { readonly instanceId: ProviderInstanceId }) =>
  Stream.fail(
    new ProviderSetupError({
      instanceId: input.instanceId,
      operation,
      detail: TEMPO_PROVIDERS_MANAGED_MESSAGE,
    }),
  );

/** `provider.install.*`: Tempo installs the pinned Codex itself; clients cannot. */
export const providerInstallation = {
  start: refuse("install"),
  cancel: refuse("cancel-install"),
  subscribe: refuseStream("subscribe-install"),
  remove: refuse("remove-install"),
};

/** `provider.chatgpt.handoff.subscribe`: Codex uses its own sign-in on this Mac. */
export const chatGptHandoff = refuseStream("chatgpt-handoff");

/** `server.prepareAcpRegistryAgent` and `server.uninstallAcpRegistryManagedBinary`: no other agents. */
export const acpRegistryInstall = (_input: unknown) =>
  Effect.fail(
    new AcpRegistryOperationError({
      reason: "agent_not_configured",
      message: TEMPO_PROVIDERS_MANAGED_MESSAGE,
    }),
  );
