/**
 * Tempo: the tool-approval card's body: a plain sentence first, the command or tool
 * in small mono text, and the complete request under Details.
 */
import { alwaysAllowLabel, approvalCardView } from "@t3tools/client-runtime/tempo/approval-card";
import { memo } from "react";

import { cn } from "~/lib/utils";
import type { PendingApproval } from "../session-logic";

function viewOf(approval: PendingApproval) {
  return approvalCardView({
    requestKind: approval.requestKind,
    detail: approval.detail,
    appName: approval.appName,
    tool: approval.tool,
  });
}

/** The default "Always allow" label, naming the tool it covers. */
export function approvalAlwaysAllowLabel(approval: PendingApproval): string {
  return alwaysAllowLabel(viewOf(approval));
}

/** Scrollable text is focusable so the keyboard can scroll it. */
const SCROLL_FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function groupLabel(kind: PendingApproval["requestKind"]): string {
  switch (kind) {
    case "mcp-elicitation":
      return "App access approval";
    case "command":
      return "Command approval";
    case "file-read":
      return "File read approval";
    case "permission":
      return "App permission approval";
    default:
      return "File change approval";
  }
}

export const ApprovalCard = memo(function ApprovalCard(props: {
  approval: PendingApproval;
  pendingCount: number;
  className?: string | undefined;
}) {
  const { approval, pendingCount, className } = props;
  const view = viewOf(approval);
  const isGone = approval.responseCapability === "not_resumable";

  return (
    <span
      aria-label={groupLabel(approval.requestKind)}
      className={cn("flex min-w-0 flex-1 flex-col gap-1", className)}
      role="group"
    >
      <span className="flex min-w-0 items-start gap-2">
        {/* Its own sentence names it; an aria-label would hide that sentence from screen readers. */}
        <span
          className={cn(
            "max-h-24 min-w-0 flex-1 overflow-y-auto whitespace-pre-wrap text-sm font-semibold leading-snug text-foreground wrap-anywhere [scrollbar-width:thin]",
            SCROLL_FOCUS_RING,
          )}
          data-approval-title="true"
          tabIndex={0}
        >
          {isGone ? "Provider process is gone" : view.title}
        </span>
        {pendingCount > 1 ? (
          <span className="shrink-0 pt-0.5 text-2xs tabular-nums text-muted-foreground">
            1/{pendingCount}
          </span>
        ) : null}
      </span>
      {isGone ? (
        <span className="text-xs text-muted-foreground">
          Interrupt or restart the run to respond.
        </span>
      ) : view.subtitle !== null ? (
        <span className="text-xs text-muted-foreground wrap-anywhere">{view.subtitle}</span>
      ) : null}
      {view.summaryLine !== null && !isGone ? (
        view.isCommand ? (
          <pre
            aria-label="Command"
            className={cn(
              "max-h-24 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1 font-mono text-2xs text-muted-foreground wrap-anywhere [scrollbar-width:thin]",
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
            className="line-clamp-2 font-mono text-2xs text-muted-foreground wrap-anywhere"
          >
            {view.summaryLine}
          </code>
        )
      ) : null}
      {view.rawDetails !== null && !isGone ? (
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
});
