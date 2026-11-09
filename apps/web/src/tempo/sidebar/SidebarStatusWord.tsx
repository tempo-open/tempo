import type { TimestampFormat } from "@t3tools/contracts/settings";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatUpcomingTimestamp } from "../../timestampFormat";

export type SidebarStatusLabel =
  | "Working"
  | "Goal"
  | "Waiting"
  | "Approval"
  | "Input"
  | "Request"
  | "Limited"
  | "Failed"
  | "Woke"
  | "Done";

/**
 * The tempo look marks a status with a colored word, never a dot: blue runs, amber needs you, red
 * failed. A finished thread not opened since gets a green check, which stands in for the word at a
 * row's end, where the read rows show their time.
 */
const STATUS_MARK: Record<
  Exclude<SidebarStatusLabel, "Woke">,
  { readonly className: string; readonly check?: true }
> = {
  Working: { className: "font-medium text-tempo-accent" },
  Goal: { className: "font-medium text-tempo-accent" },
  Waiting: { className: "text-secondary-label" },
  Approval: { className: "font-medium text-warning" },
  Input: { className: "font-medium text-warning" },
  Request: { className: "font-medium text-warning" },
  Limited: { className: "font-medium text-warning" },
  Failed: { className: "font-medium text-error" },
  Done: { className: "font-medium text-tempo-done-ink", check: true },
};

// The day only changes the words at midnight ("tomorrow at"), so the minute tick is its clock.
function LimitedUntil(props: { resetAt: string; timestampFormat: TimestampFormat }) {
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  if (Date.parse(props.resetAt) <= nowMs) return null;
  return `until ${formatUpcomingTimestamp(props.resetAt, props.timestampFormat, nowMs)}`;
}

/**
 * A row's status in the tempo look: its mark, its live time for Working, Goal and Waiting, and the
 * refill time for Limited. `variant` says where it sits: `row` is a row's end, where the check
 * stands alone; `time` is a running row's end that shows only its time, under the Working header
 * or in the palette; `card` is the hover card's field, which spells every status out.
 */
export function SidebarStatusWord(props: {
  label: Exclude<SidebarStatusLabel, "Woke">;
  variant: "row" | "time" | "card";
  duration: ReactNode;
  limitResetAt: string | null;
  timestampFormat: TimestampFormat;
}) {
  const mark = STATUS_MARK[props.label];
  const showWord = props.variant === "card" || (props.variant === "row" && !mark.check);
  return (
    <span
      className={cn(
        "inline-flex items-baseline gap-1 whitespace-nowrap",
        mark.className,
        // A check without its word has no text baseline to sit on, so it centers on the line.
        mark.check && !showWord && "align-middle",
      )}
    >
      {mark.check ? (
        <CheckIcon
          aria-hidden
          strokeWidth={2.5}
          className={cn(
            "shrink-0 self-center text-tempo-done",
            props.variant === "card" ? "size-[13px]" : "size-[15px]",
          )}
        />
      ) : null}
      <span className={showWord ? undefined : "sr-only"}>{props.label}</span>
      {props.duration}
      {props.label === "Limited" && props.limitResetAt !== null ? (
        <LimitedUntil resetAt={props.limitResetAt} timestampFormat={props.timestampFormat} />
      ) : null}
    </span>
  );
}
