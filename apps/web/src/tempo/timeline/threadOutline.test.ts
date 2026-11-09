import { MessageId, type TempoThreadOutlineEntry } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { TimelineMinimapItem } from "../../components/chat/timelineMinimapItems";
import {
  mergeMinimapOutline,
  nextMinimapOutlineJumpStep,
  UNLOADED_MINIMAP_ROW_INDEX,
  type MinimapOutlineJump,
} from "./threadOutline";

const outline = (...ids: ReadonlyArray<string>): TempoThreadOutlineEntry[] =>
  ids.map((id) => ({
    id: MessageId.make(id),
    text: `${id} text`,
    createdAt: "2026-10-30T00:00:00Z",
  }));

const loaded = (...ids: ReadonlyArray<string>): TimelineMinimapItem[] =>
  ids.map((id, index) => ({
    id,
    rowIndex: index * 3,
    userText: `${id} loaded`,
    assistantText: `${id} reply`,
  }));

const marks = (items: ReadonlyArray<TimelineMinimapItem>) =>
  items.map((item) => [
    item.id,
    item.rowIndex === UNLOADED_MINIMAP_ROW_INDEX ? "unloaded" : "loaded",
  ]);

describe("mergeMinimapOutline", () => {
  it("marks the outline's older messages before the loaded ones, which keep their rows", () => {
    const merged = mergeMinimapOutline(loaded("m3", "m4"), outline("m1", "m2", "m3", "m4"));
    expect(marks(merged)).toEqual([
      ["m1", "unloaded"],
      ["m2", "unloaded"],
      ["m3", "loaded"],
      ["m4", "loaded"],
    ]);
    expect(merged[0]).toEqual({
      id: "m1",
      rowIndex: UNLOADED_MINIMAP_ROW_INDEX,
      userText: "m1 text",
      assistantText: null,
    });
    expect(merged[2]).toEqual(loaded("m3")[0]);
  });

  it("keeps messages that arrived after the outline was read, and loaded ones it never had", () => {
    // m5 is a new turn; the loaded window starts inside m2's turn, so m2 is not loaded.
    expect(marks(mergeMinimapOutline(loaded("m5"), outline("m1", "m2")))).toEqual([
      ["m1", "unloaded"],
      ["m2", "unloaded"],
      ["m5", "loaded"],
    ]);
    expect(marks(mergeMinimapOutline(loaded("m3", "m4", "m5"), outline("m1", "m2", "m3")))).toEqual(
      [
        ["m1", "unloaded"],
        ["m2", "unloaded"],
        ["m3", "loaded"],
        ["m4", "loaded"],
        ["m5", "loaded"],
      ],
    );
  });

  it("shows only the loaded marks once everything is loaded or without an outline", () => {
    const items = loaded("m1", "m2");
    expect(mergeMinimapOutline(items, outline("m1", "m2"))).toBe(items);
    expect(mergeMinimapOutline(items, null)).toBe(items);
    expect(mergeMinimapOutline(items, [])).toBe(items);
  });
});

describe("nextMinimapOutlineJumpStep", () => {
  const jump: MinimapOutlineJump = { messageId: "m1", requestedFor: null, sawLoading: false };
  const history = { rowIndex: -1, loading: false, hasMoreHistory: true, oldestEntryId: "e9" };

  it("scrolls once the message has a row, even while the rest of its page loads", () => {
    expect(nextMinimapOutlineJumpStep(jump, { ...history, rowIndex: 4, loading: true })).toEqual({
      action: "scroll",
      rowIndex: 4,
    });
  });

  it("loads one page at a time toward the message", () => {
    expect(nextMinimapOutlineJumpStep(jump, history).action).toBe("load");
    const requested = { ...jump, requestedFor: "e9" };
    expect(nextMinimapOutlineJumpStep(requested, history).action).toBe("wait");
    expect(nextMinimapOutlineJumpStep(requested, { ...history, loading: true }).action).toBe(
      "loading",
    );
    // That page landed without reaching the message.
    const ran = { ...requested, sawLoading: true };
    expect(nextMinimapOutlineJumpStep(ran, { ...history, oldestEntryId: "e5" }).action).toBe(
      "load",
    );
  });

  it("stops when a page ends without progress or history runs out", () => {
    const ran = { ...jump, requestedFor: "e9", sawLoading: true };
    expect(nextMinimapOutlineJumpStep(ran, history).action).toBe("stop");
    expect(nextMinimapOutlineJumpStep(jump, { ...history, hasMoreHistory: false }).action).toBe(
      "stop",
    );
  });
});
