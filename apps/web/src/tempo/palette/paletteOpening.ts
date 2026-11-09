import type { CommandPaletteGroup } from "../../components/CommandPalette.logic";

// The actions the mockup's empty palette lists, when they apply; ">" and typing reach every other.
const OPENING_ACTIONS: ReadonlySet<string> = new Set([
  "action:new-thread",
  "action:new-thread-in",
  "action:new-thread-without-project",
  "action:toggle-ultracode",
  "find-current-thread",
  "action:copy-thread-reference",
]);

/**
 * The palette before anything is typed, in the tempo look: those actions on one line each, then the
 * recent threads under "Threads", so the threads show without scrolling.
 */
export function tempoOpeningGroups(
  rootGroups: ReadonlyArray<CommandPaletteGroup>,
): CommandPaletteGroup[] {
  return rootGroups.flatMap((group) => {
    if (group.value === "recent-threads") return [{ ...group, label: "Threads" }];
    if (group.value !== "actions") return [group];
    const items = group.items.flatMap((item) => {
      if (!OPENING_ACTIONS.has(item.value)) return [];
      const { description: _description, ...rest } = item;
      return [rest];
    });
    return items.length > 0 ? [{ ...group, items }] : [];
  });
}
