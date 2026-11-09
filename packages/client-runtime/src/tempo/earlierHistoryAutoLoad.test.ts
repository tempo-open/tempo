import { describe, expect, it } from "vite-plus/test";

import {
  decideEarlierHistoryAutoLoad,
  INITIAL_EARLIER_HISTORY_AUTO_LOAD,
  type EarlierHistoryAutoLoadInput,
} from "./earlierHistoryAutoLoad.ts";

const nearTop: EarlierHistoryAutoLoadInput = {
  hasMoreHistory: true,
  loading: false,
  failed: false,
  distanceFromStart: 100,
  viewportLength: 800,
  oldestEntryId: "a",
};

/** Feeds the decisions one list reading at a time, returning which readings asked for a page. */
function loadsFor(readings: ReadonlyArray<Partial<EarlierHistoryAutoLoadInput>>): boolean[] {
  let state = INITIAL_EARLIER_HISTORY_AUTO_LOAD;
  return readings.map((reading) => {
    const decision = decideEarlierHistoryAutoLoad(state, { ...nearTop, ...reading });
    state = decision.state;
    return decision.load;
  });
}

describe("decideEarlierHistoryAutoLoad", () => {
  it("asks for each page once, and keeps going while short pages leave the reader near the top", () => {
    expect(
      loadsFor([
        {},
        // Scroll events before the request shows as loading.
        {},
        { loading: true },
        // The page landed and still does not fill the view.
        { oldestEntryId: "b" },
        { oldestEntryId: "b" },
        { oldestEntryId: "c", hasMoreHistory: false },
      ]),
    ).toEqual([true, false, false, true, false, false]);
  });

  it("starts one screen above the top, and not before the viewport is measured", () => {
    expect(loadsFor([{ distanceFromStart: 801 }, { distanceFromStart: 800 }])).toEqual([
      false,
      true,
    ]);
    expect(loadsFor([{ distanceFromStart: 0, viewportLength: 0 }])).toEqual([false]);
  });

  it("asks again after a failed page only once the reader scrolls away and back", () => {
    expect(
      loadsFor([
        {},
        { loading: true },
        { failed: true },
        { failed: true },
        { failed: true, distanceFromStart: 5_000 },
        { failed: true },
        { loading: true },
        { failed: true },
      ]),
    ).toEqual([true, false, false, false, false, true, false, false]);
  });
});
