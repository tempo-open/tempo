/**
 * tempo: the pages a thread shared (tempoThreadPages.ts), read from its agent's replies with the page
 * links every client reads (`@t3tools/shared/tempoPageLinks`).
 */
import { pageLinksOf } from "@t3tools/shared/tempoPageLinks";

export interface AgentReply {
  readonly text: string;
  readonly createdAt: string;
}

export interface ThreadPageLink {
  readonly url: string;
  /** The reply's name for the link, when it gave one. */
  readonly label: string | null;
  readonly sharedAt: string;
}

const GENERIC_LABELS = new Set([
  "here",
  "link",
  "page",
  "this",
  "this link",
  "this page",
  "the page",
]);

/**
 * Newest reply first, and a reply's pages in its own order. A page linked again sits at its last
 * mention, under the last name a reply gave it.
 */
export function threadPageLinks(replies: ReadonlyArray<AgentReply>): ThreadPageLink[] {
  const pages = new Map<string, ThreadPageLink>();
  for (const reply of replies.toReversed()) {
    for (const link of pageLinksOf(reply.text)) {
      const label =
        link.label !== null &&
        link.label !== link.raw &&
        !GENERIC_LABELS.has(link.label.toLowerCase())
          ? link.label
          : null;
      const later = pages.get(link.url);
      if (later === undefined)
        pages.set(link.url, { url: link.url, label, sharedAt: reply.createdAt });
      else if (later.label === null && label !== null) pages.set(link.url, { ...later, label });
    }
  }
  return [...pages.values()];
}
