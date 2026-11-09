import { describe, expect, it } from "vite-plus/test";

import { pageAddress } from "./pageAddress";

describe("pageAddress", () => {
  it.each([
    [
      "http://127.0.0.1:5173/c/design-board",
      { secure: false, host: "127.0.0.1:5173", rest: "/c/design-board" },
    ],
    ["https://github.com/", { secure: true, host: "github.com", rest: "" }],
    [
      "https://example.com/?q=tempo#top",
      { secure: true, host: "example.com", rest: "/?q=tempo#top" },
    ],
    ["about:blank", null],
    ["file:///Users/me/page.html", null],
    ["", null],
  ])("draws %s", (url, expected) => {
    expect(pageAddress(url)).toEqual(expected);
  });
});
