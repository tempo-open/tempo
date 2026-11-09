/**
 * tempo: "Run new work on" for this device (web and desktop). The choice is
 * a client setting, so each device keeps its own; see
 * `@t3tools/client-runtime/tempo/new-work-environment`.
 */
import { hasRelayRoute } from "@t3tools/client-runtime/connection";
import {
  newWorkEnvironmentOptions,
  resolveNewWorkEnvironmentId,
} from "@t3tools/client-runtime/tempo/new-work-environment";
import type { ClientSettings, EnvironmentId } from "@t3tools/contracts";

import { getClientSettings, updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";

export function useNewWorkEnvironmentOptions() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  return newWorkEnvironmentOptions({
    primaryEnvironmentId,
    environments: environments.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      enabled: environment.entry.enabled,
      relayManaged: environment.relayManaged,
    })),
  });
}

const selectChoice = (settings: ClientSettings) => settings.newWorkEnvironmentId;

/** Where new projects, threads without a project, and scratch threads start on this device. */
export function useNewWorkEnvironmentId(): EnvironmentId | null {
  const options = useNewWorkEnvironmentOptions();
  const choice = useClientSettings(selectChoice);
  return resolveNewWorkEnvironmentId({ choice, options });
}

/** The same environment, read when a command runs outside React (the chat route shortcuts). */
export function readNewWorkEnvironmentId(): EnvironmentId | null {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  const options = newWorkEnvironmentOptions({
    primaryEnvironmentId: appAtomRegistry.get(primaryEnvironmentIdAtom),
    environments: [...presentations].map(([environmentId, presentation]) => ({
      environmentId,
      label: presentation.entry.target.label,
      enabled: presentation.entry.enabled,
      relayManaged: hasRelayRoute(presentation.entry),
    })),
  });
  return resolveNewWorkEnvironmentId({ choice: getClientSettings().newWorkEnvironmentId, options });
}

/** Saves this device's choice; null goes back to the default. */
export function setNewWorkEnvironment(environmentId: EnvironmentId | null) {
  return updateClientSettings({ newWorkEnvironmentId: environmentId });
}
