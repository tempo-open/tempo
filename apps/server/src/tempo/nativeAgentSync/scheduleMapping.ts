/**
 * Native schedules as Tempo schedules. Claude Code's durable tasks use 5-field cron and Codex's
 * automations RFC 5545 RRULEs, both in local time; Tempo runs a task on an interval or at one time of
 * day on chosen weekdays. A schedule Tempo cannot follow exactly maps to the nearest one, flagged so
 * the task can show the original expression.
 */
import type { ScheduledTaskUpsertSchedule } from "@t3tools/contracts";

const MINUTE_MS = 60_000;

const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MONTH_NAMES = [
  "jan",
  "feb",
  "mar",
  "apr",
  "may",
  "jun",
  "jul",
  "aug",
  "sep",
  "oct",
  "nov",
  "dec",
] as const;

interface CronField {
  /** `*`: every value. */
  readonly any: boolean;
  /** `*` or `0-59` with a `/n` step, the only steps an interval can follow. */
  readonly step: number | null;
  readonly values: ReadonlyArray<number>;
}

function parseValue(text: string, names: ReadonlyArray<string>, offset: number): number | null {
  if (/^\d+$/.test(text)) return Number(text);
  const index = names.indexOf(text.toLowerCase());
  return index === -1 ? null : index + offset;
}

function parseField(
  text: string,
  min: number,
  max: number,
  names: ReadonlyArray<string> = [],
  nameOffset = 0,
): CronField | null {
  if (text === "*") {
    return { any: true, step: null, values: range(min, max, 1) };
  }
  const values = new Set<number>();
  let step: number | null = null;
  for (const part of text.split(",")) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(part);
    if (match === null) return null;
    const [, base = "", stepText] = match;
    const every = stepText === undefined ? 1 : Number(stepText);
    if (every < 1) return null;
    let from: number | null;
    let to: number | null;
    if (base === "*") {
      from = min;
      to = max;
    } else if (base.includes("-")) {
      const [start = "", end = ""] = base.split("-");
      from = parseValue(start, names, nameOffset);
      to = parseValue(end, names, nameOffset);
    } else {
      from = parseValue(base, names, nameOffset);
      to = stepText === undefined ? from : max;
    }
    if (from === null || to === null || from < min || to > max || from > to) return null;
    for (const value of range(from, to, every)) values.add(value);
    if (stepText !== undefined && from === min && to === max && text.split(",").length === 1) {
      step = every;
    }
  }
  return { any: false, step, values: [...values].toSorted((a, b) => a - b) };
}

function range(from: number, to: number, step: number): Array<number> {
  const values: Array<number> = [];
  for (let value = from; value <= to; value += step) values.push(value);
  return values;
}

const pad = (value: number) => String(value).padStart(2, "0");

export interface ScheduleMapping {
  readonly schedule: ScheduledTaskUpsertSchedule;
  /** False when Tempo would run the task at times the native schedule would not. */
  readonly exact: boolean;
}

const fixedTime = (
  hour: number,
  minute: number,
  weekdays: ReadonlyArray<number> | undefined,
  exact: boolean,
): ScheduleMapping => ({
  schedule: {
    type: "fixed_time",
    timeOfDay: `${pad(hour)}:${pad(minute)}`,
    ...(weekdays === undefined || weekdays.length === 7 ? {} : { weekdays: [...weekdays] }),
  },
  exact,
});

/**
 * The Tempo schedule for a 5-field cron (`minute hour day-of-month month
 * day-of-week`), or null when the expression does not parse.
 */
export function scheduleFromCron(cron: string): ScheduleMapping | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minuteText = "", hourText = "", dayText = "", monthText = "", weekdayText = ""] = parts;
  const minute = parseField(minuteText, 0, 59);
  const hour = parseField(hourText, 0, 23);
  const day = parseField(dayText, 1, 31);
  const month = parseField(monthText, 1, 12, MONTH_NAMES, 1);
  const weekday = parseField(weekdayText, 0, 7, DAY_NAMES, 0);
  if (minute === null || hour === null || day === null || month === null || weekday === null) {
    return null;
  }
  const everyDay = day.any && month.any;
  const weekdays = weekday.any
    ? undefined
    : [...new Set(weekday.values.map((value) => value % 7))].toSorted((a, b) => a - b);
  const [firstMinute = 0] = minute.values;
  const [firstHour = 0] = hour.values;
  // An interval runs around the clock, every day.
  const interval = (everyMs: number, exact: boolean): ScheduleMapping => ({
    schedule: { type: "interval", everyMs },
    exact: exact && everyDay && weekday.any,
  });
  const atTime = (exact: boolean) => fixedTime(firstHour, firstMinute, weekdays, exact && everyDay);

  if (minute.values.length === 1 && hour.values.length === 1) return atTime(true);
  const minuteStep = minute.any ? 1 : minute.step;
  if (minuteStep !== null) {
    return interval(minuteStep * MINUTE_MS, hour.any && 60 % minuteStep === 0);
  }
  if (minute.values.length === 1 && hour.any) return interval(60 * MINUTE_MS, true);
  if (minute.values.length === 1 && hour.step !== null) {
    return interval(hour.step * 60 * MINUTE_MS, 24 % hour.step === 0);
  }
  // Several times a day: the first of them, on the chosen days.
  return atTime(false);
}

const RRULE_WEEKDAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;

/**
 * The Tempo schedule for an RRULE (`FREQ=WEEKLY;BYDAY=MO,FR;BYHOUR=9;BYMINUTE=0`,
 * with or without `RRULE:` and a `DTSTART` line), or null when it does not parse.
 */
export function scheduleFromRrule(rrule: string): ScheduleMapping | null {
  const line = rrule
    .split(/\r?\n/)
    .map((part) => part.trim().replace(/^RRULE:/i, ""))
    .find((part) => /(^|;)FREQ=/i.test(part));
  if (line === undefined) return null;
  const parts = new Map<string, string>();
  for (const pair of line.split(";")) {
    const [key = "", value = ""] = pair.split("=");
    if (key !== "") parts.set(key.trim().toUpperCase(), value.trim().toUpperCase());
  }
  const numbers = (key: string, min: number, max: number): ReadonlyArray<number> | null => {
    const value = parts.get(key);
    if (value === undefined) return [];
    const list = value.split(",").map((entry) => Number(entry));
    return list.every((entry) => Number.isInteger(entry) && entry >= min && entry <= max)
      ? list
      : null;
  };
  const interval = Number(parts.get("INTERVAL") ?? "1");
  const minutes = numbers("BYMINUTE", 0, 59);
  const hours = numbers("BYHOUR", 0, 23);
  if (!Number.isInteger(interval) || interval < 1 || minutes === null || hours === null) {
    return null;
  }
  const dayCodes = parts.get("BYDAY")?.split(",") ?? [];
  const weekdays = dayCodes.map((code) => RRULE_WEEKDAYS.indexOf(code as never));
  if (weekdays.some((day) => day === -1)) return null;
  // Rules Tempo has no equivalent for: dates, counts, end dates, and positions.
  const plain = [
    "BYMONTH",
    "BYMONTHDAY",
    "BYYEARDAY",
    "BYWEEKNO",
    "BYSETPOS",
    "COUNT",
    "UNTIL",
  ].every((key) => !parts.has(key));
  const [minute = 0] = minutes;
  const [hour] = hours;
  const single = minutes.length <= 1 && hours.length <= 1;
  const sortedDays = [...new Set(weekdays)].toSorted((a, b) => a - b);
  const days = sortedDays.length === 0 ? undefined : sortedDays;
  const every = (everyMs: number, exact: boolean): ScheduleMapping => ({
    schedule: { type: "interval", everyMs },
    exact: exact && plain && days === undefined && hours.length === 0,
  });
  switch (parts.get("FREQ")) {
    case "MINUTELY":
      return every(interval * MINUTE_MS, minutes.length === 0);
    case "HOURLY":
      return every(interval * 60 * MINUTE_MS, minutes.length <= 1);
    case "DAILY":
    case "WEEKLY": {
      const daily = parts.get("FREQ") === "DAILY";
      // Without a time, the rule repeats at the hour it started: every day or every week.
      if (hour === undefined) {
        return every(interval * (daily ? 1 : 7) * 24 * 60 * MINUTE_MS, single);
      }
      return fixedTime(
        hour,
        minute,
        days,
        plain && single && interval === 1 && (daily || days !== undefined),
      );
    }
    case "MONTHLY":
    case "YEARLY":
      return fixedTime(hour ?? 9, minute, days, false);
    default:
      return null;
  }
}
