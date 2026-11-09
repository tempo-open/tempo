import type { ScopedThreadRef } from "@t3tools/contracts";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadPages } from "../deliverables/threadDeliverables";
import {
  pageLinksAlone,
  replyPages,
  replyPageUrls,
  type ReplyPages,
} from "./replyDeliverables.logic";

const NO_REPLY_PAGES: ReplyPages = { byUrl: new Map(), alone: new Map() };

/**
 * tempo: the thread's pages a finished reply in the tempo look links, for its page marks, names and
 * previews. Null without a thread, while the reply streams, and until the thread's pages are read.
 * The server lists a reply's pages once it has finished, and reads them again only when the run
 * ends, so the pages are first asked for after the reply finishes.
 */
export function useReplyPages(
  threadRef: ScopedThreadRef | null,
  text: string,
  streaming: boolean,
): ReplyPages | null {
  const math = useClientSettings((settings) => settings.mathRenderingEnabled);
  const linksPages = threadRef !== null && !streaming && replyPageUrls(text).length > 0;
  const { pages, pagesStatus } = useThreadPages(linksPages ? threadRef : null);
  if (threadRef === null || streaming) return null;
  if (!linksPages) return NO_REPLY_PAGES;
  return pagesStatus === "loading" ? null : replyPages(pages, pageLinksAlone(text, math));
}
