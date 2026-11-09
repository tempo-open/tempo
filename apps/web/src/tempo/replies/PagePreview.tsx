/**
 * tempo: a page the way Messages draws a link, in the tempo look: its picture, then its title and the
 * line about it, else its site. A page with no picture is a short card led by its emoji. The sizes
 * between the type and spacing scales are in look/thread.css.
 */
import type { TempoThreadPage, ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useOpenThreadPage } from "../deliverables/threadDeliverables";
import { bareHost, pageEmoji } from "./replyLinks.logic";

const CARD_CLASS =
  "flex min-w-0 flex-col overflow-hidden rounded-tempo-card bg-card text-start ring-1 ring-border hover:ring-tempo-hair-2 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring";

/** The card in place of a paragraph that held only the page's link, drawn by that link itself. */
export const ALONE_PAGE_PREVIEW_CLASS = cn(CARD_CLASS, "mt-2.5 mb-4.5 w-98 max-w-full");

/**
 * What a page's card shows. `alone` draws in place of a paragraph that held only the page's link;
 * in a `row` of cards the title keeps to one line so the cards end together.
 */
export function PagePreviewContent(props: { page: TempoThreadPage; placement: "alone" | "row" }) {
  const { page, placement } = props;
  const [failedPicture, setFailedPicture] = useState<string | null>(null);
  const picture = page.picture !== null && page.picture !== failedPicture ? page.picture : null;
  const caption = (
    <span className={cn("flex min-w-0 flex-col", picture !== null && "px-3 pt-2.25 pb-2.5")}>
      <span
        className={cn(
          "font-semibold text-foreground text-tempo-label leading-4.5",
          placement === "row" ? "line-clamp-1" : "line-clamp-2",
        )}
        data-page-preview-title
      >
        {page.title}
      </span>
      <span className="mt-0.5 truncate text-secondary-label text-tempo-caption leading-4.25">
        {page.about ?? bareHost(new URL(page.url).host)}
      </span>
    </span>
  );
  if (picture === null) {
    return (
      <span className="flex flex-1 items-center gap-2.75 px-3 py-2.75">
        <span aria-hidden data-thread-find-ignore data-page-preview-emoji>
          {pageEmoji(page)}
        </span>
        {caption}
      </span>
    );
  }
  return (
    <>
      <img
        alt=""
        src={picture}
        loading="lazy"
        decoding="async"
        onError={() => setFailedPicture(picture)}
        className="w-full border-border border-b object-cover"
        data-page-preview-picture
      />
      {caption}
    </>
  );
}

/** A page's card in the row under its reply, opening where a link in the reply opens. */
export function PagePreview(props: { page: TempoThreadPage; threadRef: ScopedThreadRef }) {
  const { page, threadRef } = props;
  const openPage = useOpenThreadPage(threadRef, "chat");
  return (
    <a
      href={page.url}
      onClick={(event) => openPage(event, page.url)}
      className={CARD_CLASS}
      data-page-preview="row"
    >
      <PagePreviewContent page={page} placement="row" />
    </a>
  );
}
