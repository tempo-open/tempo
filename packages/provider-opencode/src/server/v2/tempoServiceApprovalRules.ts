/**
 * tempo: service connection writes are never pre-approved. OpenCode applies the
 * last rule that matches, so these follow the rule that allows this thread's
 * whole T3 server: each write tool asks again, and the session's own "Allow
 * this session" grants for those tools apply after that. Full access adds none.
 */
import type { Permission } from "@opencode/client/effect";
import { TEMPO_SERVICE_APPROVAL_TOOL_NAMES } from "@t3tools/shared/tempoServiceToolNames";

export const tempoServiceApprovalRules = (
  mcpServerName: string,
  grants: ReadonlyArray<Permission.Rule>,
): ReadonlyArray<Permission.Rule> => {
  const actions = new Set(
    Array.from(TEMPO_SERVICE_APPROVAL_TOOL_NAMES, (tool) => `${mcpServerName}_${tool}`),
  );
  return [
    ...Array.from(actions, (action): Permission.Rule => ({ action, resource: "*", effect: "ask" })),
    ...grants.filter((grant) => actions.has(grant.action)),
  ];
};
