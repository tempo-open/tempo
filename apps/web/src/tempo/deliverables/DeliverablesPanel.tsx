/**
 * tempo: the side panel's Deliverables tab, the pages a thread's agent shared and its pull requests.
 * A page opens in a tab of this panel, or with ⌘ in the default browser; a pull request opens the
 * way every pull request link does. The mockup's exact type and radii are in look/panel.css.
 */
import { formatDiffCount } from "@t3tools/client-runtime/diff-count";
import type { TempoThreadPage, ScopedThreadRef, ThreadPullRequestLink } from "@t3tools/contracts";
import { useState, type ReactNode } from "react";

import { PULL_REQUEST_STATE_PRESENTATION } from "../../components/pullRequest/pullRequestIcons";
import { useClientSettings } from "../../hooks/useSettings";
import { useOpenPrLink } from "../../lib/openPullRequestLink";
import { cn } from "../../lib/utils";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { useTempoLook } from "../look/useTempoLook";
import { pageEmoji } from "../replies/replyLinks.logic";
import { useOpenThreadPage, useThreadDeliverables } from "./threadDeliverables";

const ITEM_CLASS =
  "flex items-center gap-3 rounded-lg p-2 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";
const TILE_CLASS = "h-14 w-22 shrink-0 overflow-hidden rounded-md";
const TITLE_CLASS = "line-clamp-2 font-medium text-foreground text-sm leading-4.5";
const DETAIL_CLASS = "mt-0.5 flex items-center gap-2 text-secondary-label text-xs";
const EMPTY_CLASS = "flex flex-1 items-center justify-center p-6 text-secondary-label text-sm";

function Section(props: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5" aria-label={props.title}>
      <h3
        className="mx-2 mt-1.5 flex justify-between font-medium text-secondary-label text-xs"
        data-deliverables-heading
      >
        <span>{props.title}</span>
        <span className="tabular-nums">{props.count}</span>
      </h3>
      {props.children}
    </section>
  );
}

/**
 * A page whose picture is missing or private shows its emoji in the tempo look, and a small sheet
 * headed by its title in the classic look.
 */
function PagePicture({ page }: { page: TempoThreadPage }) {
  const look = useTempoLook();
  const [failed, setFailed] = useState<string | null>(null);
  if (page.picture !== null && failed !== page.picture) {
    return (
      <img
        alt=""
        src={page.picture}
        loading="lazy"
        decoding="async"
        onError={() => setFailed(page.picture)}
        className={cn(TILE_CLASS, "object-cover object-top")}
        data-deliverable-tile
      />
    );
  }
  if (look === "tempo") {
    return (
      <div
        aria-hidden
        className={cn(TILE_CLASS, "flex items-center justify-center bg-card")}
        data-deliverable-tile
        data-deliverable-emoji
      >
        {pageEmoji(page)}
      </div>
    );
  }
  return (
    <div aria-hidden className={cn(TILE_CLASS, "bg-card px-2 py-1.5")} data-deliverable-tile>
      <p className="line-clamp-3 font-semibold text-4xs text-muted-foreground leading-2.5">
        {page.title}
      </p>
    </div>
  );
}

function PageItem(props: { page: TempoThreadPage; threadRef: ScopedThreadRef }) {
  const { page, threadRef } = props;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const openPage = useOpenThreadPage(threadRef, "panel");
  const sharedAt = formatDayAwareTimestamp(page.sharedAt, timestampFormat);
  return (
    <a
      href={page.url}
      onClick={(event) => openPage(event, page.url)}
      className={ITEM_CLASS}
      data-deliverable-page
    >
      <PagePicture page={page} />
      <div className="min-w-0">
        <div className={TITLE_CLASS} data-deliverable-title>
          {page.title}
        </div>
        <div className={DETAIL_CLASS} data-deliverable-detail>
          {sharedAt.charAt(0).toUpperCase() + sharedAt.slice(1)}
        </div>
      </div>
    </a>
  );
}

function PullRequestItem(props: { link: ThreadPullRequestLink; threadRef: ScopedThreadRef }) {
  const { link, threadRef } = props;
  const openPrLink = useOpenPrLink(threadRef);
  const snapshot = link.snapshot;
  const state = snapshot?.state === "open" && snapshot.isDraft ? "draft" : snapshot?.state;
  return (
    <a
      href={link.url}
      onClick={(event) => openPrLink(event, link.url, threadRef)}
      className={ITEM_CLASS}
      data-deliverable-pull-request
    >
      <div
        className={cn(
          TILE_CLASS,
          "flex items-center justify-center bg-muted font-semibold text-foreground text-sm tabular-nums",
        )}
        data-deliverable-tile
        data-deliverable-number
      >
        #{link.number}
      </div>
      <div className="min-w-0">
        <div className={TITLE_CLASS} data-deliverable-title>
          {snapshot?.title ?? link.repository}
        </div>
        {snapshot === null || state === undefined ? null : (
          <div className={DETAIL_CLASS} data-deliverable-detail>
            <span className="font-semibold text-muted-foreground" data-deliverable-state>
              {PULL_REQUEST_STATE_PRESENTATION[state].label}
            </span>
            {snapshot.additions === undefined || snapshot.deletions === undefined ? null : (
              <span className="flex gap-2 font-medium tabular-nums">
                <span className="text-success">+{formatDiffCount(snapshot.additions)}</span>
                <span className="text-error">−{formatDiffCount(snapshot.deletions)}</span>
              </span>
            )}
          </div>
        )}
      </div>
    </a>
  );
}

/** Nothing shows until the pages are read, so the pull requests never move and no copy flashes. */
export function DeliverablesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { pages, pagesStatus, pullRequests } = useThreadDeliverables(threadRef);
  if (pagesStatus === "loading") return null;
  const pagesFailed = pagesStatus === "failed";
  if (pages.length === 0 && pullRequests.length === 0) {
    return (
      <div className={EMPTY_CLASS}>
        {pagesFailed ? "Could not read this thread's pages" : "No pages or pull requests yet"}
      </div>
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto p-3.5">
      {pagesFailed ? (
        <p className="mx-2 mt-1.5 text-secondary-label text-xs">
          Could not read this thread's pages
        </p>
      ) : null}
      {pages.length === 0 ? null : (
        <Section title="Pages" count={pages.length}>
          {pages.map((page) => (
            <PageItem key={page.url} page={page} threadRef={threadRef} />
          ))}
        </Section>
      )}
      {pullRequests.length === 0 ? null : (
        <Section title="Pull requests" count={pullRequests.length}>
          {pullRequests.map((link) => (
            <PullRequestItem
              key={`${link.host}/${link.repository}#${link.number}`}
              link={link}
              threadRef={threadRef}
            />
          ))}
        </Section>
      )}
    </div>
  );
}
