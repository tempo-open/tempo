import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { type Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * tempo: a server browser profile's extensions, saved passkeys and saved
 * passwords on one environment. `profile` is the query; every mutation
 * returns the new state and refreshes the query when it settles.
 */
export function createTempoBrowserEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const profile = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tempo:browser-profile",
    tag: WS_METHODS.tempoBrowserGetProfile,
    staleTimeMs: 5_000,
  });
  const refreshProfile = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly profileId: string };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(
        profile({
          environmentId: target.environmentId,
          input: { profileId: target.input.profileId },
        }),
      ),
    );
  // One lane per profile, so an install and a removal cannot race.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly profileId: string };
    }) => JSON.stringify([environmentId, input.profileId]),
  };
  const mutation = { scheduler, concurrency, onSettled: refreshProfile };
  return {
    profile,
    addExtension: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-add-extension",
      tag: WS_METHODS.tempoBrowserAddExtension,
      ...mutation,
    }),
    setExtensionEnabled: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-set-extension-enabled",
      tag: WS_METHODS.tempoBrowserSetExtensionEnabled,
      ...mutation,
    }),
    removeExtension: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-remove-extension",
      tag: WS_METHODS.tempoBrowserRemoveExtension,
      ...mutation,
    }),
    checkExtensionUpdates: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-check-extension-updates",
      tag: WS_METHODS.tempoBrowserCheckExtensionUpdates,
      ...mutation,
    }),
    setPasskeySettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-set-passkey-settings",
      tag: WS_METHODS.tempoBrowserSetPasskeySettings,
      ...mutation,
    }),
    removePasskey: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-remove-passkey",
      tag: WS_METHODS.tempoBrowserRemovePasskey,
      ...mutation,
    }),
    setPasswordSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-set-password-settings",
      tag: WS_METHODS.tempoBrowserSetPasswordSettings,
      ...mutation,
    }),
    removePassword: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-remove-password",
      tag: WS_METHODS.tempoBrowserRemovePassword,
      ...mutation,
    }),
    openExtensionPage: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-open-extension-page",
      tag: WS_METHODS.tempoBrowserOpenExtensionPage,
    }),
    forgetProfile: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:browser-forget-profile",
      tag: WS_METHODS.tempoBrowserForgetProfile,
      ...mutation,
    }),
  };
}
