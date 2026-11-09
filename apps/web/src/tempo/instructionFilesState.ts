import { createTempoAgentFilesEnvironmentAtoms } from "@t3tools/client-runtime/state/tempo-agent-files";
import { createTempoInstructionFilesEnvironmentAtoms } from "@t3tools/client-runtime/state/tempo-instruction-files";

import { connectionAtomRuntime } from "../connection/runtime";

/** tempo: each environment's CLAUDE.md / AGENTS.md files. */
export const tempoInstructionFilesEnvironment =
  createTempoInstructionFilesEnvironmentAtoms(connectionAtomRuntime);

/** tempo: copying the person's agent files from one environment to another. */
export const tempoAgentFilesEnvironment =
  createTempoAgentFilesEnvironmentAtoms(connectionAtomRuntime);
