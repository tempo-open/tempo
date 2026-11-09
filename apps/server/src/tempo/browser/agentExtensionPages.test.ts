import { expect, it } from "@effect/vitest";

import { agentMayUsePage } from "./agentExtensionPages.ts";
import { UBLOCK_ORIGIN_LITE_ID } from "./BrowserExtensions.ts";

const BLOCK_PAGE = `chrome-extension://${UBLOCK_ORIGIN_LITE_ID}/strictblock.html#https://ads.example/click?to=https://shop.example/`;

it("lets agents leave uBlock Origin Lite's block page, and nothing else an extension owns", () => {
  // Ordinary pages are not this rule's business.
  expect(agentMayUsePage("https://example.com/", "evaluate")).toBe(true);

  // The block page: read it, press its buttons, go elsewhere, or close the tab...
  for (const operation of [
    "status",
    "snapshot",
    "waitFor",
    "open",
    "navigate",
    "click",
    "close",
  ] as const) {
    expect(agentMayUsePage(BLOCK_PAGE, operation)).toBe(true);
  }
  // ...but never run script or type there, with uBlock Origin Lite's privileges.
  for (const operation of ["evaluate", "type", "press", "upload", "recordingStart"] as const) {
    expect(agentMayUsePage(BLOCK_PAGE, operation)).toBe(false);
  }

  // uBlock Origin Lite's other pages, and look-alikes, stay out of reach.
  for (const url of [
    `chrome-extension://${UBLOCK_ORIGIN_LITE_ID}/dashboard.html`,
    `chrome-extension://${UBLOCK_ORIGIN_LITE_ID}/strictblock.html.evil`,
    "chrome-extension://abcdefghijklmnopabcdefghijklmnop/strictblock.html#https://ads.example/",
  ]) {
    expect(agentMayUsePage(url, "navigate")).toBe(false);
  }
});
