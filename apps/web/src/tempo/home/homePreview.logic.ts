import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { countSettledToday } from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { sortSettledThreads } from "@t3tools/client-runtime/state/thread-sort";

import {
  filterSidebarV2VisibleThreads,
  resolveThreadLastVisitedAt,
  sortPinnedThreadsForSidebar,
  sortThreadsForSidebar,
  type SidebarSection,
} from "../../components/Sidebar.logic";
import { EMPTY_ROUTE_NEEDS_HOLD } from "../sidebar/needsYou.logic";
import { resolveSidebarRowSection } from "../sidebar/sidebarV2.logic";

/** The shelves the tempo sidebar docks at its foot, in its order, with their labels. */
const DOCKED_SHELVES = [
  ["working", "Working"],
  ["background", "Waiting"],
  ["snoozed", "Snoozed"],
  ["waiting", "Waiting for Production"],
] as const satisfies ReadonlyArray<readonly [SidebarSection, string]>;

export interface HomePreviewThreadGroups<T> {
  readonly pinned: readonly T[];
  readonly open: readonly T[];
  readonly settledToday: readonly T[];
  readonly settledCount: number;
  readonly shelves: ReadonlyArray<{ readonly label: string; readonly count: number }>;
}

/**
 * The tempo sidebar's groups for the Appearance preview: each thread filed by the sidebar's own
 * rules, as no thread is open behind Settings. The shelves stay folded, as they start.
 */
export function groupHomePreviewThreads<T extends EnvironmentThreadShell>(input: {
  readonly threads: readonly T[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly visitedAtById: Readonly<Record<string, string>>;
  readonly isSidebarV2: boolean;
  readonly workingShelfEnabled: boolean;
  readonly productionWaitShelfEnabled: boolean;
  readonly nowMs: number;
}): HomePreviewThreadGroups<T> {
  const now = new Date(input.nowMs).toISOString();
  const sections = new Map<SidebarSection, T[]>();
  for (const thread of filterSidebarV2VisibleThreads(
    input.threads,
    null,
    input.delegatedUnderParent,
  )) {
    const threadKey = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
    const { section } = resolveSidebarRowSection({
      thread,
      isSidebarV2: input.isSidebarV2,
      workingShelfEnabled: input.workingShelfEnabled,
      lastVisitedAt: resolveThreadLastVisitedAt(
        thread.lastVisitedAt,
        input.visitedAtById[threadKey],
      ),
      isOpen: false,
      hold: EMPTY_ROUTE_NEEDS_HOLD,
      snoozed: effectiveSnoozed(thread, { now }),
      settled: thread.settledOverride === "settled",
      productionWaitShelfEnabled: input.productionWaitShelfEnabled,
    });
    sections.set(section, [...(sections.get(section) ?? []), thread]);
  }
  const settled = sortSettledThreads(sections.get("settled") ?? []);
  return {
    pinned: sortPinnedThreadsForSidebar(sections.get("pinned") ?? []),
    open: sortThreadsForSidebar(sections.get("active") ?? []),
    settledToday: settled.slice(0, countSettledToday(settled, input.nowMs)),
    settledCount: settled.length,
    shelves: DOCKED_SHELVES.flatMap(([section, label]) => {
      const count = sections.get(section)?.length ?? 0;
      return count === 0 ? [] : [{ label, count }];
    }),
  };
}
