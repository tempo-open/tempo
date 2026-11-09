import {
  FULL_ACCESS_OVERRIDE_QUESTION,
  fullAccessOverrideExplanation,
} from "@t3tools/client-runtime/state/thread-requests";
import { workflowApprovalView } from "@t3tools/client-runtime/tempo/claude-workflows";
import { ShieldIcon } from "lucide-react";
import { memo } from "react";

import { ComposerBanner } from "../../components/chat/ComposerBanner";
import { composerFloatingLayerProps } from "../../components/chat/composerEventScope";
import { ComposerPendingApprovalActions } from "../../components/chat/ComposerPendingApprovalActions";
import { InlineButton } from "../../components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../components/ui/popover";
import { ApprovalCard, approvalAlwaysAllowLabel } from "../ApprovalCard";
import { WorkflowApprovalPanel } from "../WorkflowApprovalPanel";
import type { useChildApproval } from "./useChildApproval";

/** A sub chat's waiting approval, as the chat that started it reads it. */
export type ChildApproval = NonNullable<ReturnType<typeof useChildApproval>>;

/**
 * Tempo: a sub chat's approval above the composer of the chat that started it, since only the sub
 * chat's own timeline has a row for it. "From <sub chat>" opens the sub chat; the buttons answer
 * it, so this chat stays free to type to, send and stop.
 */
export const ChildApprovalBanner = memo(function ChildApprovalBanner(props: {
  childApproval: ChildApproval;
  disabled: boolean;
}) {
  const { pendingApprovals, respondingRequestIds, onRespondToApproval, source } =
    props.childApproval;
  const approval = props.childApproval.activePendingApproval;
  // A Claude workflow approval shows the workflow, not its raw input.
  const workflow = workflowApprovalView(approval.workflow);
  return (
    <ComposerBanner.Root data-chat-composer-top-drawer="true" variant="warning" density="spacious">
      <ComposerBanner.Row layout="approval" data-chat-composer-collapsed-controls="true">
        <ComposerBanner.Icon>
          <ShieldIcon />
        </ComposerBanner.Icon>
        {/* The card's buttons sit on their own row, Deny left and Allow right. */}
        <ComposerBanner.Content className="col-end-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <span className="text-xs text-muted-foreground">
              From{" "}
              <InlineButton tone="muted" onClick={source.onOpen}>
                {source.title}
              </InlineButton>
            </span>
            {workflow !== null ? (
              <WorkflowApprovalPanel
                workflow={workflow}
                pendingCount={pendingApprovals.length}
                notResumable={approval.responseCapability === "not_resumable"}
              />
            ) : (
              <ApprovalCard approval={approval} pendingCount={pendingApprovals.length} />
            )}
            {/* The reason the agent gave, and why full access still asked, sit under the card. */}
            {approval.reason || approval.fullAccessOverride ? (
              <span className="flex w-full min-w-0 flex-col items-start gap-0.5 text-2xs text-muted-foreground">
                {approval.reason ? (
                  <span className="w-full min-w-0 wrap-break-word">{approval.reason}</span>
                ) : null}
                {approval.fullAccessOverride ? (
                  <Popover>
                    <PopoverTrigger openOnHover render={<InlineButton tone="muted" />}>
                      {FULL_ACCESS_OVERRIDE_QUESTION}
                    </PopoverTrigger>
                    <PopoverPopup
                      {...composerFloatingLayerProps}
                      aria-label={FULL_ACCESS_OVERRIDE_QUESTION}
                      tooltipStyle
                      side="top"
                      className="max-w-[min(22rem,calc(100vw-2rem))] whitespace-normal"
                    >
                      {fullAccessOverrideExplanation(approval.fullAccessOverride)}
                    </PopoverPopup>
                  </Popover>
                ) : null}
              </span>
            ) : null}
          </div>
        </ComposerBanner.Content>
        <ComposerBanner.Actions className="col-start-2 col-end-4 row-start-2 justify-between">
          <ComposerPendingApprovalActions
            requestId={approval.requestId}
            disabled={props.disabled}
            isResponding={respondingRequestIds.includes(approval.requestId)}
            options={approval.options}
            alwaysAllowLabel={approvalAlwaysAllowLabel(approval)}
            canRespond={approval.responseCapability === "live"}
            onRespondToApproval={onRespondToApproval}
          />
        </ComposerBanner.Actions>
      </ComposerBanner.Row>
    </ComposerBanner.Root>
  );
});
