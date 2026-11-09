import { describe, expect, it } from "vite-plus/test";

import { shouldUseMarkdownFileBrowserPrimaryAction } from "./MarkdownFileLink.logic";

const actions = { canOpenInEditor: true, canOpenInBrowser: true, canOpenInPanel: true };

describe("shouldUseMarkdownFileBrowserPrimaryAction", () => {
  it("opens an HTML file in the browser when that is the default browser", () => {
    const iconPath = "/repo/report.html";
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...actions,
        iconPath,
        opensInDefaultBrowser: true,
      }),
    ).toBe(true);
    expect(shouldUseMarkdownFileBrowserPrimaryAction({ ...actions, iconPath })).toBe(false);
  });

  it("has nothing to open for a file a browser cannot show", () => {
    expect(
      shouldUseMarkdownFileBrowserPrimaryAction({
        ...actions,
        canOpenInBrowser: false,
        iconPath: "/repo/main.ts",
        opensInDefaultBrowser: true,
      }),
    ).toBe(false);
  });
});
