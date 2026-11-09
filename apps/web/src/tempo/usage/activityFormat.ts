/** tempo: how the Usage tab writes its numbers and days. */
import { formatCount } from "@t3tools/shared/usageFormat";

import type { ActivityMeasure } from "./activitySummary";

const ONE_DECIMAL = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

/** One decimal below `limit`, whole numbers from there: 72.4 hours, 134 hours. */
function decimalBelow(value: number, limit: number): string {
  return value < limit ? ONE_DECIMAL.format(value) : formatCount(value);
}

const TOKEN_UNITS = [
  [1e9, "B"],
  [1e6, "M"],
  [1e3, "K"],
] as const;

/** 2.6M, 10.9M and 346M: one decimal below a hundred of the unit. */
export function formatOutputTokens(value: number): string {
  const unit = TOKEN_UNITS.find(([size]) => value >= size);
  return unit === undefined
    ? formatCount(value)
    : `${decimalBelow(value / unit[0], 100)}${unit[1]}`;
}

/** A day's or a range's amount of the measure. Hours arrive in tenths (activitySummary.ts). */
export function formatMeasure(measure: ActivityMeasure, value: number): string {
  if (measure === "tokens") return formatOutputTokens(value);
  if (measure === "hours") return decimalBelow(value / 10, 100);
  return formatCount(value);
}

/** An amount a day: 3.8 threads, 40 commits. */
export function formatAverage(measure: ActivityMeasure, value: number): string {
  if (measure === "tokens") return formatOutputTokens(value);
  return decimalBelow(measure === "hours" ? value / 10 : value, 10);
}

// Months of five letters or fewer are written out, as in June 28 and Oct 16.
const DAY_MONTHS = [
  "Jan",
  "Feb",
  "March",
  "April",
  "May",
  "June",
  "July",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/** `YYYY-MM-DD` as Oct 16. */
export function formatDay(day: string): string {
  return `${DAY_MONTHS[Number(day.slice(5, 7)) - 1]} ${Number(day.slice(8, 10))}`;
}

const WEEKDAY = new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" });

/** `YYYY-MM-DD` as Thu, Nov 6. */
export function formatWeekday(day: string): string {
  return `${WEEKDAY.format(Date.parse(`${day}T00:00:00Z`))}, ${formatDay(day)}`;
}

const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });

/** `YYYY-MM` or `YYYY-MM-DD` as October. */
export function formatMonth(month: string): string {
  return MONTH_NAME.format(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1));
}
