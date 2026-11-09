import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { searchSlashCommandItems } from "../components/chat/composerSlashCommandSearch";
import { savedWorkflowSlashItems, savedWorkflowSlashPrompt } from "./savedWorkflowSlashItems";

const CLAUDE = ProviderDriverKind.make("claudeAgent");

describe("saved workflow slash rows", () => {
  const items = savedWorkflowSlashItems(CLAUDE, [
    {
      name: "review",
      description: "Three critics",
      phases: [],
      scope: "project",
      path: "/p/review.js",
    },
    { name: "triage", phases: [], scope: "user", path: "/u/triage.js" },
  ]);

  it("are found by name in the slash menu", () => {
    expect(searchSlashCommandItems(items, "/rev").map((item) => item.label)).toEqual([
      "/workflow:review",
    ]);
    expect(items.map((item) => item.description)).toEqual([
      "Project workflow · Three critics",
      "Your workflow",
    ]);
  });

  it("insert the prompt that asks Claude to run the workflow, not a command", () => {
    expect(savedWorkflowSlashPrompt(items[0]!)).toBe('Run the "review" workflow. ');
    // A real provider command that happens to share the prefix stays a command.
    expect(
      savedWorkflowSlashPrompt({
        id: "provider-slash-command:claudeAgent:workflow:deploy",
        command: { name: "workflow:deploy" },
      }),
    ).toBeNull();
  });
});
