import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * tempo: copying the person's agent files (CLAUDE.md, AGENTS.md, skills, commands, agents,
 * workflows, rules and output styles) between environments: export where they are, then pass the
 * result's `files` and `links` to import on the other. Import is guarded by the destination's
 * settings grant (`importFiles.permissionAtom`).
 */
export function createTempoAgentFilesEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    exportFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo:export-agent-files",
      tag: WS_METHODS.tempoAgentFilesExport,
    }),
    importFiles: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo:import-agent-files",
      tag: WS_METHODS.tempoAgentFilesImport,
    }),
  };
}
