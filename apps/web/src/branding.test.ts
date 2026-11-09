import { describe, expect, it } from "vite-plus/test";
import { formatAppDisplayName } from "./branding.logic";

describe("branding logic", () => {
  it("shows the stable channel under the bare name and labels the others", () => {
    expect(formatAppDisplayName({ baseName: "Tempo", stageLabel: "Beta" })).toBe("Tempo");
    expect(formatAppDisplayName({ baseName: "Tempo", stageLabel: "Alpha" })).toBe("Tempo");
    expect(formatAppDisplayName({ baseName: "Tempo", stageLabel: "Latest" })).toBe("Tempo");
    expect(formatAppDisplayName({ baseName: "Tempo", stageLabel: "Dev" })).toBe("Tempo (Dev)");
    expect(formatAppDisplayName({ baseName: "Tempo", stageLabel: "Nightly" })).toBe(
      "Tempo (Nightly)",
    );
  });
});
