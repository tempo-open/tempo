import { describe, expect, it } from "vite-plus/test";

import { THREAD_LOGOS } from "../threadLogos/threadLogo.logic";
import { isWrittenAsAddress, shortLinkName, siteLogo } from "./replyLinks.logic";

describe("shortLinkName", () => {
  it.each([
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme", "acme"],
    ["https://github.com/acme/app/pull/8", "acme/app#8"],
    ["https://github.com/acme/app/issues/12#issuecomment-1", "acme/app#12"],
    [
      "https://github.com/acme/app/commit/0cc110dd7372cd9b6c07bce95a7940a84a0e1512",
      "acme/app@0cc110d",
    ],
    ["https://github.com/acme/app/blob/main/AGENTS.md", "acme/app"],
    ["https://x.com/someone", "someone"],
    ["https://twitter.com/someone_else/status/1855", "someone_else"],
    ["https://x.com/i/bookmarks", "x.com/i/bookmarks"],
    ["https://example.pages.dev/p/release-notes-k3v9q2m8x7tb", "Release notes"],
    ["http://127.0.0.1:5173/design-board.html", "Design board"],
    ["https://www.npmjs.com/package/react-markdown", "npmjs.com/package/react-markdown"],
    ["https://example.com/", "example.com"],
    [
      "https://developer.apple.com/documentation/webkit/wkwebview?language=objc",
      "developer.apple.com",
    ],
    ["http://localhost:5173/settings/appearance", "localhost:5173/settings/appearance"],
    ["mailto:person@example.com", null],
  ])("names %s %s", (href, name) => {
    expect(shortLinkName(href)).toBe(name);
  });
});

describe("isWrittenAsAddress", () => {
  it.each([
    ["https://github.com/acme/app", "https://github.com/acme/app", true],
    ["github.com/acme/app", "https://github.com/acme/app", true],
    ["https://example.com", "https://example.com/", true],
    ["https://example.com/a b", "https://example.com/a%20b", true],
    ["acme/app", "https://github.com/acme/app", false],
    ["Row 90", "https://docs.example.net/#doc-90", false],
  ])("%s for %s is %s", (text, href, written) => {
    expect(isWrittenAsAddress(text, href)).toBe(written);
  });
});

describe("siteLogo", () => {
  it.each([
    ["github.com", "github"],
    ["gist.github.com", "github"],
    ["mail.google.com", "google"],
    ["docs.google.com", "google"],
    ["dash.cloudflare.com", "cloudflare"],
    ["docs.example.net", null],
    ["example.com", null],
  ])("%s shows %s", (host, logo) => {
    expect(siteLogo(host)).toBe(logo);
  });

  it("names only logos the app has a file for", () => {
    const hosts = ["anthropic.com", "chatgpt.com", "claude.ai", "linear.app", "supabase.co"];
    for (const host of hosts) expect(THREAD_LOGOS.has(siteLogo(host)!)).toBe(true);
  });
});
