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
 * tempo: one environment's service connections. `connections` is the query (the
 * ones saved on this environment); saving and removing return the new list and
 * refresh the query when they settle.
 */
export function createTempoServicesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const connections = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tempo:service-connections",
    tag: WS_METHODS.tempoListServiceConnections,
  });
  const refresh = (
    target: { readonly environmentId: EnvironmentId },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() =>
      registry.refresh(connections({ environmentId: target.environmentId, input: {} })),
    );
  // One lane per environment, so a save and a removal cannot race.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: EnvironmentId }) => environmentId,
  };
  return {
    connections,
    saveLocal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:save-service-connection",
      tag: WS_METHODS.tempoSaveLocalServiceConnection,
      scheduler,
      concurrency,
      onSettled: refresh,
    }),
    removeLocal: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:remove-service-connection",
      tag: WS_METHODS.tempoRemoveLocalServiceConnection,
      scheduler,
      concurrency,
      onSettled: refresh,
    }),
    // Changes nothing, so it does not wait behind saves or refresh the list.
    test: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:test-service-connection",
      tag: WS_METHODS.tempoTestServiceConnection,
    }),
  };
}
