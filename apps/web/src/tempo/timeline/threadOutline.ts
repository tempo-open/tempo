/**
 * tempo: the minimap's marks for a whole thread. The server's outline (tempoThreadOutline.ts) lists every
 * user message; the loaded rows hold the latest. The minimap shows the outline's messages older
 * than the loaded window, then the loaded ones, so turns that arrive live need no refetch.
 */
import { TEMPO_THREAD_OUTLINE_WS_METHODS, type TempoThreadOutlineEntry } from "@t3tools/contracts";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";

import type { TimelineMinimapItem } from "../../components/chat/timelineMinimapItems";
import { connectionAtomRuntime } from "../../connection/runtime";

export const threadOutlineQuery = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:tempo:thread-outline",
  tag: TEMPO_THREAD_OUTLINE_WS_METHODS.get,
});

/** The row index of a mark whose message is not loaded yet. */
export const UNLOADED_MINIMAP_ROW_INDEX = -1;

export function mergeMinimapOutline(
  loaded: ReadonlyArray<TimelineMinimapItem>,
  outline: ReadonlyArray<TempoThreadOutlineEntry> | null,
): ReadonlyArray<TimelineMinimapItem> {
  if (outline === null || outline.length === 0) return loaded;
  const loadedIds = new Set(loaded.map((item) => item.id));
  // The loaded rows are the newest part of the timeline, so the outline's entries
  // before the first loaded message are exactly the ones not loaded yet.
  const firstLoaded = outline.findIndex((entry) => loadedIds.has(entry.id));
  const older = firstLoaded === -1 ? outline : outline.slice(0, firstLoaded);
  if (older.length === 0) return loaded;
  return [
    ...older.map((entry) => ({
      id: entry.id,
      rowIndex: UNLOADED_MINIMAP_ROW_INDEX,
      userText: entry.text,
      assistantText: null,
    })),
    ...loaded,
  ];
}

/** A jump to a minimap mark whose message is still loading. */
export interface MinimapOutlineJump {
  readonly messageId: string;
  /** The oldest loaded entry when history was last loaded toward the message. */
  readonly requestedFor: string | null;
  /** Whether that load has been seen running. */
  readonly sawLoading: boolean;
}

export type MinimapOutlineJumpStep =
  | { readonly action: "scroll"; readonly rowIndex: number }
  | { readonly action: "load" }
  | { readonly action: "loading" }
  | { readonly action: "wait" }
  | { readonly action: "stop" };

/**
 * The next step of a jump. History loads through the message one page at a time, since a page
 * reaches only so many turns back. A page that ran and left the oldest entry as it was failed or
 * added nothing, so the jump stops there.
 */
export function nextMinimapOutlineJumpStep(
  jump: MinimapOutlineJump,
  history: {
    readonly rowIndex: number;
    readonly loading: boolean;
    readonly hasMoreHistory: boolean;
    readonly oldestEntryId: string;
  },
): MinimapOutlineJumpStep {
  if (history.rowIndex >= 0) return { action: "scroll", rowIndex: history.rowIndex };
  if (history.loading) return { action: "loading" };
  if (!history.hasMoreHistory) return { action: "stop" };
  if (jump.requestedFor !== history.oldestEntryId) return { action: "load" };
  return jump.sawLoading ? { action: "stop" } : { action: "wait" };
}
