import type { ServerProviderModel } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { withDefaultReasoningEffort } from "./defaultReasoningEffort.ts";

const claudeModel = (optionIds: ReadonlyArray<string>): ServerProviderModel => ({
  slug: "claude-opus-5-5",
  name: "Claude Opus 5.5",
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "effort",
        label: "Reasoning",
        type: "select",
        options: optionIds.map((id) =>
          id === "medium" ? { id, label: id, isDefault: true } : { id, label: id },
        ),
      },
      { id: "fastMode", label: "Fast Mode", type: "boolean" },
    ],
  },
});

const defaultEffort = (model: ServerProviderModel) => {
  const effort = model.capabilities?.optionDescriptors?.find((d) => d.id === "effort");
  return effort?.type === "select"
    ? effort.options.filter((option) => option.isDefault).map((option) => option.id)
    : [];
};

describe("withDefaultReasoningEffort", () => {
  it("makes High the only default where a model offers it", () => {
    const model = withDefaultReasoningEffort(claudeModel(["low", "medium", "high", "max"]));

    expect(defaultEffort(model)).toEqual(["high"]);
    expect(model.capabilities?.optionDescriptors?.[1]).toEqual({
      id: "fastMode",
      label: "Fast Mode",
      type: "boolean",
    });
  });

  it("keeps a model's own default when it has no High", () => {
    const model = claudeModel(["low", "medium"]);

    expect(withDefaultReasoningEffort(model)).toBe(model);
  });
});
