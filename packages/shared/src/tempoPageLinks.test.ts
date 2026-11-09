import { describe, expect, it } from "vite-plus/test";

import { isWorkUrl, pageLinksOf, pageTitleFromUrl } from "./tempoPageLinks.ts";

describe("pageLinksOf", () => {
  it("reads named links before bare ones and leaves links inside code out", () => {
    const text = [
      "The review is at https://docs-preview-7h4kq2xz.pages.dev. See [the board](http://127.0.0.1:5173/board.html#top).",
      "Run `curl https://api.example.pages.dev/mcp` or `[x](https://example.vercel.app/)`.",
      "```md",
      "[the page](https://example.pages.dev/p/hidden)",
      "```",
    ].join("\n");
    expect(pageLinksOf(text)).toEqual([
      {
        url: "http://127.0.0.1:5173/board.html",
        raw: "http://127.0.0.1:5173/board.html#top",
        label: "the board",
      },
      {
        url: "https://docs-preview-7h4kq2xz.pages.dev/",
        raw: "https://docs-preview-7h4kq2xz.pages.dev.",
        label: null,
      },
    ]);
  });

  it.each([
    ["https://example.vercel.app/**", "https://example.vercel.app/"],
    [
      "https://claude.ai/artifact/Zr8pLm2vQx7nBk4tWc9yHd).",
      "https://claude.ai/artifact/Zr8pLm2vQx7nBk4tWc9yHd",
    ],
    ["http://localhost:5173/report.html", "http://localhost:5173/report.html"],
  ])("reads %s as %s", (text, url) => {
    expect(pageLinksOf(text)[0]?.url).toBe(url);
  });

  it.each([
    "https://claude.ai/settings/usage",
    "http://localhost:56170/callback?code=1",
    "http://127.0.0.1:5173/c/board",
    "https://github.com/acme/app/pull/4",
  ])("is not a page: %s", (text) => {
    expect(pageLinksOf(text)).toEqual([]);
  });
});

describe("isWorkUrl", () => {
  it.each([
    "https://example.pages.dev/p/release-notes-k3v9q2m8x7tb",
    "https://claude.ai/artifact/Zr8pLm2vQx7nBk4tWc9yHd",
    "http://localhost:5173/",
    "http://[::1]:3000/settings",
    "http://127.0.0.2:3000/",
    "http://0.0.0.0:8000/",
    "http://app.localhost:8080/checkout",
    "http://127.0.0.1:3773/assets/token/report.html",
  ])("is work: %s", (url) => {
    expect(isWorkUrl(url)).toBe(true);
  });

  it.each([
    "https://github.com/acme/app/pull/4",
    "https://claude.ai/settings/usage",
    "https://localhost.example.com/",
    "file:///Users/me/report.html",
    "not a url",
  ])("is not work: %s", (url) => {
    expect(isWorkUrl(url)).toBe(false);
  });
});

describe("pageTitleFromUrl", () => {
  it.each([
    ["https://example.pages.dev/p/release-notes-k3v9q2m8x7tb", "Release notes"],
    ["https://example.pages.dev/p/changelog-2025-03-14", "Changelog"],
    ["https://docs-preview-7h4kq2xz.pages.dev/", "Docs preview"],
    ["http://localhost:5173/build-history.html", "Build history"],
    ["https://demo.pages.dev/b7", "B7"],
  ])("%s is %s", (url, title) => {
    expect(pageTitleFromUrl(url)).toBe(title);
  });
});
