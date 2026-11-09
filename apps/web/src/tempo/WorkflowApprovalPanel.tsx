import {
  type WorkflowApprovalView,
  workflowApprovalScriptNotice,
  workflowApprovalTitle,
} from "@t3tools/client-runtime/tempo/claude-workflows";
import { ChevronRightIcon, WorkflowIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../lib/utils";

/**
 * Claude asking to run a workflow: what it is called, what it says it does and
 * its phases, with the script itself one click away rather than as raw JSON.
 */
export function WorkflowApprovalPanel(props: {
  readonly workflow: WorkflowApprovalView;
  readonly pendingCount: number;
  readonly notResumable: boolean;
  readonly className?: string | undefined;
}) {
  const { workflow } = props;
  const [scriptOpen, setScriptOpen] = useState(false);
  const title = workflowApprovalTitle(workflow);
  const scriptNotice = workflowApprovalScriptNotice(workflow);
  return (
    <span
      aria-label="Workflow approval"
      className={cn("flex min-w-0 flex-1 flex-col items-start gap-1", props.className)}
      role="group"
    >
      <span className="flex w-full min-w-0 items-center gap-2 text-2xs text-muted-foreground">
        <span className="shrink-0 font-medium text-warning">Workflow approval</span>
        {props.pendingCount > 1 ? (
          <span className="ml-auto shrink-0 tabular-nums">1/{props.pendingCount}</span>
        ) : null}
      </span>
      {props.notResumable ? (
        <span className="text-xs text-foreground">
          Provider process is gone. Interrupt or restart the run to respond.
        </span>
      ) : (
        <span
          className="flex w-full min-w-0 flex-col gap-1 text-xs"
          data-approval-detail="complete"
        >
          <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
            <WorkflowIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{title}</span>
          </span>
          {workflow.description === null ? null : (
            <span className="text-muted-foreground">{workflow.description}</span>
          )}
          {workflow.phases.length === 0 ? null : (
            <ol className="m-0 list-decimal space-y-0.5 ps-5 text-muted-foreground">
              {workflow.phases.map((phase) => (
                <li key={phase.title}>
                  <span className="text-foreground">{phase.title}</span>
                  {phase.detail === undefined ? null : <span>: {phase.detail}</span>}
                </li>
              ))}
            </ol>
          )}
          {workflow.scriptPath === null ? null : (
            <code className="truncate font-mono text-2xs text-muted-foreground">
              {workflow.scriptPath}
            </code>
          )}
          {workflow.resumeFromRunId === null ? null : (
            <span className="text-2xs text-muted-foreground">
              Resumes run {workflow.resumeFromRunId}
            </span>
          )}
          {scriptNotice === null ? null : (
            <span className="text-2xs text-warning">{scriptNotice}</span>
          )}
          {workflow.script === null ? null : (
            <>
              <button
                type="button"
                aria-expanded={scriptOpen}
                onClick={() => setScriptOpen((open) => !open)}
                className="inline-flex w-fit items-center gap-1 text-2xs text-muted-foreground hover:text-foreground"
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn("size-3 transition-transform", scriptOpen && "rotate-90")}
                />
                {scriptOpen ? "Hide script" : "Show script"}
              </button>
              {scriptOpen ? (
                <code
                  aria-label="Workflow script"
                  tabIndex={0}
                  className="block max-h-48 w-full overflow-auto whitespace-pre font-mono text-2xs text-foreground [scrollbar-width:thin] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                >
                  {workflow.script}
                </code>
              ) : null}
            </>
          )}
        </span>
      )}
    </span>
  );
}
