import { formatDuration, type LimitPool } from "@t3tools/shared/usageLimits";

import { limitTable } from "./limitRows";

const GLANCE_DRIVERS = ["claudeAgent", "codex"] as const;
type LimitGlanceDriver = (typeof GLANCE_DRIVERS)[number];

export interface LimitGlanceAccount {
  readonly key: string;
  /** The name the account was given; null when it has none. */
  readonly name: string | null;
  readonly remainingPercent: number;
  /** While a spent window blocks the account, when it serves again; otherwise null. */
  readonly refillsAt: number | null;
}

/** One provider's week at a glance: every account pooled into one number, one bar each. */
export interface LimitGlance {
  readonly driver: LimitGlanceDriver;
  /** The share of the week left, averaged over the accounts. */
  readonly remainingPercent: number;
  /** Accounts that serve in the pool's order, then the full ones, soonest back first. */
  readonly accounts: readonly LimitGlanceAccount[];
  /** With every account full, when the first one refills; otherwise null. */
  readonly refillsAt: number | null;
}

/** The time until a refill without a zero last part: 4h, not 4h 0m. */
export function formatRefill(ms: number): string {
  return formatDuration(ms).replace(/ 0[hm]$/, "");
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * The time until a refill in one unit, where a row has little room: minutes as `formatRefill`
 * counts them (52m), then hours and days to the nearest one (13h, 2d).
 */
export function formatRefillGlance(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE_MS);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(ms / HOUR_MS);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(ms / DAY_MS)}d`;
}

const backAt = (account: LimitGlanceAccount) => account.refillsAt ?? Number.MAX_SAFE_INTEGER;

/**
 * The accounts that fit in `lines` rows: all of them, or else the ones that need attention first,
 * least left and then the soonest back, in their own order, and a last line for how many more.
 */
export function accountsInLines(
  accounts: readonly LimitGlanceAccount[],
  lines: number,
): { readonly shown: readonly LimitGlanceAccount[]; readonly more: number } {
  if (accounts.length <= lines) return { shown: accounts, more: 0 };
  const first = new Set(
    accounts
      .toSorted(
        (left, right) =>
          left.remainingPercent - right.remainingPercent || backAt(left) - backAt(right),
      )
      .slice(0, lines - 1),
  );
  return {
    shown: accounts.filter((account) => first.has(account)),
    more: accounts.length - first.size,
  };
}

/** The Usage page's Limits rows of the accounts that report a week, before they group by owner. */
export function limitGlance(pool: LimitPool): LimitGlance | null {
  const driver = GLANCE_DRIVERS.find((glanced) => glanced === pool.driver);
  const table = limitTable(pool);
  if (driver === undefined || table.headline?.kind !== "weekly") return null;
  return {
    driver,
    remainingPercent: table.headline.remainingPercent,
    accounts: table.rows.flatMap((row) =>
      row.remainingPercent === null
        ? []
        : [
            {
              key: row.account.key,
              name: row.account.displayName,
              remainingPercent: row.full ? 0 : row.remainingPercent,
              refillsAt: row.refillsAt,
            },
          ],
    ),
    refillsAt: table.nextRefillAt,
  };
}
