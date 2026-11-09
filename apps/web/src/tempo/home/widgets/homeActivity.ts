/**
 * tempo: the home's Activity widget, This month widget and status bar, from an environment's days
 * (tempoActivity.ts). A measure is null on a day it was not recorded, which is not the same as none.
 */
import type { TempoActivity, TempoActivityDay } from "@t3tools/contracts";
import { formatCount } from "@t3tools/shared/usageFormat";

/** The heat map shows as many weeks as the approved mockup draws, the most recent ones. */
export const HEAT_MAP_WEEKS = 19;

/** 0 for a day with nothing started, 1 to 4 by quartile of the busy days shown. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

export interface HeatDay {
  readonly day: string;
  readonly level: HeatLevel;
  readonly threads: number;
  /** Null on a day agents were not recorded. */
  readonly agents: number | null;
}

export interface HeatMap {
  /** The days shown, oldest first, a week per column from Sunday. */
  readonly cells: readonly HeatDay[];
  /** Threads started on the days shown. */
  readonly threads: number;
  /** Agents started on the days shown; null when none of them recorded agents. */
  readonly agents: number | null;
}

export interface MonthTotals {
  readonly threads: number;
  readonly mergedPullRequests: number | null;
  readonly outputTokens: number | null;
}

function sumOf(days: readonly TempoActivityDay[], read: (day: TempoActivityDay) => number | null) {
  const recorded = days.flatMap((day) => read(day) ?? []);
  return recorded.length === 0 ? null : recorded.reduce((sum, value) => sum + value, 0);
}

const started = (day: TempoActivityDay) => day.threads + (day.agents ?? 0);

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

function levelOf(value: number, quartiles: readonly number[]): HeatLevel {
  if (value <= 0) return 0;
  const index = quartiles.findIndex((quartile) => value <= quartile);
  return index === -1 ? 4 : ((index + 1) as HeatLevel);
}

/** Threads and agents started each day over the most recent weeks; null before any day. */
export function heatMap(days: readonly TempoActivityDay[]): HeatMap | null {
  const first = days[0];
  if (first === undefined) return null;
  const before = weekdayOf(first.day);
  const weeks = Math.ceil((before + days.length) / 7);
  const shown = days.slice(Math.max(0, (weeks - HEAT_MAP_WEEKS) * 7 - before));
  const busy = shown
    .map(started)
    .filter((value) => value > 0)
    .toSorted((left, right) => left - right);
  const quartiles = [0.25, 0.5, 0.75].map(
    (share) => busy[Math.floor((busy.length - 1) * share)] ?? 0,
  );
  return {
    cells: shown.map((day) => ({
      day: day.day,
      level: levelOf(started(day), quartiles),
      threads: day.threads,
      agents: day.agents,
    })),
    threads: shown.reduce((sum, day) => sum + day.threads, 0),
    agents: sumOf(shown, (day) => day.agents),
  };
}

const counted = (count: number, one: string) =>
  `${formatCount(count)} ${one}${count === 1 ? "" : "s"}`;

/** What a day of the map counts, in words: 14 threads, 38 agents; agents only where recorded. */
export function heatDayDetail(day: HeatDay): string {
  const threads = day.threads === 0 ? "No threads" : counted(day.threads, "thread");
  return day.agents === null || (day.threads === 0 && day.agents === 0)
    ? threads
    : `${threads}, ${counted(day.agents, "agent")}`;
}

/** Totals for the month today falls in. Days run oldest first and end today. */
export function monthTotals(days: readonly TempoActivityDay[]): MonthTotals {
  const today = days.at(-1)?.day ?? "";
  const month = days.filter((day) => day.day.slice(0, 7) === today.slice(0, 7));
  return {
    threads: month.reduce((sum, day) => sum + day.threads, 0),
    mergedPullRequests: sumOf(month, (day) => day.mergedPullRequests),
    outputTokens: sumOf(month, (day) => day.outputTokens),
  };
}

/**
 * A count only GitHub gives, or undefined while GitHub is still being read and has not given it:
 * until then a missing count is not yet known, which is not the same as not counted.
 */
export function gitHubCount(
  activity: TempoActivity,
  count: number | null,
): number | null | undefined {
  return count === null && activity.github === "refreshing" ? undefined : count;
}

/** Why there are no days to show, in words; null while they load. */
export function activityMissing(state: {
  readonly unsupported: boolean;
  readonly error: unknown;
}): string | null {
  if (state.unsupported) return "This server does not report activity";
  return state.error ? "Could not read activity" : null;
}
