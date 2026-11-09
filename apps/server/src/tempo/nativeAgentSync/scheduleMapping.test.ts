import { describe, expect, it } from "vite-plus/test";

import { scheduleFromCron, scheduleFromRrule } from "./scheduleMapping.ts";

describe("scheduleFromCron", () => {
  it("runs a daily or weekday time at that time", () => {
    expect(scheduleFromCron("30 9 * * *")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "09:30" },
      exact: true,
    });
    expect(scheduleFromCron("0 17 * * 1-5")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "17:00", weekdays: [1, 2, 3, 4, 5] },
      exact: true,
    });
    expect(scheduleFromCron("0 8 * * sat,7")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "08:00", weekdays: [0, 6] },
      exact: true,
    });
  });

  it("runs steps that divide the hour or the day as intervals", () => {
    expect(scheduleFromCron("*/15 * * * *")).toEqual({
      schedule: { type: "interval", everyMs: 15 * 60_000 },
      exact: true,
    });
    expect(scheduleFromCron("* * * * *")).toEqual({
      schedule: { type: "interval", everyMs: 60_000 },
      exact: true,
    });
    expect(scheduleFromCron("5 * * * *")).toEqual({
      schedule: { type: "interval", everyMs: 60 * 60_000 },
      exact: true,
    });
    expect(scheduleFromCron("0 */6 * * *")).toEqual({
      schedule: { type: "interval", everyMs: 6 * 60 * 60_000 },
      exact: true,
    });
  });

  it("maps what Tempo cannot follow to the nearest schedule and says so", () => {
    // A date: Tempo has no monthly or one-off schedule.
    expect(scheduleFromCron("30 14 28 2 *")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "14:30" },
      exact: false,
    });
    // Twice a day: only the first time.
    expect(scheduleFromCron("0 9,17 * * 1-5")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1, 2, 3, 4, 5] },
      exact: false,
    });
    // Working hours only: the interval runs around the clock.
    expect(scheduleFromCron("*/30 9-17 * * 1-5")).toEqual({
      schedule: { type: "interval", everyMs: 30 * 60_000 },
      exact: false,
    });
    // Cron restarts a 7-minute step every hour.
    expect(scheduleFromCron("*/7 * * * *")?.exact).toBe(false);
  });

  it("rejects what is not a 5-field cron", () => {
    expect(scheduleFromCron("every morning")).toBeNull();
    expect(scheduleFromCron("0 9 * *")).toBeNull();
    expect(scheduleFromCron("61 9 * * *")).toBeNull();
    expect(scheduleFromCron("0 9 * * 1-")).toBeNull();
  });
});

describe("scheduleFromRrule", () => {
  it("runs the Codex app's daily, weekly and hourly rules exactly", () => {
    // The Codex app's default: every 24 hours.
    expect(scheduleFromRrule("FREQ=HOURLY;INTERVAL=24;BYMINUTE=0")).toEqual({
      schedule: { type: "interval", everyMs: 24 * 60 * 60_000 },
      exact: true,
    });
    expect(scheduleFromRrule("RRULE:FREQ=DAILY;BYHOUR=9;BYMINUTE=15")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "09:15" },
      exact: true,
    });
    expect(scheduleFromRrule("FREQ=WEEKLY;BYDAY=FR,MO;BYHOUR=17;BYMINUTE=0")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "17:00", weekdays: [1, 5] },
      exact: true,
    });
    expect(
      scheduleFromRrule(
        "DTSTART;TZID=America/Los_Angeles:20261001T090000\nFREQ=MINUTELY;INTERVAL=30",
      ),
    ).toEqual({ schedule: { type: "interval", everyMs: 30 * 60_000 }, exact: true });
  });

  it("maps rules Tempo cannot follow to the nearest schedule and says so", () => {
    expect(scheduleFromRrule("FREQ=MONTHLY;BYMONTHDAY=1;BYHOUR=9;BYMINUTE=0")).toEqual({
      schedule: { type: "fixed_time", timeOfDay: "09:00" },
      exact: false,
    });
    expect(scheduleFromRrule("FREQ=DAILY;INTERVAL=2;BYHOUR=8;BYMINUTE=0")?.exact).toBe(false);
    expect(scheduleFromRrule("FREQ=DAILY;BYHOUR=8,18;BYMINUTE=0")?.exact).toBe(false);
    expect(scheduleFromRrule("FREQ=HOURLY;BYDAY=MO,TU")?.exact).toBe(false);
  });

  it("rejects what is not an RRULE", () => {
    expect(scheduleFromRrule("every day")).toBeNull();
    expect(scheduleFromRrule("FREQ=SECONDLY")).toBeNull();
    expect(scheduleFromRrule("FREQ=DAILY;BYHOUR=25")).toBeNull();
    expect(scheduleFromRrule("FREQ=WEEKLY;BYDAY=1MO")).toBeNull();
  });
});
