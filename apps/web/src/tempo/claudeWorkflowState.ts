import { createTempoClaudeWorkflowAtoms } from "@t3tools/client-runtime/tempo/claude-workflow-atoms";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProviderInstanceId,
} from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "../state/query";
import { useEnvironmentScope } from "../state/session";

const tempoClaudeWorkflowAtoms = createTempoClaudeWorkflowAtoms(connectionAtomRuntime);

/**
 * Saved Claude workflows for a thread's cwd; null target skips the request, as
 * does a client without filesystem read access, which the server requires.
 */
export function useClaudeSavedWorkflows(
  target: {
    readonly environmentId: EnvironmentId;
    readonly cwd: string;
    readonly instanceId: ProviderInstanceId;
  } | null,
) {
  const canRead = useEnvironmentScope(target?.environmentId ?? null, AuthFilesystemReadScope);
  return useEnvironmentQuery(
    target === null || !canRead
      ? null
      : tempoClaudeWorkflowAtoms.savedWorkflows({
          environmentId: target.environmentId,
          input: { cwd: target.cwd, instanceId: target.instanceId },
        }),
  );
}
