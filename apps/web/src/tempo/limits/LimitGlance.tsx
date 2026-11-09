import { useNavigate } from "@tanstack/react-router";
import { TimerIcon } from "lucide-react";

import { useSidebar } from "~/components/ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import claudeLogoUrl from "../threadLogos/logos/claude.png";
import codexLogoUrl from "../threadLogos/logos/chatgpt.png";
import {
  formatRefill,
  formatRefillGlance,
  type LimitGlance as LimitGlanceRow,
} from "./limitGlance.logic";
import { useLimitGlances } from "./useLimitGlances";

const PROVIDERS = {
  claudeAgent: { name: "Claude", logo: claudeLogoUrl },
  codex: { name: "Codex", logo: codexLogoUrl },
} as const;

function glanceLabel(row: LimitGlanceRow, refill: string | null): string {
  const { name } = PROVIDERS[row.driver];
  if (refill !== null) return `${name}: every account is full; the first refills in ${refill}`;
  const across = row.accounts.length === 1 ? "" : ` across ${row.accounts.length} accounts`;
  return `${name}: ${row.remainingPercent}% of this week's limit left${across}`;
}

function LimitGlanceRows(props: {
  readonly rows: readonly LimitGlanceRow[];
  readonly now: number;
  readonly onOpen: () => void;
}) {
  if (props.rows.length === 0) return null;
  return (
    <div className="flex flex-col items-start" data-tempo-limit-glance="">
      {props.rows.map((row) => {
        const left = row.refillsAt === null ? null : row.refillsAt - props.now;
        // The row has room for one unit; its tooltip and label keep the exact time.
        const refill = left === null ? null : formatRefillGlance(left);
        const label = glanceLabel(row, left === null ? null : formatRefill(left));
        return (
          <Tooltip key={row.driver}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={label}
                  className="flex cursor-pointer items-center outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  onClick={props.onOpen}
                />
              }
            >
              <img src={PROVIDERS[row.driver].logo} alt="" draggable={false} />
              <span data-tempo-limit-name="">{PROVIDERS[row.driver].name}</span>
              <span data-tempo-limit-bars="">
                {row.accounts.map((account) => (
                  <span key={account.key}>
                    <span style={{ height: `${account.remainingPercent}%` }} />
                  </span>
                ))}
              </span>
              <span className="inline-flex items-center gap-1 font-medium text-foreground tabular-nums">
                {refill === null ? (
                  `${row.remainingPercent}%`
                ) : (
                  <>
                    <TimerIcon aria-hidden />
                    {refill}
                  </>
                )}
              </span>
            </TooltipTrigger>
            <TooltipPopup side="top">{label}</TooltipPopup>
          </Tooltip>
        );
      })}
    </div>
  );
}

/** The sidebar footer's Claude and Codex rows: the week left, pooled, with one bar per account. */
export function LimitGlance() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const { now, glances } = useLimitGlances();
  return (
    <LimitGlanceRows
      rows={glances}
      now={now}
      onOpen={() => {
        if (isMobile) setOpenMobile(false);
        void navigate({ to: "/usage" });
      }}
    />
  );
}
