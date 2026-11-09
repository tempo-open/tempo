import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { isSameSchedule, nextScheduledRunAt, pinEveryDaysStart } from "./Schedule.ts";

describe("scheduled task schedule calculation", () => {
  it("skips to the next matching fixed-time weekday", () => {
    const next = nextScheduledRunAt(
      { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      DateTime.makeZonedUnsafe(
        {
          year: 2026,
          month: 7,
          day: 3,
          hour: 10,
          minute: 0,
          second: 0,
          millisecond: 0,
        },
        { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
      ),
    );
    const parts = next ? DateTime.toParts(next) : null;
    expect(parts?.weekDay).toBe(1);
    expect(parts?.hour).toBe(9);
    expect(parts?.minute).toBe(0);
  });

  it("compares schedules structurally", () => {
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 60_000 }),
    ).toBe(true);
    expect(
      isSameSchedule({ type: "interval", everyMs: 60_000 }, { type: "interval", everyMs: 30_000 }),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [5, 1] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 5, 5] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [] },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(true);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2] },
        { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 3] },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "fixed_time", timeOfDay: "09:00" },
        { type: "fixed_time", timeOfDay: "09:30" },
      ),
    ).toBe(false);
    expect(
      isSameSchedule(
        { type: "interval", everyMs: 60_000 },
        { type: "fixed_time", timeOfDay: "09:00" },
      ),
    ).toBe(false);
  });
});

// tempo: every N calendar days at a fixed time, counted from startDate.
describe("every-N-days schedules", () => {
  const pacific = (day: number, hour: number, month = 10) =>
    DateTime.makeZonedUnsafe(
      { year: 2026, month, day, hour, minute: 0, second: 0, millisecond: 0 },
      { timeZone: "America/Los_Angeles", adjustForTimeZone: true },
    );
  const everyThreeDays = {
    type: "fixed_time",
    timeOfDay: "09:00",
    everyDays: 3,
    startDate: "2026-10-20",
  } as const;
  const local = (next: DateTime.DateTime | null) =>
    next === null ? null : DateTime.formatIso(DateTime.toUtc(next));

  it("runs on the start day and every third day after it, at the same local time", () => {
    expect(local(nextScheduledRunAt(everyThreeDays, pacific(20, 8)))).toBe(
      "2026-10-20T16:00:00.000Z",
    );
    expect(local(nextScheduledRunAt(everyThreeDays, pacific(20, 10)))).toBe(
      "2026-10-23T16:00:00.000Z",
    );
    expect(local(nextScheduledRunAt(everyThreeDays, pacific(21, 9)))).toBe(
      "2026-10-23T16:00:00.000Z",
    );
    expect(local(nextScheduledRunAt(everyThreeDays, pacific(15, 9)))).toBe(
      "2026-10-20T16:00:00.000Z",
    );
  });

  it("keeps 9 AM local across the end of daylight saving time", () => {
    // Daylight saving time ends on 2026-11-01, between 10-29 and 11-01.
    expect(local(nextScheduledRunAt(everyThreeDays, pacific(29, 10)))).toBe(
      "2026-11-01T17:00:00.000Z",
    );
  });

  it("pins a new schedule to the next day its time comes up, and keeps that rhythm on edits", () => {
    const unpinned = { type: "fixed_time", timeOfDay: "09:00", everyDays: 3 } as const;
    expect(pinEveryDaysStart(unpinned, pacific(20, 8), null)).toEqual(everyThreeDays);
    expect(pinEveryDaysStart(unpinned, pacific(20, 10), null)).toEqual({
      ...everyThreeDays,
      startDate: "2026-10-21",
    });
    expect(pinEveryDaysStart(unpinned, pacific(25, 12), everyThreeDays)).toEqual(everyThreeDays);
    expect(
      pinEveryDaysStart({ ...unpinned, everyDays: 4 }, pacific(25, 12), everyThreeDays),
    ).toEqual({ ...everyThreeDays, everyDays: 4, startDate: "2026-10-26" });
  });

  it("treats every one day as daily and refuses mixed or impossible schedules", () => {
    expect(
      pinEveryDaysStart(
        { type: "fixed_time", timeOfDay: "09:00", everyDays: 1, startDate: "2026-10-20" },
        pacific(20, 8),
        null,
      ),
    ).toEqual({ type: "fixed_time", timeOfDay: "09:00" });
    expect(
      pinEveryDaysStart({ ...everyThreeDays, weekdays: [1, 3] }, pacific(20, 8), null),
    ).toBeTypeOf("string");
    expect(
      pinEveryDaysStart({ ...everyThreeDays, startDate: "2026-02-30" }, pacific(20, 8), null),
    ).toBeTypeOf("string");
  });

  it("restarts the clock when the gap or first day changes", () => {
    expect(isSameSchedule(everyThreeDays, { ...everyThreeDays })).toBe(true);
    expect(isSameSchedule(everyThreeDays, { ...everyThreeDays, everyDays: 4 })).toBe(false);
    expect(isSameSchedule(everyThreeDays, { ...everyThreeDays, startDate: "2026-10-21" })).toBe(
      false,
    );
    expect(isSameSchedule(everyThreeDays, { type: "fixed_time", timeOfDay: "09:00" })).toBe(false);
  });
});
