/**
 * tempo: the Usage tab's numbers, derived from an environment's days (tempoActivity.ts). A measure is
 * null on a day it was not recorded, such as agents before Tempo ran its first turn, and so is a
 * number over days that recorded none of it, or over a day GitHub has not answered for yet.
 */
import type { TempoActivityDay } from "@t3tools/contracts";

const TENTH_OF_AN_HOUR_MS = 360_000;

/** How each measure reads a day. Hours are counted in tenths, rounded per day, so sums stay exact. */
const MEASURES = {
  threads: (day) => day.threads,
  agents: (day) => day.agents,
  commits: (day) => day.commits,
  hours: (day) => Math.round(day.workedMs / TENTH_OF_AN_HOUR_MS),
  tokens: (day) => day.outputTokens,
  mergedPullRequests: (day) => day.mergedPullRequests,
} satisfies Record<string, (day: TempoActivityDay) => number | null>;

export type ActivityMeasure = keyof typeof MEASURES;

/** The measures the heat map switches between, in the order of its control. */
export const HEAT_MAP_MEASURES = [
  "threads",
  "agents",
  "commits",
  "hours",
  "tokens",
] as const satisfies readonly ActivityMeasure[];
export type HeatMapMeasure = (typeof HEAT_MAP_MEASURES)[number];

/** The columns of Every number, in order. */
export const TABLE_MEASURES = [
  ...HEAT_MAP_MEASURES,
  "mergedPullRequests",
] as const satisfies readonly ActivityMeasure[];

/** The measures read from GitHub, which answers for every day. */
export const GITHUB_MEASURES: ReadonlySet<ActivityMeasure> = new Set([
  "commits",
  "mergedPullRequests",
]);

function measureOf(day: TempoActivityDay, measure: ActivityMeasure): number | null {
  return MEASURES[measure](day);
}

/** The values of the days that recorded the measure; null when GitHub has not answered for one. */
function recorded(days: readonly TempoActivityDay[], measure: ActivityMeasure): number[] | null {
  const values = days.map((day) => measureOf(day, measure));
  if (GITHUB_MEASURES.has(measure) && values.includes(null)) return null;
  return values.filter((value) => value !== null);
}

function total(days: readonly TempoActivityDay[], measure: ActivityMeasure): number | null {
  const values = recorded(days, measure);
  return values?.length ? values.reduce((sum, value) => sum + value, 0) : null;
}

function dailyAverage(days: readonly TempoActivityDay[], measure: ActivityMeasure): number | null {
  const values = recorded(days, measure);
  return values?.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

/** The first day with the largest value; null when no day has any or a day is not known. */
function busiestDay(
  days: readonly TempoActivityDay[],
  measure: ActivityMeasure,
): { readonly day: string; readonly value: number } | null {
  if (recorded(days, measure) === null) return null;
  let best: { day: string; value: number } | null = null;
  for (const day of days) {
    const value = measureOf(day, measure) ?? 0;
    if (value > (best?.value ?? 0)) best = { day: day.day, value };
  }
  return best;
}

function daysActive(days: readonly TempoActivityDay[], measure: ActivityMeasure): number | null {
  const values = recorded(days, measure);
  return values?.length ? values.filter((value) => value > 0).length : null;
}

/** `YYYY-MM` of the month before the one `day` falls in. */
export function previousMonth(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  return month === 1 ? `${year - 1}-12` : `${year}-${String(month - 1).padStart(2, "0")}`;
}

function inMonth(days: readonly TempoActivityDay[], month: string): readonly TempoActivityDay[] {
  return days.filter((day) => day.day.startsWith(month));
}

/**
 * One measure over the whole history: its total since it was first recorded, the month before
 * this one, this month so far, and its average over the days that recorded it.
 */
export interface MeasureSummary {
  readonly total: number | null;
  /** The first day that recorded the measure; null while a day of it is not known. */
  readonly since: string | null;
  readonly lastMonth: number | null;
  readonly thisMonth: number | null;
  readonly dailyAverage: number | null;
  readonly recordedDays: number;
  readonly busiest: { readonly day: string; readonly value: number } | null;
}

export function summarizeMeasure(
  days: readonly TempoActivityDay[],
  measure: ActivityMeasure,
): MeasureSummary {
  const today = days.at(-1)?.day ?? "";
  const values = recorded(days, measure);
  return {
    total: total(days, measure),
    since:
      values === null ? null : (days.find((day) => measureOf(day, measure) !== null)?.day ?? null),
    lastMonth: total(inMonth(days, previousMonth(today)), measure),
    thisMonth: total(inMonth(days, today.slice(0, 7)), measure),
    dailyAverage: dailyAverage(days, measure),
    recordedDays: values?.length ?? 0,
    busiest: busiestDay(days, measure),
  };
}

/** A cell of Every number; null is "Not counted". `day` is the date of a best day. */
export type TableCell = { readonly value: number; readonly day?: string } | null;

/**
 * The rows of Every number. The first five sum a range of days; `average` divides by the days that
 * recorded the measure, `best` is the busiest day, and `count` counts the days with any of it.
 */
export type TableRowKey =
  | "today"
  | "last7"
  | "weekBefore"
  | "lastMonth"
  | "since"
  | "average"
  | "best"
  | "count";

export interface TableRow {
  readonly key: TableRowKey;
  /** The month `lastMonth` covers (`YYYY-MM`) and the first day `since` counts from. */
  readonly period: string | null;
  readonly cells: Readonly<Record<ActivityMeasure, TableCell>>;
}

function cells(read: (measure: ActivityMeasure) => TableCell): TableRow["cells"] {
  return {
    threads: read("threads"),
    agents: read("agents"),
    commits: read("commits"),
    hours: read("hours"),
    tokens: read("tokens"),
    mergedPullRequests: read("mergedPullRequests"),
  };
}

const counted = (value: number | null): TableCell => (value === null ? null : { value });

function rangeRow(
  key: TableRowKey,
  period: string | null,
  days: readonly TempoActivityDay[],
): TableRow {
  return { key, period, cells: cells((measure) => counted(total(days, measure))) };
}

/** Every number: eight rows, one column per measure. Days run oldest first and end today. */
export function everyNumber(days: readonly TempoActivityDay[]): readonly TableRow[] {
  const first = days[0];
  const today = days.at(-1);
  if (first === undefined || today === undefined) return [];
  const lastMonth = previousMonth(today.day);
  return [
    rangeRow("today", null, [today]),
    rangeRow("last7", null, days.slice(-7)),
    rangeRow("weekBefore", null, days.slice(-14, -7)),
    rangeRow("lastMonth", lastMonth, inMonth(days, lastMonth)),
    rangeRow("since", first.day, days),
    { key: "average", period: null, cells: cells((m) => counted(dailyAverage(days, m))) },
    {
      key: "best",
      period: null,
      cells: cells((m) => busiestDay(days, m) ?? counted(total(days, m))),
    },
    { key: "count", period: null, cells: cells((m) => counted(daysActive(days, m))) },
  ];
}

/**
 * Days in a row with some of the measure, ending today, or yesterday while today has none yet;
 * null when a day of the run did not record it.
 */
function currentRun(days: readonly TempoActivityDay[], measure: ActivityMeasure): number | null {
  let run = 0;
  for (let index = days.length - 1; index >= 0; index -= 1) {
    const value = measureOf(days[index]!, measure);
    if (value === null) return null;
    if (value > 0) run += 1;
    else if (index < days.length - 1) break;
  }
  return run;
}

function longestRun(days: readonly TempoActivityDay[], measure: ActivityMeasure): number {
  let longest = 0;
  let run = 0;
  for (const day of days) {
    run = (measureOf(day, measure) ?? 0) > 0 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  return longest;
}

export interface Streaks {
  /** Null when no day recorded commits, such as without GitHub. */
  readonly commitDays: number | null;
  readonly threadDays: number;
  /** The longest run of days with an agent working. */
  readonly longestWorked: number;
}

export function streaks(days: readonly TempoActivityDay[]): Streaks {
  return {
    commitDays: currentRun(days, "commits"),
    threadDays: currentRun(days, "threads") ?? 0,
    longestWorked: longestRun(days, "hours"),
  };
}

/** How full a heat map cell is: 0 for none, 1 to 4 by quartile of the busy days, null unrecorded. */
export type HeatLevel = 0 | 1 | 2 | 3 | 4 | null;

export interface HeatCell {
  readonly day: string;
  readonly value: number | null;
  readonly level: HeatLevel;
  readonly busiest: boolean;
}

function levelOf(value: number | null, quartiles: readonly number[]): HeatLevel {
  if (value === null) return null;
  if (value <= 0) return 0;
  const index = quartiles.findIndex((quartile) => value <= quartile);
  return ([1, 2, 3] as const)[index] ?? 4;
}

function weekdayOf(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/**
 * The heat map's cells, oldest first: the days of the most recent `maxWeeks` weeks, a week per
 * column from Sunday. Levels are quartiles of the busy days shown.
 */
export function heatMap(
  days: readonly TempoActivityDay[],
  measure: HeatMapMeasure,
  maxWeeks: number,
): readonly HeatCell[] {
  const first = days[0];
  if (first === undefined) return [];
  const padded = [...Array.from({ length: weekdayOf(first.day) }, () => null), ...days];
  const shown = padded.slice(Math.max(0, Math.ceil(padded.length / 7) - maxWeeks) * 7);
  const busy = shown
    .flatMap((day) => (day === null ? [] : (measureOf(day, measure) ?? [])))
    .filter((value) => value > 0)
    .toSorted((a, b) => a - b);
  const quartiles = [0.25, 0.5, 0.75].map(
    (share) => busy[Math.floor((busy.length - 1) * share)] ?? 0,
  );
  const busiest = busiestDay(days, measure);
  return shown.flatMap((day) => {
    if (day === null) return [];
    const value = measureOf(day, measure);
    return [
      { day: day.day, value, level: levelOf(value, quartiles), busiest: busiest?.day === day.day },
    ];
  });
}

/** Output tokens by model, the largest `named` and the rest summed into one more row. */
export function modelShares<T extends { readonly outputTokens: number }>(
  models: readonly T[],
  named: number,
): {
  readonly rows: readonly { readonly model: T | null; readonly outputTokens: number }[];
  readonly total: number;
} {
  const total = models.reduce((sum, model) => sum + model.outputTokens, 0);
  const sorted = models.toSorted((a, b) => b.outputTokens - a.outputTokens);
  // Folding a single model into "Other models" would hide its name for nothing.
  const kept = sorted.length <= named + 1 ? sorted : sorted.slice(0, named);
  const rest = sorted.slice(kept.length).reduce((sum, model) => sum + model.outputTokens, 0);
  return {
    rows: [
      ...kept.map((model) => ({ model, outputTokens: model.outputTokens })),
      ...(rest > 0 ? [{ model: null, outputTokens: rest }] : []),
    ],
    total,
  };
}
