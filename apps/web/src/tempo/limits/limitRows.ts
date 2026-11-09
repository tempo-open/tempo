/**
 * tempo: the Limits tab's rows. One row per account with the share of its week left, or, while a
 * spent window blocks it, when it serves again; serving accounts first, then the soonest back.
 */
import type { UsageLimitSourceOwner } from "@t3tools/contracts";
import {
  displayLimitWindows,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
} from "@t3tools/shared/usageLimits";

export interface LimitRowWindow {
  readonly window: LimitPoolWindow;
  readonly member: LimitPoolMember;
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
}

export interface LimitRow {
  readonly account: LimitAccount;
  /** The share of the pool's headline window left; null when the account does not report it. */
  readonly remainingPercent: number | null;
  /** A window of the account is spent. */
  readonly full: boolean;
  /** When the last spent window resets, while the account is full and the time is known. */
  readonly refillsAt: number | null;
  /** Every window the account reports, for its details. */
  readonly windows: readonly LimitRowWindow[];
}

export interface LimitTable {
  /** The window the rows measure: the week, when the provider has one. */
  readonly headline: LimitPoolWindow | null;
  /** Every row: serving accounts in the pool's order, then the full ones, soonest back first. */
  readonly rows: readonly LimitRow[];
  /** The same rows under their owners, when the accounts report one. */
  readonly groups: ReadonlyArray<{
    readonly owner: UsageLimitSourceOwner | null;
    readonly rows: readonly LimitRow[];
  }>;
  /** With every account full, when the first one serves again. */
  readonly nextRefillAt: number | null;
}

function resetAt(member: LimitPoolMember): number | null {
  const at = member.window.resetsAt ? Date.parse(member.window.resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

function limitRow(
  pool: LimitPool,
  headline: LimitPoolWindow | null,
  account: LimitAccount,
): LimitRow {
  const windows = displayLimitWindows(pool).flatMap((window) => {
    const member = window.members.find((candidate) => candidate.account.key === account.key);
    if (member === undefined) return [];
    const reset = window.resets.find((candidate) => candidate.member.account.key === account.key);
    return [{ window, member, reset }];
  });
  const spent = windows.filter(({ member }) => remainingPercent(member.window) === 0);
  const resets = spent.map(({ member }) => resetAt(member));
  const headlineMember = windows.find(({ window }) => window === headline)?.member;
  return {
    account,
    remainingPercent: headlineMember ? remainingPercent(headlineMember.window) : null,
    full: spent.length > 0,
    refillsAt:
      resets.length > 0 && resets.every((at): at is number => at !== null)
        ? Math.max(...resets)
        : null,
    windows,
  };
}

const OWNER_ORDER: readonly (UsageLimitSourceOwner | null)[] = ["mine", "shared", "borrowed", null];

export function limitTable(pool: LimitPool): LimitTable {
  const headline =
    pool.windows.find((window) => window.kind === "weekly") ?? pool.windows[0] ?? null;
  const rows = pool.accounts.map((account) => limitRow(pool, headline, account));
  const waitFor = (row: LimitRow) =>
    row.full ? (row.refillsAt ?? Number.POSITIVE_INFINITY) : Number.NEGATIVE_INFINITY;
  // The sort is stable, so serving accounts keep the pool's order.
  const sorted = rows.toSorted(
    (left, right) =>
      Number(waitFor(left) > waitFor(right)) - Number(waitFor(left) < waitFor(right)),
  );
  const grouped = sorted.some((row) => row.account.owner)
    ? OWNER_ORDER.map((owner) => ({
        owner,
        rows: sorted.filter((row) => (row.account.owner ?? null) === owner),
      })).filter((group) => group.rows.length > 0)
    : [{ owner: null, rows: sorted }];
  const refills = rows.flatMap((row) =>
    row.full && row.refillsAt !== null ? [row.refillsAt] : [],
  );
  return {
    headline,
    rows: sorted,
    groups: grouped,
    nextRefillAt: rows.length > 0 && refills.length === rows.length ? Math.min(...refills) : null,
  };
}

/** When the newest of these limits was read; null when there are none. */
export function limitsReadAt(accounts: readonly LimitAccount[]): string | null {
  return (
    accounts
      .map((account) => account.limits.checkedAt)
      .toSorted((left, right) => Date.parse(left) - Date.parse(right))
      .at(-1) ?? null
  );
}
