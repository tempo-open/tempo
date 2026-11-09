import { useNavigate } from "@tanstack/react-router";
import { TimerIcon } from "lucide-react";
import type { ReactNode } from "react";

import {
  readUsagePagePreferences,
  saveUsagePagePreferences,
} from "~/components/usage/usagePagePreferences";
import claudeLogoUrl from "~/tempo/threadLogos/logos/claude.png";
import {
  accountsInLines,
  formatRefillGlance,
  type LimitGlanceAccount,
} from "~/tempo/limits/limitGlance.logic";
import { useLimitGlances } from "~/tempo/limits/useLimitGlances";
import { Placeholder, WidgetFrame } from "./WidgetFrame";

const BLOCKS = Array.from({ length: 10 }, (_, index) => index);
// While the accounts load, the six rows the mockup draws hold their place.
const LOADING_ACCOUNTS = Array.from({ length: 6 }, (_, index) => index);
// Past six, rows tighten into the height six take (home.css); past eight, the last line says how many more.
const ACCOUNT_LINES = 8;

const nameOf = (account: LimitGlanceAccount) => account.name ?? "Claude";

const FIGURE =
  "text-tempo-lead font-tempo-figure tracking-tempo-figure text-foreground tabular-nums";

/** One account: its name, its week left in ten blocks, then the share left or its refill. */
function AccountRow(props: {
  readonly name: ReactNode;
  readonly blocksOn: number;
  readonly value: ReactNode;
}) {
  return (
    <li className="grid h-4 grid-cols-[82px_minmax(0,1fr)_50px] items-center gap-2 text-tempo-tiny">
      <span className="truncate text-muted-foreground">{props.name}</span>
      <span aria-hidden data-tempo-home-blocks="">
        {BLOCKS.map((block) => (
          <i key={block} data-on={block < props.blocksOn ? "" : undefined} />
        ))}
      </span>
      <span className="flex items-center justify-end gap-1 font-medium whitespace-nowrap text-foreground tabular-nums">
        {props.value}
      </span>
    </li>
  );
}

/** Claude's week: the pooled share left, then every account on its own row. Codex stays off the home. */
export function LimitWidget() {
  const navigate = useNavigate();
  const { now, glances, loading } = useLimitGlances();
  const claude = glances.find((glance) => glance.driver === "claudeAgent");
  const icon = <img src={claudeLogoUrl} alt="" draggable={false} className="rounded-sm" />;
  if (loading) {
    return (
      <WidgetFrame widget="limit" icon={icon} title="Claude limit">
        <p className="-mt-0.5 mb-3.5 flex items-baseline gap-2">
          <b className={FIGURE}>
            <Placeholder className="h-6 w-14" />
          </b>
          <span className="text-tempo-caption text-secondary-label">left this week</span>
        </p>
        <ul data-tempo-home-accounts="" className="mt-auto flex flex-col gap-1.5">
          {LOADING_ACCOUNTS.map((index) => (
            <AccountRow
              key={index}
              name={<Placeholder className="h-2 w-12" />}
              blocksOn={0}
              value={<Placeholder className="h-2 w-6" />}
            />
          ))}
        </ul>
      </WidgetFrame>
    );
  }
  if (claude === undefined) {
    return (
      <WidgetFrame widget="limit" icon={icon} title="Claude limit">
        <p className="my-auto text-center text-tempo-label text-muted-foreground">
          No Claude account reports its limits
        </p>
      </WidgetFrame>
    );
  }
  const nextUp = claude.accounts.find(
    (account) => claude.refillsAt !== null && account.refillsAt === claude.refillsAt,
  );
  const accounts = claude.accounts.length;
  const { shown, more } = accountsInLines(claude.accounts, ACCOUNT_LINES);
  return (
    <WidgetFrame
      widget="limit"
      icon={icon}
      title="Claude limit"
      aside={
        claude.remainingPercent === 0
          ? "0% left"
          : `${accounts} ${accounts === 1 ? "account" : "accounts"}`
      }
    >
      <p className="-mt-0.5 mb-3.5 flex items-baseline gap-2">
        {claude.refillsAt !== null && nextUp ? (
          <>
            <b className={`inline-flex items-center gap-1.5 ${FIGURE}`}>
              <TimerIcon aria-hidden className="size-6 text-muted-foreground" />
              {formatRefillGlance(claude.refillsAt - now)}
            </b>
            <span className="text-tempo-caption text-secondary-label">
              until {nameOf(nextUp)} refills
            </span>
          </>
        ) : (
          <>
            <b className={FIGURE}>{claude.remainingPercent}%</b>
            <span className="text-tempo-caption text-secondary-label">left this week</span>
          </>
        )}
      </p>
      <ul data-tempo-home-accounts="" className="mt-auto flex flex-col gap-1.5">
        {shown.map((account) => (
          <AccountRow
            key={account.key}
            name={nameOf(account)}
            blocksOn={Math.round(account.remainingPercent / 10)}
            value={
              account.refillsAt === null ? (
                `${account.remainingPercent}%`
              ) : (
                <>
                  <TimerIcon aria-hidden className="size-2.75 shrink-0 text-muted-foreground" />
                  <span className="sr-only">refills in </span>
                  {formatRefillGlance(account.refillsAt - now)}
                </>
              )
            }
          />
        ))}
        {more === 0 ? null : (
          <li className="flex h-4 items-center text-tempo-tiny">
            <button
              type="button"
              className="-mx-1 cursor-pointer rounded-sm px-1 text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              onClick={() => {
                saveUsagePagePreferences({ ...readUsagePagePreferences(), metric: "limits" });
                void navigate({ to: "/usage" });
              }}
            >
              and {more} more
            </button>
          </li>
        )}
      </ul>
    </WidgetFrame>
  );
}
