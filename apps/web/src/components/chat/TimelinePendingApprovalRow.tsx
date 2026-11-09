import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { ShieldIcon } from "lucide-react";
import { memo, use } from "react";
import { type PendingApproval } from "../../session-logic";
import { approvalAlwaysAllowLabel } from "../../tempo/ApprovalCard";
import { ApprovalRowLabel } from "../../tempo/ApprovalRowLabel";
import { AppLogo } from "../../tempo/threadLogos/ThreadLogo";
import { useTempoLook } from "../../tempo/look/useTempoLook";
import { InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { ToolActivityIconView, type WorkEntryIconName } from "./TimelineToolActivityIcon";
import { TimelineRowCtx } from "./timelineRowContext";
import { WorkLogRow } from "./WorkLog";

const APPROVAL_PRESENTATION = {
  command: { icon: "terminal", label: "Command approval", detailLabel: "Command" },
  "file-change": { icon: "square-pen", label: "File change approval", detailLabel: "File change" },
  "file-read": { icon: "eye", label: "File read approval", detailLabel: "File to read" },
  permission: {
    icon: "wrench",
    label: "App permission approval",
    detailLabel: "Permission request",
  },
  "mcp-elicitation": {
    icon: "hammer",
    label: "App access approval",
    detailLabel: "App access request",
  },
} satisfies Record<
  PendingApproval["requestKind"],
  { icon: WorkEntryIconName; label: string; detailLabel: string }
>;

export const TimelinePendingApprovalRow = memo(function TimelinePendingApprovalRow({
  approval,
}: {
  approval: PendingApproval;
}) {
  const { respondingRequestIds, canOperateThread, onRespondToApproval } = use(TimelineRowCtx);
  const presentation = APPROVAL_PRESENTATION[approval.requestKind];
  const canRespond = approval.responseCapability === "live";
  const look = useTempoLook();
  const fullAccessOverride = approval.fullAccessOverride ? (
    <Popover>
      <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
        {FULL_ACCESS_OVERRIDE_QUESTION}
      </PopoverTrigger>
      <PopoverPopup
        aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
        tooltipStyle
        side="top"
        className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
      >
        {fullAccessOverrideExplanation(approval.fullAccessOverride)}
      </PopoverPopup>
    </Popover>
  ) : null;
  // tempo: the tempo look gives an approval its own card, the actions as
  // buttons at its foot.
  if (look === "tempo") {
    const icon = (
      <ToolActivityIconView
        icon={undefined}
        fallbackName={presentation.icon}
        className="block size-4 shrink-0 stroke-2"
        muted
      />
    );
    const actions =
      canRespond && onRespondToApproval ? (
        <ComposerPendingApprovalActions
          presentation="card"
          requestId={approval.requestId}
          disabled={!canOperateThread}
          isResponding={respondingRequestIds.includes(approval.requestId)}
          canRespond={canRespond}
          options={approval.options}
          alwaysAllowLabel={approvalAlwaysAllowLabel(approval)}
          onRespondToApproval={onRespondToApproval}
        />
      ) : null;
    return (
      <div
        role="group"
        aria-label={presentation.label}
        data-v2-item-type="approval_request"
        className="mb-4 rounded-tempo-card bg-card px-4 py-3.5 ring-1 ring-tempo-hair-2"
      >
        <div className="flex min-w-0 items-center gap-2.25 text-tempo-label text-muted-foreground">
          {approval.appName ? (
            <AppLogo name={approval.appName} fallback={icon} className="size-4.25" />
          ) : (
            icon
          )}
          <span className="min-w-0 truncate">
            {approval.appName ? `${approval.appName} needs your approval` : presentation.label}
          </span>
          <span className="ms-auto shrink-0 text-tempo-caption font-medium text-warning">
            {canRespond ? "Waiting" : "Process gone"}
          </span>
        </div>
        <div className="mt-2.5 text-tempo-body">
          <ApprovalRowLabel approval={approval} />
        </div>
        {approval.reason ? (
          <p className="mt-1.5 text-tempo-label text-muted-foreground select-text wrap-anywhere">
            {approval.reason}
          </p>
        ) : null}
        {canRespond ? null : (
          <p className="mt-1.5 text-tempo-label text-warning">
            Interrupt or restart the run to respond.
          </p>
        )}
        {fullAccessOverride || actions ? (
          <div className="mt-3.5 flex flex-wrap items-center justify-end gap-1.5">
            {fullAccessOverride ? <span className="me-auto">{fullAccessOverride}</span> : null}
            {actions}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <WorkLogRow
      role="group"
      aria-label={presentation.label}
      data-v2-item-type="approval_request"
      wrapLabel
      icon={
        <ToolActivityIconView
          icon={undefined}
          fallbackName={presentation.icon}
          className="block size-4 shrink-0 stroke-2 text-icon-muted"
          muted
        />
      }
      // tempo: Tempo's approval card wording (a plain sentence, the tool in mono) instead of the raw request.
      label={<ApprovalRowLabel approval={approval} />}
    >
      <div className="ms-7.5 flex min-w-0 flex-col gap-1 pb-1 text-xs">
        {approval.appName ? (
          <span className="text-muted-foreground wrap-anywhere">{approval.appName}</span>
        ) : null}
        {approval.reason ? (
          <span className="text-muted-foreground select-text wrap-anywhere">{approval.reason}</span>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {canRespond ? (
            <>
              <span className="inline-flex items-center gap-1 text-warning">
                <ShieldIcon aria-hidden className="size-3 shrink-0" />
                Waiting for approval
              </span>
              {onRespondToApproval ? (
                <>
                  <span aria-hidden className="text-muted-foreground">
                    ·
                  </span>
                  <ComposerPendingApprovalActions
                    presentation="inline"
                    requestId={approval.requestId}
                    disabled={!canOperateThread}
                    isResponding={respondingRequestIds.includes(approval.requestId)}
                    canRespond={canRespond}
                    options={approval.options}
                    alwaysAllowLabel={approvalAlwaysAllowLabel(approval)} // tempo: names the tool
                    onRespondToApproval={onRespondToApproval}
                  />
                </>
              ) : null}
            </>
          ) : (
            <span className="text-warning">
              Provider process is gone. Interrupt or restart the run to respond.
            </span>
          )}
          {fullAccessOverride}
        </div>
      </div>
    </WorkLogRow>
  );
});
