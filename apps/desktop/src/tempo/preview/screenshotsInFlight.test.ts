import { describe, expect, it } from "vite-plus/test";

import { makeScreenshotsInFlight } from "./screenshotsInFlight.ts";

describe("screenshots in flight", () => {
  it("keeps a tab capturing until its last screenshot ends, and any tab keeps the window", () => {
    const screenshots = makeScreenshotsInFlight();
    expect(screenshots.any()).toBe(false);

    screenshots.begin("a");
    screenshots.begin("a");
    screenshots.begin("b");
    screenshots.end("a");
    expect([screenshots.has("a"), screenshots.has("b"), screenshots.any()]).toEqual([
      true,
      true,
      true,
    ]);

    screenshots.end("a");
    expect([screenshots.has("a"), screenshots.any()]).toEqual([false, true]);
    screenshots.end("b");
    expect([screenshots.has("b"), screenshots.any()]).toEqual([false, false]);
  });

  it("ignores an end with nothing in flight", () => {
    const screenshots = makeScreenshotsInFlight();
    screenshots.end("a");
    screenshots.begin("a");
    expect(screenshots.has("a")).toBe(true);
    screenshots.end("a");
    expect(screenshots.any()).toBe(false);
  });
});
