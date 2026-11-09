import { TEMPO_CLAUDE_WORKFLOWS_WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcQueryAtomFamily } from "../state/runtime.ts";

/** Tempo Claude workflow queries, bound to a client's connection runtime. */
export function createTempoClaudeWorkflowAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    /** Saved `.claude/workflows` for a thread's cwd; files change rarely. */
    savedWorkflows: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:tempo:claude-saved-workflows",
      tag: TEMPO_CLAUDE_WORKFLOWS_WS_METHODS.listSaved,
      staleTimeMs: 60_000,
      idleTtlMs: 120_000,
    }),
  };
}
