import { describe, expect, it } from "vite-plus/test";

import { freeDownloadPath } from "./downloadsFolder.ts";

const taken =
  (...names: string[]) =>
  (path: string) =>
    names.some((name) => path === `/Downloads/${name}`);

describe("freeDownloadPath", () => {
  it("keeps the name while Downloads has no file by it", () => {
    expect(freeDownloadPath("/Downloads", "plugin.zip", taken())).toBe("/Downloads/plugin.zip");
  });

  it("numbers the copy instead of replacing a file", () => {
    expect(
      freeDownloadPath("/Downloads", "plugin.zip", taken("plugin.zip", "plugin (1).zip")),
    ).toBe("/Downloads/plugin (2).zip");
    expect(freeDownloadPath("/Downloads", "README", taken("README"))).toBe("/Downloads/README (1)");
  });

  it("gives up after 100 copies, leaving the choice to the save dialog", () => {
    expect(freeDownloadPath("/Downloads", "plugin.zip", () => true)).toBeNull();
  });
});
