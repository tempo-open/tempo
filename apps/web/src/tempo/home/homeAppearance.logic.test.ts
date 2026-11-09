import { describe, expect, it } from "vite-plus/test";

import { toggleHomeWidget } from "./homeAppearance.logic";

describe("toggleHomeWidget", () => {
  it("adds a third widget in the fixed order and takes it away again", () => {
    expect(toggleHomeWidget(["limit", "month"], "pullRequests")).toEqual([
      "limit",
      "pullRequests",
      "month",
    ]);
    expect(toggleHomeWidget(["limit", "pullRequests", "month"], "pullRequests")).toEqual([
      "limit",
      "month",
    ]);
  });

  it("refuses a fourth widget and refuses to drop below two", () => {
    expect(toggleHomeWidget(["limit", "activity", "month"], "pullRequests")).toBeNull();
    expect(toggleHomeWidget(["limit", "activity"], "activity")).toBeNull();
  });
});
