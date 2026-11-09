/**
 * tempo: a heat map's days, a week per column from Sunday, for the home Activity widget and the Usage
 * page. The day under the pointer, or the one the arrow keys highlight, shows its tooltip at once.
 */
import {
  useId,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Tooltip, TooltipPopup } from "~/components/ui/tooltip";
import { useNowMinute } from "~/hooks/useNowMinute";
import { cn } from "~/lib/utils";
import { formatWeekday } from "../usage/activityFormat";

export interface GridDay {
  readonly day: string;
  /** What the day counts, in words: 14 threads, 38 agents. */
  readonly detail: string;
}

interface Highlight {
  readonly index: number;
  readonly cell: Element;
}

export interface GridCellProps {
  readonly id: string;
  readonly role: "gridcell";
  readonly "aria-label": string;
  readonly "data-active": "" | undefined;
  readonly className: string;
  readonly style: CSSProperties;
  readonly onPointerEnter: (event: PointerEvent<HTMLElement>) => void;
}

const WEEK_STEP: Partial<Record<string, number>> = {
  ArrowUp: -1,
  ArrowDown: 1,
  ArrowLeft: -7,
  ArrowRight: 7,
};

const weekdayOf = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();

const LOCAL_DAY = new Intl.DateTimeFormat("en-CA", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/** Days run oldest first; one keyboard stop, read out through the active day. */
export function DayGrid({
  label,
  days,
  className,
  renderCell,
  ...props
}: {
  readonly label: string;
  readonly days: readonly GridDay[];
  readonly className?: string;
  readonly renderCell: (index: number, props: GridCellProps) => ReactNode;
  readonly [data: `data-${string}`]: string | undefined;
}) {
  const id = useId();
  const nowMinute = useNowMinute();
  const today = LOCAL_DAY.format(Date.parse(`${nowMinute}:00.000Z`));
  const [pointer, setPointer] = useState<Highlight | null>(null);
  const [keyboard, setKeyboard] = useState<Highlight | null>(null);
  // Escape hides the tooltip until the pointer or the arrow keys move to a day.
  const [dismissed, setDismissed] = useState(false);
  // The tooltip keeps the last day while it closes.
  const [last, setLast] = useState<Highlight | null>(null);
  const active = pointer ?? keyboard;
  const shown = active ?? last;
  const cellId = (index: number) => `${id}-${index}`;
  const titleOf = (index: number) =>
    days[index]!.day === today ? "Today" : formatWeekday(days[index]!.day);
  const before = days.length === 0 ? 0 : weekdayOf(days[0]!.day);
  const rows = Array.from({ length: 7 }, (_, weekday) =>
    days.flatMap((_day, index) => ((before + index) % 7 === weekday ? [index] : [])),
  );
  const highlight = (index: number, cell: Element | null) => {
    if (cell === null) return null;
    const next = { index, cell };
    setLast(next);
    setDismissed(false);
    return next;
  };
  const highlightKey = (index: number) =>
    setKeyboard(highlight(index, document.getElementById(cellId(index))));
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = WEEK_STEP[event.key];
    if (step === undefined || days.length === 0) return;
    event.preventDefault();
    setPointer(null);
    highlightKey(Math.min(days.length - 1, Math.max(0, (keyboard?.index ?? days.length) + step)));
  };
  return (
    <Tooltip
      open={active !== null && !dismissed}
      onOpenChange={(open) => {
        if (!open) setDismissed(true);
      }}
    >
      <div
        {...props}
        role="grid"
        aria-label={label}
        aria-readonly
        aria-activedescendant={keyboard === null ? undefined : cellId(keyboard.index)}
        tabIndex={days.length === 0 ? -1 : 0}
        className={cn("outline-none", className)}
        onKeyDown={onKeyDown}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) highlightKey(days.length - 1);
        }}
        onBlur={() => setKeyboard(null)}
        onPointerLeave={() => setPointer(null)}
      >
        {rows.map((indexes, weekday) => (
          // oxlint-disable-next-line react/no-array-index-key -- a row is a weekday, Sunday first
          <div key={weekday} role="row" className="contents">
            {indexes.map((index) =>
              renderCell(index, {
                id: cellId(index),
                role: "gridcell",
                "aria-label": `${titleOf(index)}: ${days[index]!.detail}`,
                "data-active": index === active?.index ? "" : undefined,
                className: "outline-foreground data-active:outline-2",
                style: { gridRow: weekday + 1, gridColumn: Math.floor((before + index) / 7) + 1 },
                onPointerEnter: (event) => setPointer(highlight(index, event.currentTarget)),
              }),
            )}
          </div>
        ))}
      </div>
      <TooltipPopup side="top" anchor={shown?.cell} instant>
        {shown === null ? null : (
          <span className="whitespace-nowrap">
            <span className="block font-medium">{titleOf(shown.index)}</span>
            {days[shown.index]?.detail}
          </span>
        )}
      </TooltipPopup>
    </Tooltip>
  );
}
