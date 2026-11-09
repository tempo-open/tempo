import { type TempoActivityDay, UsageDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { formatAverage, formatDay, formatMeasure, formatMonth } from "./activityFormat";
import { everyNumber, heatMap, modelShares, streaks, summarizeMeasure } from "./activitySummary";

const HOUR_MS = 3_600_000;

function day(
  date: string,
  overrides: Partial<Omit<TempoActivityDay, "day">> = {},
): TempoActivityDay {
  return {
    day: UsageDay.make(date),
    threads: 0,
    agents: null,
    workedMs: 0,
    outputTokens: 0,
    commits: 0,
    mergedPullRequests: 0,
    ...overrides,
  };
}

/** Consecutive days from `first`, one per entry. */
function days(first: string, entries: ReadonlyArray<Partial<Omit<TempoActivityDay, "day">>>) {
  const start = Date.parse(`${first}T00:00:00Z`);
  return entries.map((entry, index) =>
    day(new Date(start + index * 86_400_000).toISOString().slice(0, 10), entry),
  );
}

describe("everyNumber", () => {
  // 19 days; agents are recorded from the 13th day on.
  const history = days(
    "2026-10-20",
    Array.from({ length: 19 }, (_, index) => ({
      threads: index + 1,
      agents: index >= 12 ? 10 : null,
      workedMs: index === 18 ? 0.05 * HOUR_MS : HOUR_MS,
      commits: index % 2,
    })),
  );
  const rows = Object.fromEntries(everyNumber(history).map((row) => [row.key, row]));

  it("sums today, the last 7 days, the week before, last month and every day", () => {
    expect(rows.today!.cells.threads).toEqual({ value: 19 });
    expect(rows.last7!.cells.threads).toEqual({ value: 13 + 14 + 15 + 16 + 17 + 18 + 19 });
    expect(rows.weekBefore!.cells.threads).toEqual({ value: 6 + 7 + 8 + 9 + 10 + 11 + 12 });
    expect(rows.lastMonth).toMatchObject({ period: "2026-10", cells: { threads: { value: 78 } } });
    expect(rows.since).toMatchObject({ period: "2026-10-20", cells: { threads: { value: 190 } } });
  });

  it("says a measure was not counted over days that never recorded it", () => {
    expect(rows.weekBefore!.cells.agents).toBeNull();
    expect(rows.lastMonth!.cells.agents).toBeNull();
    expect(rows.last7!.cells.agents).toEqual({ value: 70 });
    expect(rows.since!.cells.agents).toEqual({ value: 70 });
    expect(rows.average!.cells.agents).toEqual({ value: 10 });
    expect(rows.count!.cells.agents).toEqual({ value: 7 });
  });

  it("rounds hours worked per day to a tenth, half up, before summing", () => {
    expect(rows.today!.cells.hours).toEqual({ value: 1 });
    expect(rows.since!.cells.hours).toEqual({ value: 18 * 10 + 1 });
  });

  it("finds the first busiest day and counts the days with any of a measure", () => {
    expect(rows.best!.cells.threads).toEqual({ day: "2026-11-07", value: 19 });
    expect(rows.best!.cells.commits).toEqual({ day: "2026-10-21", value: 1 });
    expect(rows.count!.cells.commits).toEqual({ value: 9 });
    expect(rows.best!.cells.mergedPullRequests).toEqual({ value: 0 });
    expect(rows.average!.cells.threads).toEqual({ value: 10 });
  });
});

describe("GitHub days not read yet", () => {
  // Nine days; GitHub has answered for the first five only.
  const history = days("2026-10-30", [
    { commits: 5, mergedPullRequests: 1 },
    { commits: 2, mergedPullRequests: 0 },
    { commits: 4, mergedPullRequests: 2 },
    { commits: 0, mergedPullRequests: 0 },
    { commits: 2, mergedPullRequests: 1 },
    ...Array.from({ length: 4 }, () => ({ commits: null, mergedPullRequests: null })),
  ]);
  const rows = Object.fromEntries(everyNumber(history).map((row) => [row.key, row]));

  it("gives no number over a range that holds one", () => {
    for (const key of ["today", "last7", "since", "average", "best", "count"]) {
      expect(rows[key]!.cells.commits).toBeNull();
      expect(rows[key]!.cells.mergedPullRequests).toBeNull();
    }
    expect(summarizeMeasure(history, "commits")).toMatchObject({
      total: null,
      since: null,
      thisMonth: null,
      dailyAverage: null,
      busiest: null,
    });
    expect(streaks(history).commitDays).toBeNull();
    expect(heatMap(history, "commits", 2).filter((cell) => cell?.busiest)).toEqual([]);
  });

  it("counts a range GitHub has answered for", () => {
    expect(rows.lastMonth!.cells.commits).toEqual({ value: 7 });
    expect(rows.weekBefore!.cells.mergedPullRequests).toEqual({ value: 1 });
    expect(summarizeMeasure(history, "commits").lastMonth).toBe(7);
    const answered = days("2026-11-01", [{ commits: null }, { commits: 0 }, { commits: 2 }]);
    expect(streaks(answered).commitDays).toBe(1);
  });
});

describe("summarizeMeasure", () => {
  it("totals a measure since it was first recorded, last month and this month", () => {
    const history = days("2026-10-30", [
      { agents: null, threads: 2 },
      { agents: null, threads: 3 },
      { agents: 4, threads: 1 },
      { agents: 6, threads: 0 },
    ]);
    expect(summarizeMeasure(history, "agents")).toEqual({
      total: 10,
      since: "2026-11-01",
      lastMonth: null,
      thisMonth: 10,
      dailyAverage: 5,
      recordedDays: 2,
      busiest: { day: "2026-11-02", value: 6 },
    });
    expect(summarizeMeasure(history, "threads")).toMatchObject({ lastMonth: 5, thisMonth: 1 });
  });
});

describe("streaks", () => {
  it("counts the run up to today, or up to yesterday while today has none yet", () => {
    const history = days("2026-11-01", [
      { commits: 1, threads: 1, workedMs: HOUR_MS },
      { commits: 0, threads: 1, workedMs: HOUR_MS },
      { commits: 2, threads: 1, workedMs: HOUR_MS },
      { commits: 3, threads: 0, workedMs: 0 },
      { commits: 1, threads: 1, workedMs: HOUR_MS },
      { commits: 0, threads: 1, workedMs: HOUR_MS },
    ]);
    expect(streaks(history)).toEqual({ commitDays: 3, threadDays: 2, longestWorked: 3 });
  });

  it("has no commit streak without GitHub", () => {
    expect(streaks(days("2026-11-01", [{ commits: null }])).commitDays).toBeNull();
  });
});

describe("heatMap", () => {
  it("starts the first week on Sunday and keeps the most recent weeks", () => {
    // Wednesday Jul 1 2026 to Saturday Jul 18: three weeks.
    const history = days(
      "2026-07-01",
      Array.from({ length: 18 }, () => ({ threads: 1 })),
    );
    expect(heatMap(history, "threads", 3)[0]?.day).toBe("2026-07-01");
    expect(heatMap(history, "threads", 2)[0]?.day).toBe("2026-07-05");
  });

  it("levels busy days by quartile, marks the busiest and leaves unrecorded days apart", () => {
    // From a Sunday onward.
    const history = days("2026-11-01", [
      { agents: null },
      { agents: 0 },
      { agents: 1 },
      { agents: 2 },
      { agents: 3 },
      { agents: 4 },
      { agents: 9 },
    ]);
    expect(heatMap(history, "agents", 19).map((cell) => cell?.level)).toEqual([
      null,
      0,
      1,
      1,
      2,
      3,
      4,
    ]);
    expect(heatMap(history, "agents", 19).filter((cell) => cell?.busiest)).toHaveLength(1);
  });
});

describe("modelShares", () => {
  const model = (outputTokens: number) => ({ outputTokens });

  it("names the largest models and sums the rest into one row", () => {
    const shares = modelShares([1, 9, 4, 3, 2, 8, 5].map(model), 5);
    expect(shares.total).toBe(32);
    expect(shares.rows.map((row) => [row.model?.outputTokens ?? null, row.outputTokens])).toEqual([
      [9, 9],
      [8, 8],
      [5, 5],
      [4, 4],
      [3, 3],
      [null, 3],
    ]);
  });

  it("never folds a single model into the rest", () => {
    expect(modelShares([1, 2, 3, 4, 5, 6].map(model), 5).rows.every((row) => row.model)).toBe(true);
  });
});

describe("activity numbers in words", () => {
  it.each([
    ["tokens", 2_634_000, "2.6M"],
    ["tokens", 10_910_000, "10.9M"],
    ["tokens", 346_200_000, "346M"],
    ["tokens", 412_300, "412K"],
    ["hours", 724, "72.4"],
    ["hours", 1_342, "134"],
    ["commits", 1_242, "1,242"],
  ] as const)("writes %s %d as %s", (measure, value, text) => {
    expect(formatMeasure(measure, value)).toBe(text);
  });

  it("writes a daily average with one decimal below ten", () => {
    expect(formatAverage("threads", 3.849)).toBe("3.8");
    expect(formatAverage("commits", 40.4)).toBe("40");
    expect(formatAverage("hours", 29)).toBe("2.9");
  });

  it("writes days and months as the page reads them", () => {
    expect(formatDay("2026-06-28")).toBe("June 28");
    expect(formatDay("2026-10-16")).toBe("Oct 16");
    expect(formatMonth("2026-10")).toBe("October");
  });
});
