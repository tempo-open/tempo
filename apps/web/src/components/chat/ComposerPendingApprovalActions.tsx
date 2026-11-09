import {
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type RuntimeRequestId,
} from "@t3tools/contracts";
import { memo } from "react";
import { EllipsisIcon, TriangleAlertIcon } from "lucide-react";
import { Button, InlineButton } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { composerFloatingLayerProps } from "./composerEventScope";

interface ComposerPendingApprovalActionsProps {
  /** tempo: `card` is the tempo look's approval card in the timeline. */
  presentation?: "composer" | "inline" | "card";
  requestId: RuntimeRequestId;
  isResponding: boolean;
  canRespond: boolean;
  disabled?: boolean;
  options?: ReadonlyArray<ProviderApprovalOption> | undefined;
  /** tempo: names what the default always-allow button covers. */
  alwaysAllowLabel?: string | undefined;
  onRespondToApproval: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}

// tempo: the approval card's buttons: filled, the primary one in the send color.
const CARD_BUTTON_CLASS_NAME =
  "inline-flex h-7.5 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-3 text-tempo-note font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64";
const CARD_SECONDARY_CLASS_NAME = "bg-accent text-muted-foreground hover:text-foreground";
const CARD_PRIMARY_CLASS_NAME =
  "bg-message-action text-message-action-foreground hover:bg-message-action-hover";

// tempo: plain labels that say once versus always.
const defaultApprovalOptions = (alwaysAllowLabel: string): ReadonlyArray<ProviderApprovalOption> =>
  [
    { decision: "cancel", label: "Cancel" },
    { decision: "decline", label: "Deny" },
    { decision: "acceptForSession", label: alwaysAllowLabel },
    { decision: "accept", label: "Allow once" },
  ] satisfies ReadonlyArray<ProviderApprovalOption>;

export const ComposerPendingApprovalActions = memo(function ComposerPendingApprovalActions({
  presentation = "composer",
  requestId,
  isResponding,
  canRespond,
  disabled = false,
  options: providerOptions,
  alwaysAllowLabel = "Always allow in this chat",
  onRespondToApproval,
}: ComposerPendingApprovalActionsProps) {
  const options = providerOptions ?? defaultApprovalOptions(alwaysAllowLabel);
  // A lasting acceptAlways (Codex) stays in the menu: only this-chat approval is a button.
  const isAlways = (option: ProviderApprovalOption) => option.decision === "acceptForSession";
  const isInRow = (option: ProviderApprovalOption) =>
    option.decision === "decline" || option.decision === "accept" || isAlways(option);
  const denyOptions = options.filter((option) => option.decision === "decline");
  const allowOptions = options
    .filter((option) => isAlways(option) || option.decision === "accept")
    // Always allow first, so the primary Allow once sits at the far right.
    .toSorted(
      (left, right) => Number(left.decision === "accept") - Number(right.decision === "accept"),
    );
  const moreOptions = options.filter((option) => !isInRow(option));

  const renderOption = (option: ProviderApprovalOption) => {
    const buttonProps = {
      disabled: disabled || isResponding || !canRespond,
      "aria-description": option.warning,
      onClick: () => {
        if (!disabled && !isResponding && canRespond) {
          void onRespondToApproval(requestId, option.decision);
        }
      },
    };
    const content = (
      <>
        {option.warning ? <TriangleAlertIcon className="size-3 shrink-0" /> : null}
        <span className={presentation === "inline" ? "whitespace-normal" : "max-w-72 truncate"}>
          {option.label}
        </span>
      </>
    );
    const button =
      presentation === "inline" ? (
        <InlineButton
          key={option.decision}
          {...buttonProps}
          tone={option.decision === "accept" ? "default" : "muted"}
        >
          {content}
        </InlineButton>
      ) : presentation === "card" ? (
        <button
          key={option.decision}
          type="button"
          {...buttonProps}
          className={cn(
            CARD_BUTTON_CLASS_NAME,
            option.decision === "accept" ? CARD_PRIMARY_CLASS_NAME : CARD_SECONDARY_CLASS_NAME,
          )}
        >
          {content}
        </button>
      ) : (
        <Button
          key={option.decision}
          {...buttonProps}
          size="xs"
          variant={
            option.decision === "accept"
              ? "default"
              : option.decision === "decline"
                ? "destructive-outline"
                : "secondary"
          }
        >
          {content}
        </Button>
      );
    return option.warning ? (
      <Tooltip key={option.decision}>
        <TooltipTrigger render={button} />
        <TooltipPopup side="top">{option.warning}</TooltipPopup>
      </Tooltip>
    ) : (
      button
    );
  };

  const moreMenu =
    moreOptions.length > 0 ? (
      <Menu>
        <MenuTrigger
          disabled={disabled || isResponding || !canRespond}
          render={
            presentation === "inline" ? (
              <InlineButton tone="muted" aria-label="More approval options" />
            ) : presentation === "card" ? (
              <button
                type="button"
                aria-label="More approval options"
                className={cn(CARD_BUTTON_CLASS_NAME, CARD_SECONDARY_CLASS_NAME, "px-2")}
              />
            ) : (
              <Button size="icon-xs" variant="outline" aria-label="More approval options" />
            )
          }
        >
          {presentation === "inline" ? (
            "More"
          ) : presentation === "card" ? (
            <EllipsisIcon className="size-4" />
          ) : (
            <EllipsisIcon />
          )}
        </MenuTrigger>
        <MenuPopup {...composerFloatingLayerProps} side="top" align="end" width="content">
          {moreOptions.map((option) => {
            const item = (
              <MenuItem
                key={option.decision}
                disabled={disabled || isResponding || !canRespond}
                aria-description={option.warning}
                onClick={() => {
                  if (!disabled && !isResponding && canRespond)
                    void onRespondToApproval(requestId, option.decision);
                }}
              >
                {option.warning ? <TriangleAlertIcon className="size-3 text-warning" /> : null}
                <span className="min-w-0 whitespace-normal wrap-break-word">{option.label}</span>
              </MenuItem>
            );
            return option.warning ? (
              <Tooltip key={option.decision}>
                <TooltipTrigger render={item} />
                <TooltipPopup side="top">{option.warning}</TooltipPopup>
              </Tooltip>
            ) : (
              item
            );
          })}
        </MenuPopup>
      </Menu>
    ) : null;

  // tempo: on the approval card every action sits at the right, the primary Allow once last.
  if (presentation === "card") {
    return (
      <>
        {moreMenu}
        {denyOptions.map(renderOption)}
        {allowOptions.map(renderOption)}
      </>
    );
  }
  // tempo: inline on a timeline row the buttons run on after the status text, with More last.
  if (presentation === "inline") {
    return (
      <>
        {denyOptions.map(renderOption)}
        {allowOptions.map(renderOption)}
        {moreMenu}
      </>
    );
  }
  return (
    <>
      <span className="flex items-center gap-1.5">
        {denyOptions.map(renderOption)}
        {moreMenu}
      </span>
      <span className="ms-auto flex flex-wrap items-center justify-end gap-1.5">
        {allowOptions.map(renderOption)}
      </span>
    </>
  );
});
