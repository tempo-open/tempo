import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "../../components/threadActionMenu.logic";
import { sidebarThreadMenuItems } from "./sidebarThreadMenu.logic";

const everything: ThreadActionMenuState = {
  canOperate: true,
  branch: "docs/release-notes",
  projectFilter: { label: "acme-app", isActive: false },
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("sidebarThreadMenuItems", () => {
  it("keeps the everyday actions, grouped by the separators of what it left out", () => {
    expect(
      sidebarThreadMenuItems(buildThreadActionMenuItems(everything)).map((item) => [
        item.id,
        item.separatorBefore === true,
      ]),
    ).toEqual([
      ["pin", false],
      ["settle", false],
      ["snooze", false],
      ["rename", true],
      ["mark-unread", false],
      ["delete", true],
    ]);
  });
});
