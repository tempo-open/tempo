import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { readPageHead, readPageMeta } from "./pageMeta.ts";
import { threadPageLinks } from "./threadPageLinks.ts";

describe("threadPageLinks", () => {
  it("keeps links to page hosts, newest first, and leaves links inside code out", () => {
    const links = threadPageLinks([
      {
        createdAt: "2026-01-02T10:00:00.000Z",
        text: [
          "Here is the page: https://acme-docs.pages.dev/p/sample-page",
          "The PR is https://github.com/acme/app/pull/1 and the post https://x.com/fal/status/1.",
          "Run `curl https://acme-tools.pages.dev/mcp` to check.",
          "```",
          "open http://127.0.0.1:4173/hidden.html",
          "```",
        ].join("\n"),
      },
      {
        createdAt: "2026-01-02T11:00:00.000Z",
        text: "The review is at https://acme-review.vercel.app. The demo: http://127.0.0.1:4173/demo.html",
      },
    ]);
    expect(links).toEqual([
      {
        url: "https://acme-review.vercel.app/",
        label: null,
        sharedAt: "2026-01-02T11:00:00.000Z",
      },
      {
        url: "http://127.0.0.1:4173/demo.html",
        label: null,
        sharedAt: "2026-01-02T11:00:00.000Z",
      },
      {
        url: "https://acme-docs.pages.dev/p/sample-page",
        label: null,
        sharedAt: "2026-01-02T10:00:00.000Z",
      },
    ]);
  });

  it("lists a page once, at its last mention, under the last name a reply gave it", () => {
    const links = threadPageLinks([
      {
        createdAt: "2026-01-03T10:00:00.000Z",
        text: "- [Option A](https://acme.github.io/plans/option-a/)\n- [Option B](https://acme.github.io/plans/option-b/)",
      },
      {
        createdAt: "2026-01-03T11:00:00.000Z",
        text: "All three updated, for example [this page](https://acme.github.io/plans/option-a/#top).",
      },
    ]);
    expect(links.map(({ url, label, sharedAt }) => [url, label, sharedAt])).toEqual([
      ["https://acme.github.io/plans/option-a", "Option A", "2026-01-03T11:00:00.000Z"],
      ["https://acme.github.io/plans/option-b", "Option B", "2026-01-03T10:00:00.000Z"],
    ]);
  });
});

/** An icon link as the page host writes one: the SVG URL encoded, then the href HTML escaped. */
const emojiIconLink = (svg: string) =>
  `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg).replaceAll("'", "&#39;")}" type="image/svg+xml">`;
const emojiSvg = (text: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text x="50" y="50" font-size="86">${text}</text></svg>`;
const iconEmoji = (head: string) => readPageMeta(head, "https://a.pages.dev/").emoji;

describe("readPageMeta", () => {
  it("prefers the page's sharing title and resolves its picture against the page", () => {
    expect(
      readPageMeta(
        `<head><title>Weekly review</title>
          <meta property="og:title" content="Review: two PRs &amp; one plan">
          <meta property="og:description" content="Two PRs, one plan &amp; one choice">
          <meta content="/preview.png" property="og:image">
          ${emojiIconLink(emojiSvg("👆"))}</head>`,
        "https://acme-review.vercel.app/",
      ),
    ).toEqual({
      title: "Review: two PRs & one plan",
      about: "Two PRs, one plan & one choice",
      picture: "https://acme-review.vercel.app/preview.png",
      emoji: "👆",
    });
  });

  it("falls back to the title element and the card's description, and gives no picture without one", () => {
    expect(
      readPageMeta(
        `<title>\n  Variant  options\n</title>
          <meta name="twitter:description" content="Three variants">
          <link rel="icon" href="/favicon.svg" type="image/svg+xml">`,
        "https://a.pages.dev/",
      ),
    ).toEqual({ title: "Variant options", about: "Three variants", picture: null, emoji: null });
  });

  it("reads the emoji of an icon whose only text is one emoji, in any data URI encoding", () => {
    expect(iconEmoji(emojiIconLink(emojiSvg("🗺\uFE0F")))).toBe("🗺\uFE0F");
    expect(
      iconEmoji(
        `<link rel="shortcut icon" href="data:image/svg+xml;charset=utf-8;base64,${Buffer.from(emojiSvg(" 🇺🇸 ")).toString("base64")}">`,
      ),
    ).toBe("🇺🇸");
    expect(
      iconEmoji(
        `<link rel=icon href='data:image/svg+xml,<svg width="100%"><!-- a page --><text>&#x1F6D2;</text></svg>'>`,
      ),
    ).toBe("🛒");
  });

  it("gives no emoji for an icon that draws anything besides one emoji", () => {
    for (const head of [
      emojiIconLink(emojiSvg("👆 Taps")),
      emojiIconLink(emojiSvg("👆🏆")),
      emojiIconLink(emojiSvg("T")),
      `<link rel="apple-touch-icon" href="data:image/svg+xml,${encodeURIComponent(emojiSvg("👆"))}">`,
      `<link rel="icon" href="data:image/png;base64,iVBORw0KGgo=">`,
      `<link rel="icon" href="data:image/svg+xml;base64,not base64!">`,
    ]) {
      expect(iconEmoji(head), head).toBeNull();
    }
  });
});

describe("readPageHead", () => {
  const bytes = (text: string) => new TextEncoder().encode(text);

  it.effect("stops reading a page at the end of its head", () =>
    Effect.gen(function* () {
      const page = Stream.make(bytes("<head><title>A</title>"), bytes("</head><body>")).pipe(
        Stream.concat(Stream.fail("read past the head")),
      );
      expect(yield* readPageHead(page)).toBe("<head><title>A</title></head><body>");
    }),
  );

  it.effect("reads at most 256 KB of a page whose head does not end", () =>
    Effect.gen(function* () {
      const page = Stream.forever(Stream.make(bytes("x".repeat(1024))));
      expect(yield* readPageHead(page)).toHaveLength(256 * 1024);
    }),
  );
});
