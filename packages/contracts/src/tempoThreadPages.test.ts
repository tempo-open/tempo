import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { TempoThreadPages } from "./tempoThreadPages.ts";

const decodePages = Schema.decodeUnknownSync(TempoThreadPages);

const guide = {
  url: "https://example.pages.dev/p/install-guide-q8n4vz2hj6wd",
  title: "Guide: install steps",
  picture: null,
  sharedAt: "2025-01-15T10:00:00.000Z",
};

describe("TempoThreadPages", () => {
  it("reads a page from a server that does not read its about line or emoji", () => {
    expect(decodePages({ pages: [guide] }).pages[0]).toEqual({
      ...guide,
      about: null,
      emoji: null,
    });
  });

  it("reads a page's about line and emoji", () => {
    const page = { ...guide, about: "Three steps to install the app", emoji: "📘" };
    expect(decodePages({ pages: [page] }).pages[0]).toEqual(page);
  });
});
