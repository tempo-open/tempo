/**
 * tempo: how a link in a reply names itself in the tempo look, as the logo of what it points at and a
 * short name: owner/repo for a repository, someone for an X account, a page's own title and emoji
 * for a page. A link the reply named keeps its name; only a link written as its address gets a short one.
 */
import type { TempoThreadPage } from "@t3tools/contracts";
import { pageTitleFromUrl, pageUrl } from "@t3tools/shared/tempoPageLinks";

/** Sites by their domain and every subdomain, to the thread logo (`threadLogos/logos/<id>.png`). */
const SITE_LOGOS: Readonly<Record<string, string>> = {
  "anthropic.com": "anthropic",
  "chatgpt.com": "chatgpt",
  "claude.ai": "claude",
  "claude.com": "claude",
  "cloudflare.com": "cloudflare",
  "figma.com": "figma",
  "github.com": "github",
  "google.com": "google",
  "linear.app": "linear",
  "notion.com": "notion",
  "notion.site": "notion",
  "notion.so": "notion",
  "openai.com": "chatgpt",
  "posthog.com": "posthog",
  "postman.com": "postman",
  "railway.app": "railway",
  "railway.com": "railway",
  "slack.com": "slack",
  "stripe.com": "stripe",
  "supabase.co": "supabase",
  "supabase.com": "supabase",
  "vercel.com": "vercel",
};

/** Paths on X that are pages of the site, not accounts. */
const X_PAGES = new Set(["home", "i", "explore", "search", "intent", "hashtag", "settings"]);

/** A short name reads at a glance; a longer address shows only its site, and the tooltip the rest. */
const SHORT_ADDRESS_LENGTH = 40;

export const bareHost = (host: string) => host.toLowerCase().replace(/^www\./u, "");

/** The thread logo of the site a host belongs to, or null for a site with none. */
export function siteLogo(host: string): string | null {
  const labels = bareHost(host).split(".");
  for (let start = 0; start < labels.length - 1; start++) {
    const logo = SITE_LOGOS[labels.slice(start).join(".")];
    if (logo !== undefined) return logo;
  }
  return null;
}

const withoutScheme = (address: string) =>
  address.replace(/^https?:\/\//iu, "").replace(/\/+$/u, "");

function decoded(address: string): string {
  try {
    return decodeURI(address);
  } catch {
    return address;
  }
}

/** Whether a link's text is its own address, as an autolink or `[url](url)` writes it. */
export function isWrittenAsAddress(text: string, href: string): boolean {
  return decoded(withoutScheme(text.trim())) === decoded(withoutScheme(href));
}

function gitHubName(segments: readonly string[]): string | null {
  const [owner, repo, kind, id] = segments;
  if (owner === undefined) return null;
  if (repo === undefined) return owner;
  const repository = `${owner}/${repo}`;
  if ((kind === "pull" || kind === "issues") && id !== undefined && /^\d+$/u.test(id))
    return `${repository}#${id}`;
  if (kind === "commit" && id !== undefined) return `${repository}@${id.slice(0, 7)}`;
  return repository;
}

/**
 * The short name of a link written as its address: a page's name from its address, owner/repo
 * (with #number or @commit) on GitHub, the account on X, else the site and its path, or only the
 * site when that runs long. Null for an address that is not a web page.
 */
export function shortLinkName(href: string): string | null {
  const url = URL.parse(href);
  if (url === null || (url.protocol !== "https:" && url.protocol !== "http:")) return null;
  const page = pageUrl(href);
  if (page !== null) return pageTitleFromUrl(page);
  const host = bareHost(url.host);
  const segments = url.pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(decoded);
  if (host === "github.com") return gitHubName(segments) ?? host;
  if ((host === "x.com" || host === "twitter.com") && segments[0] && !X_PAGES.has(segments[0]))
    return segments[0];
  const address = [host, ...segments].join("/");
  return address.length <= SHORT_ADDRESS_LENGTH ? address : host;
}

/** Whether a link points at a page an agent made, which shows a page's mark rather than a logo. */
export const isPageLink = (href: string): boolean => pageUrl(href) !== null;

/** A page's mark: its own emoji, else the Mac's globe, both drawn as Apple Color Emoji text. */
export const pageEmoji = (page: TempoThreadPage | undefined): string => page?.emoji ?? "🌐";
