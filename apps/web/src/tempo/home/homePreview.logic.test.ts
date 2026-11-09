import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import { groupHomePreviewThreads } from "./homePreview.logic";

// 3 PM local, so an hour earlier is the same local day in any zone the tests run in.
const NOW = new Date(2026, 10, 8, 15).getTime();
const hoursFromNow = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();

const thread = (id: string, overrides: ThreadFixtureOverrides = {}) =>
  makeThreadFixture({ id: ThreadId.make(id), title: id, ...overrides });

describe("groupHomePreviewThreads", () => {
  it("files each thread by the sidebar's rules, and counts every settled thread for Show all", () => {
    const groups = groupHomePreviewThreads({
      threads: [
        thread("open"),
        thread("pinned", { pinnedAt: hoursFromNow(-5) }),
        thread("settled today", { settledOverride: "settled", settledAt: hoursFromNow(-1) }),
        thread("settled before", { settledOverride: "settled", settledAt: hoursFromNow(-72) }),
        thread("snoozed", { snoozedUntil: hoursFromNow(24) }),
        thread("archived", { archivedAt: hoursFromNow(-2) }),
      ],
      delegatedUnderParent: new Set(),
      visitedAtById: {},
      isSidebarV2: true,
      workingShelfEnabled: true,
      productionWaitShelfEnabled: false,
      nowMs: NOW,
    });
    const titles = (threads: readonly { title: string }[]) => threads.map(({ title }) => title);

    expect(titles(groups.pinned)).toEqual(["pinned"]);
    expect(titles(groups.open)).toEqual(["open"]);
    expect(titles(groups.settledToday)).toEqual(["settled today"]);
    expect(groups.settledCount).toBe(2);
    expect(groups.shelves).toEqual([{ label: "Snoozed", count: 1 }]);
  });
});
