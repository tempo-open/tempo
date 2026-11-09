import { MIN_SCHEDULED_TASK_INTERVAL_MS, type ScheduledTaskSchedule } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const MINUTE_MS = 60_000;

function parseTimeOfDay(value: string): { hour: number; minute: number } | null {
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(value.trim());
  if (!match) return null;
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

export function nextScheduledRunAt(
  schedule: ScheduledTaskSchedule,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  if (schedule.type === "webhook") return null;
  if (schedule.type === "interval") {
    // Intervals advance elapsed time, including across daylight-saving changes.
    return DateTime.addDuration(from, Math.max(schedule.everyMs, MIN_SCHEDULED_TASK_INTERVAL_MS));
  }

  const time = parseTimeOfDay(schedule.timeOfDay);
  if (time === null) return null;
  if ((schedule.everyDays ?? 1) > 1) return nextEveryDaysRunAt(schedule, time, from);
  const weekdays =
    schedule.weekdays && schedule.weekdays.length > 0 ? new Set(schedule.weekdays) : null;
  for (let offset = 0; offset <= 7; offset += 1) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: offset }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) <= DateTime.toEpochMillis(from)) continue;
    if (weekdays !== null && !weekdays.has(DateTime.toParts(candidate).weekDay)) continue;
    return candidate;
  }
  return null;
}

type FixedTimeSchedule = Extract<ScheduledTaskSchedule, { readonly type: "fixed_time" }>;

const DAY_MS = 24 * 60 * MINUTE_MS;

/** tempo: days since the epoch for a local calendar date, or null when it is not a real date. */
function epochDay(date: string): number | null {
  const [year, month, day] = date.split("-").map(Number);
  if (year === undefined || month === undefined || day === undefined) return null;
  const utc = DateTime.make({ year, month, day });
  if (utc._tag === "None" || DateTime.formatIsoDateUtc(utc.value) !== date) return null;
  return DateTime.toEpochMillis(utc.value) / DAY_MS;
}

/**
 * tempo: runs on startDate and every `everyDays` calendar days after it. Days are
 * counted in local time, so a run keeps its wall-clock time across daylight
 * saving changes.
 */
function nextEveryDaysRunAt(
  schedule: FixedTimeSchedule,
  time: { hour: number; minute: number },
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  const everyDays = schedule.everyDays ?? 1;
  const startDay = schedule.startDate === undefined ? null : epochDay(schedule.startDate);
  const fromDay = epochDay(DateTime.formatIsoDate(from));
  if (startDay === null || fromDay === null) return null;
  let day =
    fromDay <= startDay
      ? startDay
      : startDay + Math.ceil((fromDay - startDay) / everyDays) * everyDays;
  for (let attempt = 0; attempt < 2; attempt += 1, day += everyDays) {
    const candidate = DateTime.setParts(DateTime.add(from, { days: day - fromDay }), {
      hour: time.hour,
      minute: time.minute,
      second: 0,
      millisecond: 0,
    });
    if (DateTime.toEpochMillis(candidate) > DateTime.toEpochMillis(from)) return candidate;
  }
  return null;
}

/**
 * tempo: pins an every-N-days schedule to the day it starts, so edits and missed
 * runs keep its rhythm. Keeps `previous`'s start for the same gap, and otherwise
 * starts on the next day `timeOfDay` comes up. Returns the reason a schedule is
 * refused.
 */
export function pinEveryDaysStart(
  schedule: FixedTimeSchedule,
  now: DateTime.DateTime,
  previous: ScheduledTaskSchedule | null,
): FixedTimeSchedule | string {
  const { everyDays, startDate, ...rest } = schedule;
  if ((everyDays ?? 1) <= 1) return rest;
  if ((schedule.weekdays?.length ?? 0) > 0) {
    return "Choose weekdays or everyDays for a fixed-time schedule, not both.";
  }
  if (startDate !== undefined) {
    return epochDay(startDate) === null
      ? `startDate ${startDate} is not a real calendar date.`
      : { ...rest, everyDays, startDate };
  }
  if (
    previous?.type === "fixed_time" &&
    previous.everyDays === everyDays &&
    previous.startDate !== undefined
  ) {
    return { ...rest, everyDays, startDate: previous.startDate };
  }
  const first = nextScheduledRunAt(rest, now);
  return first === null
    ? `timeOfDay ${schedule.timeOfDay} is not a valid time.`
    : { ...rest, everyDays, startDate: DateTime.formatIsoDate(first) };
}

function weekdayKey(weekdays: ReadonlyArray<number> | undefined): string {
  const unique = [...new Set(weekdays ?? [])].toSorted((x, y) => x - y);
  if (unique.length === 0 || unique.length === 7) return "daily";
  return unique.join(",");
}

export function isSameSchedule(a: ScheduledTaskSchedule, b: ScheduledTaskSchedule): boolean {
  if (a.type === "interval") {
    return b.type === "interval" && a.everyMs === b.everyMs;
  }
  if (a.type === "webhook") return b.type === "webhook";
  if (b.type !== "fixed_time") return false;
  // Compare parsed times so padded-hour edits do not reschedule pending runs.
  const aTime = parseTimeOfDay(a.timeOfDay);
  const bTime = parseTimeOfDay(b.timeOfDay);
  return (
    aTime !== null &&
    bTime !== null &&
    aTime.hour === bTime.hour &&
    aTime.minute === bTime.minute &&
    weekdayKey(a.weekdays) === weekdayKey(b.weekdays) &&
    // tempo: every-N-days schedules also match on their gap and first day.
    (a.everyDays ?? 1) === (b.everyDays ?? 1) &&
    ((a.everyDays ?? 1) <= 1 || a.startDate === b.startDate)
  );
}

const MISSED_FIXED_TIME_GRACE_MS = 10 * MINUTE_MS;

export function isMissedFixedTimeRun(
  schedule: ScheduledTaskSchedule,
  dueAt: DateTime.DateTime,
  now: DateTime.DateTime,
): boolean {
  if (schedule.type !== "fixed_time") return false;
  return DateTime.toEpochMillis(now) - DateTime.toEpochMillis(dueAt) > MISSED_FIXED_TIME_GRACE_MS;
}
