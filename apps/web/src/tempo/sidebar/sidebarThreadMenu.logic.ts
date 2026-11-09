import type { ContextMenuItem } from "@t3tools/contracts";

import type { ThreadActionMenuId } from "../../components/threadActionMenu.logic";

/**
 * tempo: what a thread's sidebar menu leaves out. The chat header's thread menu
 * keeps all of it, so the per-thread auto-settle switch stays reachable.
 */
const LEFT_OUT = new Set<ThreadActionMenuId>([
  "new-thread-on-branch",
  "regenerate-title",
  "filter-by-project",
  "auto-settle",
  "copy",
  "project-settings",
  "archive",
]);

/** A thread's sidebar menu: its everyday actions. A left-out item's separator moves to the next item kept. */
export function sidebarThreadMenuItems(
  items: ReadonlyArray<ContextMenuItem<ThreadActionMenuId>>,
): ReadonlyArray<ContextMenuItem<ThreadActionMenuId>> {
  const kept: Array<ContextMenuItem<ThreadActionMenuId>> = [];
  let separatorBefore = false;
  for (const item of items) {
    if (LEFT_OUT.has(item.id)) {
      separatorBefore ||= item.separatorBefore === true;
      continue;
    }
    kept.push(separatorBefore && kept.length > 0 ? { ...item, separatorBefore: true } : item);
    separatorBefore = false;
  }
  return kept;
}
