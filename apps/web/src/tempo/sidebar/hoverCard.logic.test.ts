import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { describe, expect, it } from "vite-plus/test";

import { hoverCardModelLabel } from "./hoverCard.logic";

const claude = {
  driverKind: ProviderDriverKind.make("claudeAgent"),
  models: [
    {
      slug: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      aliases: ["haiku-4.5", "claude-haiku-4-5-20251001"],
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "effort",
            label: "Effort",
            type: "select",
            options: [
              { id: "high", label: "High", isDefault: true },
              { id: "max", label: "Max" },
            ],
          },
        ],
      },
    },
  ] satisfies ServerProviderModel[],
};
const instanceId = ProviderInstanceId.make("claudeAgent");

describe("hoverCardModelLabel", () => {
  it("names a model the provider reports by its dated id", () => {
    expect(
      hoverCardModelLabel(claude, createModelSelection(instanceId, "claude-haiku-4-5-20251001")),
    ).toBe("Haiku 4.5");
  });

  it("follows the name with the chosen effort, as the composer does", () => {
    expect(
      hoverCardModelLabel(
        claude,
        createModelSelection(instanceId, "claude-haiku-4-5", [{ id: "effort", value: "max" }]),
      ),
    ).toBe("Haiku 4.5 Max");
  });

  it("words a model outside the catalog from its id", () => {
    expect(hoverCardModelLabel(claude, createModelSelection(instanceId, "claude-opus-4-6"))).toBe(
      "Claude Opus 4.6",
    );
  });
});
