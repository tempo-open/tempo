import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

/**
 * tempo: one environment's agent instruction files (CLAUDE.md, AGENTS.md,
 * rules, auto memory). `list` and `file` are queries; a save or delete refreshes
 * every list of that environment and that file when it settles, conflict or not.
 */
export function createTempoInstructionFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  // Bumped after each change so every list of the environment (all projects or one) refetches.
  const listRevisions = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.withLabel(`tempo-instruction-files-revision:${environmentId}`)),
  );
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tempo:instruction-files",
    tag: WS_METHODS.tempoInstructionFilesList,
    refreshTrigger: ({ environmentId }) => listRevisions(environmentId),
  });
  const file = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:tempo:instruction-file",
    tag: WS_METHODS.tempoInstructionFilesRead,
  });
  const refresh = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly path: string; readonly via?: string };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.update(listRevisions(target.environmentId), (revision) => revision + 1);
      registry.refresh(
        file({
          environmentId: target.environmentId,
          input: {
            path: target.input.path,
            ...(target.input.via === undefined ? {} : { via: target.input.via }),
          },
        }),
      );
    });
  // One lane per file, so a save and a delete of the same file cannot race.
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: (target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly path: string };
    }) => `${target.environmentId}\0${target.input.path}`,
  };
  return {
    list,
    file,
    write: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:write-instruction-file",
      tag: WS_METHODS.tempoInstructionFilesWrite,
      scheduler,
      concurrency,
      onSettled: refresh,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:tempo:delete-instruction-file",
      tag: WS_METHODS.tempoInstructionFilesDelete,
      scheduler,
      concurrency,
      onSettled: refresh,
    }),
  };
}
