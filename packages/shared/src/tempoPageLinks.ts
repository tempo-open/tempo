/**
 * tempo: the pages an agent shares in its replies. A page is a link to a site that hosts the pages
 * agents make (Cloudflare Pages, Vercel, Netlify, GitHub Pages, a Claude artifact) or a local HTML
 * file. The server lists a thread's pages from them (tempoThreadPages.ts) and a reply draws the
 * same ones as cards, so both read links here. Links inside code are commands, not shares.
 */

import { isLocalLoopbackHost } from "./hostClassification.ts";

export interface PageLink {
  /** The page's address: no fragment, and no slash at the end of a path. */
  readonly url: string;
  /** The link as the reply wrote it. */
  readonly raw: string;
  /** The reply's name for the link, when it wrote one. */
  readonly label: string | null;
}

const PAGE_HOST_SUFFIXES = [".pages.dev", ".vercel.app", ".netlify.app", ".github.io"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const CODE = /```[\s\S]*?(?:```|$)|`[^`\n]*`/gu;
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gu;
const BARE_URL = /https?:\/\/[^\s<>"'`()[\]*]+/gu;

function isPage(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (PAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host === "claude.ai") return /^\/(?:public\/)?artifacts?\//u.test(url.pathname);
  if (LOOPBACK_HOSTS.has(host)) return url.pathname.endsWith(".html");
  return false;
}

/** A page, or any address on this Mac: a dev server, a file Tempo serves. */
export function isWorkUrl(raw: string): boolean {
  const url = URL.parse(raw);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return false;
  const host = url.hostname.toLowerCase();
  // 0.0.0.0 is what a server listening on every interface prints, such as python3 -m http.server.
  return (
    isLocalLoopbackHost(host) || host === "0.0.0.0" || host.endsWith(".localhost") || isPage(url)
  );
}

/**
 * One address per page, so two mentions of a page meet: no fragment, and no slash at the end of
 * a path. A site root keeps its "/", as every URL's href does. Null for a link to anything else.
 */
export function pageUrl(raw: string): string | null {
  const url = URL.parse(raw.replace(/[.,;:!?]+$/u, ""));
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:") || !isPage(url)) {
    return null;
  }
  url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.href;
}

/** A reply's text without its code blocks and inline code, whose links are commands, not shares. */
export const withoutCode = (text: string): string => text.replace(CODE, " ");

/** The pages a reply links, in its own order: its named links first, then its bare ones. */
export function pageLinksOf(text: string): PageLink[] {
  const prose = withoutCode(text);
  const named = [...prose.matchAll(MARKDOWN_LINK)].map(([, label, raw]) => ({
    raw: raw!,
    label: label!.trim(),
  }));
  const bare = (prose.replace(MARKDOWN_LINK, " ").match(BARE_URL) ?? []).map((raw) => ({
    raw,
    label: null,
  }));
  return [...named, ...bare].flatMap((link) => {
    const url = pageUrl(link.raw);
    return url === null ? [] : [{ ...link, url }];
  });
}

/**
 * A name for a page that gives none: its last path segment, else its site's own name, with the
 * random or dated tail a publisher appends dropped ("release-notes-k3v9q2m8x7tb" is "Release notes").
 */
export function pageTitleFromUrl(href: string): string {
  const url = new URL(href);
  const segment = url.pathname.split("/").findLast((part) => part.length > 0);
  const host = url.hostname.toLowerCase();
  const name =
    segment === undefined
      ? PAGE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
        ? host.split(".")[0]!
        : host
      : decodeURIComponent(segment).replace(/\.html?$/iu, "");
  const words = name.split(/[-_\s]+/u).filter((word) => word.length > 0);
  while (words.length > 1 && /\d/u.test(words.at(-1)!)) words.pop();
  const title = words.join(" ");
  return title.charAt(0).toUpperCase() + title.slice(1);
}
