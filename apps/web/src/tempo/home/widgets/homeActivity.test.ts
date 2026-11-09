import type { TempoActivityDay } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { heatMap, HEAT_MAP_WEEKS, monthTotals } from "./homeActivity";

function day(
  date: string,
  threads: number,
  extra: Partial<TempoActivityDay> = {},
): TempoActivityDay {
  return {
    day: date as TempoActivityDay["day"],
    threads,
    agents: null,
    workedMs: 0,
    outputTokens: null,
    commits: null,
    mergedPullRequests: null,
    ...extra,
  };
}

/** `count` days from `start`, each with the threads `threads` gives its index. */
function days(start: string, count: number, threads: (index: number) => number) {
  const first = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, index) =>
    day(new Date(first + index * 86_400_000).toISOString().slice(0, 10), threads(index)),
  );
}

describe("heatMap", () => {
  it("starts each column on Sunday and counts threads and agents started", () => {
    // Nov 4 2026 is a Wednesday.
    const map = heatMap([
      day("2026-11-04", 1, { agents: null }),
      day("2026-11-05", 2, { agents: 3 }),
      day("2026-11-06", 0, { agents: 0 }),
      day("2026-11-07", 4, { agents: 4 }),
    ]);
    expect(map?.cells.map((cell) => cell.level)).toEqual([1, 2, 0, 4]);
    expect(map).toMatchObject({ threads: 7, agents: 7 });
  });

  it("shows only the most recent weeks, from the first one shown", () => {
    // June 28 2026 is a Sunday; 30 weeks of days.
    const map = heatMap(days("2026-06-28", 30 * 7, () => 1));
    expect(map?.cells).toHaveLength(HEAT_MAP_WEEKS * 7);
    expect(map?.cells[0]?.day).toBe("2026-09-13");
    expect(map).toMatchObject({ threads: HEAT_MAP_WEEKS * 7 });
  });

  it("leaves agents out when no day shown recorded them", () => {
    expect(heatMap([day("2026-11-07", 2)])).toMatchObject({ threads: 2, agents: null });
    expect(heatMap([])).toBeNull();
  });
});

describe("monthTotals", () => {
  it("sums the month today falls in, and says not counted when no day recorded a measure", () => {
    expect(
      monthTotals([
        day("2026-10-31", 9, { mergedPullRequests: 9, outputTokens: 9 }),
        day("2026-11-01", 2, { outputTokens: 1_000 }),
        day("2026-11-02", 3, { outputTokens: 500 }),
      ]),
    ).toEqual({ threads: 5, mergedPullRequests: null, outputTokens: 1_500 });
  });
});
