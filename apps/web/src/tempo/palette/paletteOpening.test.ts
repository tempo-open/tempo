import { describe, expect, it } from "vite-plus/test";

import type { CommandPaletteActionItem } from "../../components/CommandPalette.logic";
import { tempoOpeningGroups } from "./paletteOpening";

const action = (value: string, description?: string): CommandPaletteActionItem => ({
  kind: "action",
  value,
  searchTerms: [],
  title: value,
  icon: null,
  ...(description === undefined ? {} : { description }),
  run: async () => {},
});

describe("tempoOpeningGroups", () => {
  it("keeps the mockup's actions on one line each, then the recent threads as Threads", () => {
    const groups = tempoOpeningGroups([
      {
        value: "actions",
        label: "Actions",
        items: [
          action("action:new-thread"),
          action("action:triage", "An agent investigates a problem"),
          action("action:copy-thread-reference", "https://github.com/acme/app/pull/9"),
          action("action:settings"),
        ],
      },
      { value: "recent-threads", label: "Recent Threads", items: [action("thread:a")] },
    ]);

    expect(groups.map((group) => group.label)).toEqual(["Actions", "Threads"]);
    expect(groups[0]?.items.map((item) => [item.value, item.description])).toEqual([
      ["action:new-thread", undefined],
      ["action:copy-thread-reference", undefined],
    ]);
    expect(groups[1]?.items.map((item) => item.value)).toEqual(["thread:a"]);
  });

  it("leaves out the Actions label when none of those actions applies", () => {
    const groups = tempoOpeningGroups([
      { value: "actions", label: "Actions", items: [action("action:settings")] },
      { value: "recent-threads", label: "Recent Threads", items: [action("thread:a")] },
    ]);

    expect(groups.map((group) => group.value)).toEqual(["recent-threads"]);
  });
});
