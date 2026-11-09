import { useAtomValue } from "@effect/atom-react";
import {
  claudeWorkflowInstanceSettings,
  runUsedUltracode,
} from "@t3tools/client-runtime/tempo/claude-workflows";
import type { EnvironmentId, RunId } from "@t3tools/contracts";
import type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";

import { Badge } from "../components/ui/badge";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { serverEnvironment } from "../state/server";

/**
 * Marks a turn Claude ran with ultracode on, from the selection the run was
 * sent with. The server drops ultracode while the instance has workflows off,
 * so no badge shows then.
 */
export function UltracodeRunBadge(props: {
  readonly environmentId: EnvironmentId;
  readonly runId: RunId | null;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const run = props.runId === null ? undefined : props.runs.find((run) => run.id === props.runId);
  if (
    run === undefined ||
    !runUsedUltracode(run) ||
    !claudeWorkflowInstanceSettings(settings?.providerInstances[run.providerInstanceId]?.config)
      .workflowsEnabled
  ) {
    return null;
  }
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant="warning" size="sm" />}>ultracode</TooltipTrigger>
      <TooltipPopup>
        This turn ran with ultracode: a multi-agent workflow at extra-high effort.
      </TooltipPopup>
    </Tooltip>
  );
}
