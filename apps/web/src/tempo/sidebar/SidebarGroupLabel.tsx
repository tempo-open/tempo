import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

const TONE_CLASS_NAME = {
  muted: "text-secondary-label",
  emphasized: "text-muted-foreground",
  accent: "text-tempo-accent",
} as const;

type GroupLabelTone = keyof typeof TONE_CLASS_NAME;

const LABEL_CLASS_NAME =
  "flex w-full items-end justify-between px-2 pb-1 text-tempo-meta leading-3.75 font-medium";

function GroupCount(props: { count: number; chevron?: "open" | "folded" | "on-hover" }) {
  return (
    <span className="inline-flex items-center gap-1 font-book tabular-nums">
      {props.count}
      {props.chevron === undefined ? null : (
        <ChevronDownIcon
          aria-hidden
          className={cn(
            "size-[13px] shrink-0",
            props.chevron === "folded" && "-rotate-90",
            props.chevron === "on-hover" &&
              "hidden group-any-hover/group-label:block group-focus-visible/group-label:block",
          )}
        />
      )}
    </span>
  );
}

/** The tempo look's label over a group of rows (Pinned, Open), with its count. */
export function SidebarGroupLabel(props: {
  label: string;
  count: number;
  tone: GroupLabelTone;
  className?: string;
}) {
  return (
    <div className={cn(LABEL_CLASS_NAME, "h-8", TONE_CLASS_NAME[props.tone], props.className)}>
      <span>{props.label}</span>
      <GroupCount count={props.count} />
    </div>
  );
}

/**
 * The tempo look's header of a section that folds: Settled today in the list, or a shelf docked
 * at the bottom, whose chevron shows only folded or under the pointer, as the design draws it.
 */
export function SidebarGroupToggle({
  label,
  count,
  tone,
  expanded,
  docked,
  ...buttonProps
}: Omit<ComponentProps<"button">, "className" | "aria-expanded" | "type"> & {
  label: string;
  count: number;
  tone: GroupLabelTone;
  expanded: boolean;
  docked: boolean;
}) {
  return (
    <button
      {...buttonProps}
      type="button"
      aria-expanded={expanded}
      className={cn(
        LABEL_CLASS_NAME,
        "group/group-label cursor-pointer rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        docked ? "h-7.25" : "h-8",
        TONE_CLASS_NAME[tone],
      )}
    >
      <span>{label}</span>
      <GroupCount count={count} chevron={!expanded ? "folded" : docked ? "on-hover" : "open"} />
    </button>
  );
}
