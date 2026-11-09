/**
 * Tempo: a pending approval's timeline row label, worded like the approval card. A Claude workflow
 * shows the workflow; anything else a plain sentence, the command or tool in small mono text and
 * the complete request under Details. The row around it says when the process is gone.
 */
import { approvalCardView } from "@t3tools/client-runtime/tempo/approval-card";
import { workflowApprovalView } from "@t3tools/client-runtime/tempo/claude-workflows";

import { cn } from "~/lib/utils";
import type { PendingApproval } from "../session-logic";
import { WorkflowApprovalPanel } from "./WorkflowApprovalPanel";

/** Scrollable text is focusable so the keyboard can scroll it. */
const SCROLL_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";
/** tempo: the request in the tempo look's approval card sits in a filled inset. */
const TEMPO_INSET =
  "tempo:w-fit tempo:max-w-full tempo:rounded-tempo-card tempo:bg-message tempo:px-3.25 tempo:py-2.25 tempo:text-foreground";
/** The row's line turns selection off; an approval's text stays copyable. */
const SELECTABLE = "[&_:not(summary)]:select-text!";

export function ApprovalRowLabel(props: { approval: PendingApproval }) {
  const { approval } = props;
  const workflow = workflowApprovalView(approval.workflow);
  if (workflow !== null) {
    return (
      <span className={cn("flex min-w-0", SELECTABLE)}>
        <WorkflowApprovalPanel workflow={workflow} pendingCount={1} notResumable={false} />
      </span>
    );
  }
  const view = approvalCardView({
    requestKind: approval.requestKind,
    detail: approval.detail,
    appName: approval.appName,
    tool: approval.tool,
  });
  return (
    <span className={cn("flex min-w-0 flex-col gap-1 tempo:gap-2", SELECTABLE)}>
      <span
        className={cn(
          "max-h-24 min-w-0 overflow-y-auto whitespace-pre-wrap font-medium text-foreground wrap-anywhere [scrollbar-width:thin] tempo:font-semibold",
          SCROLL_FOCUS_RING,
        )}
        data-approval-title="true"
        tabIndex={0}
      >
        {view.title}
      </span>
      {view.subtitle !== null ? (
        <span className="text-xs text-muted-foreground wrap-anywhere">{view.subtitle}</span>
      ) : null}
      {view.summaryLine === null ? null : view.isCommand ? (
        <pre
          aria-label="Command"
          className={cn(
            "max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1 font-mono text-2xs text-muted-foreground wrap-anywhere [scrollbar-width:thin]",
            TEMPO_INSET,
            "tempo:text-tempo-label tempo:leading-5.25",
            SCROLL_FOCUS_RING,
          )}
          data-approval-command="true"
          tabIndex={0}
        >
          {view.summaryLine}
        </pre>
      ) : (
        <code
          aria-label="Tool"
          className={cn(
            "line-clamp-2 font-mono text-2xs text-muted-foreground wrap-anywhere",
            TEMPO_INSET,
            // The global code rule sets mono outside the layers, so only important beats it.
            "tempo:font-sans! tempo:text-tempo-list tempo:leading-5.25",
          )}
        >
          {view.summaryLine}
        </code>
      )}
      {view.rawDetails !== null ? (
        <details className="text-2xs text-muted-foreground">
          <summary className="w-fit cursor-pointer select-none hover:text-foreground">
            Details
          </summary>
          <pre
            aria-label="Complete request"
            className={cn(
              "mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 p-2 font-mono text-2xs text-foreground wrap-anywhere [scrollbar-width:thin]",
              SCROLL_FOCUS_RING,
            )}
            data-approval-detail="complete"
            tabIndex={0}
          >
            {view.rawDetails}
          </pre>
        </details>
      ) : null}
    </span>
  );
}
