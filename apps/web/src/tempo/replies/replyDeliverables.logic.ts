/**
 * tempo: what a reply delivered, for its cards in the tempo look: the pages it shared, as the thread's
 * page list has them (tempoThreadPages.ts), then the markdown files it linked, which open in Quick Look.
 * A page whose link stands alone in a paragraph draws in that paragraph's place instead.
 */
import type { TempoThreadPage } from "@t3tools/contracts";
import { pageLinksOf, pageUrl, withoutCode } from "@t3tools/shared/tempoPageLinks";
import {
  extractMarkdownLinks,
  isMarkdownFileLinkLabel,
  normalizeMarkdownLinkDestination,
} from "@t3tools/shared/markdownLinks";
import { CHAT_MARKDOWN_REMARK_PLUGINS } from "@t3tools/shared/markdownPipeline";
import { isHostPath } from "@t3tools/shared/path";
import type { Root, RootContent } from "mdast";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { isMarkdownPreviewFile } from "../../components/files/filePreviewMode";
import { resolveMarkdownFileLinkMeta, rewriteMarkdownFileUriHref } from "../../markdown-links";
import { documentTitleFromPath, splitMarkdownDocument } from "../quickLook/quickLookDocument.logic";

export interface ReplyFile {
  /** Workspace relative, or an absolute host path, as Quick Look takes it. */
  readonly path: string;
  /** The reply's name for the file, as its chip in the prose shows it, else the file's own name. */
  readonly name: string;
}

export type ReplyDeliverable =
  | { readonly kind: "page"; readonly page: TempoThreadPage }
  | { readonly kind: "file"; readonly file: ReplyFile };

/** The markdown files a reply links outside its code, each once, in its own order. */
export function replyMarkdownFiles(text: string, cwd: string | undefined): ReplyFile[] {
  const files = new Map<string, ReplyFile>();
  for (const link of extractMarkdownLinks(withoutCode(text))) {
    const href =
      rewriteMarkdownFileUriHref(link.href) ?? normalizeMarkdownLinkDestination(link.href);
    const meta = resolveMarkdownFileLinkMeta(href, cwd);
    if (meta === null) continue;
    const path = meta.workspaceRelativePath ?? (isHostPath(meta.filePath) ? meta.filePath : null);
    if (path === null || !isMarkdownPreviewFile(path) || files.has(path)) continue;
    const label = link.label.trim();
    const named = label.length > 0 && !isMarkdownFileLinkLabel(label, href);
    files.set(path, { path, name: named ? label : meta.basename });
  }
  return [...files.values()];
}

/** The pages a reply shares, each once. */
export const replyPageUrls = (text: string): string[] => [
  ...new Set(pageLinksOf(text).map((link) => link.url)),
];

/** ChatMarkdown's own parse of a reply, before it becomes HTML, with math as the setting has it. */
const chatMarkdown = {
  plain: unified().use(remarkParse).use(CHAT_MARKDOWN_REMARK_PLUGINS).freeze(),
  math: unified()
    .use(remarkParse)
    .use([[remarkMath, { singleDollarTextMath: true }], ...CHAT_MARKDOWN_REMARK_PLUGINS])
    .freeze(),
};

const showsImage = (node: RootContent): boolean =>
  node.type === "image" ||
  node.type === "imageReference" ||
  ("children" in node && node.children.some(showsImage));

/**
 * The pages a reply links alone in a paragraph of their own, by where ChatMarkdown's paragraph
 * starts in the text. Only a paragraph of the reply itself counts: a link in a list, a quote, a
 * sentence or around an image stays a link.
 */
export function pageLinksAlone(text: string, math: boolean): Map<number, string> {
  const parser = math ? chatMarkdown.math : chatMarkdown.plain;
  const tree = parser.runSync(parser.parse(text)) as Root;
  const alone = new Map<number, string>();
  for (const block of tree.children) {
    if (block.type !== "paragraph" || block.children.length !== 1) continue;
    const [link] = block.children;
    if (link?.type !== "link" || showsImage(link)) continue;
    const url = pageUrl(link.url);
    const start = block.position?.start.offset;
    if (url !== null && start !== undefined) alone.set(start, url);
  }
  return alone;
}

/** The thread's pages a reply links, for its marks, names and cards. */
export interface ReplyPages {
  readonly byUrl: ReadonlyMap<string, TempoThreadPage>;
  /** The pages drawn in place of a paragraph that holds only their link, by where it starts. */
  readonly alone: ReadonlyMap<number, TempoThreadPage>;
}

export function linkedPage(pages: ReplyPages | null, href: string): TempoThreadPage | undefined {
  if (pages === null) return undefined;
  const url = pageUrl(href);
  return url === null ? undefined : pages.byUrl.get(url);
}

/** The thread's pages, and those among them a reply links alone (pageLinksAlone). */
export function replyPages(
  pages: ReadonlyArray<TempoThreadPage>,
  linksAlone: ReadonlyMap<number, string>,
): ReplyPages {
  const byUrl = new Map(pages.map((page) => [page.url, page]));
  const alone = new Map<number, TempoThreadPage>();
  for (const [start, url] of linksAlone) {
    const page = byUrl.get(url);
    if (page !== undefined) alone.set(start, page);
  }
  return { byUrl, alone };
}

/** A reply's pages that the thread's page list holds and no paragraph draws, then its markdown files. */
export function replyDeliverables(
  pageUrls: ReadonlyArray<string>,
  pages: ReplyPages,
  files: ReadonlyArray<ReplyFile>,
): ReplyDeliverable[] {
  const drawnAlone = new Set(Array.from(pages.alone.values(), (page) => page.url));
  return [
    ...pageUrls.flatMap((url) => {
      const page = pages.byUrl.get(url);
      return page === undefined || drawnAlone.has(url) ? [] : [{ kind: "page" as const, page }];
    }),
    ...files.map((file) => ({ kind: "file" as const, file })),
  ];
}

export interface DocumentPreview {
  readonly title: string;
  /** The document's first line of text after its title, without its markdown. */
  readonly lead: string | null;
}

const FENCE = /^\s{0,3}(?:```|~~~)/u;
const NOT_TEXT = /^\s*(?:\||<|!\[|(?:-{3,}|\*{3,}|_{3,})\s*$)/u;
const BLOCK_MARKER = /^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/u;

const plainInline = (text: string) =>
  text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/[*_`~]/gu, "")
    .trim();

/** What a markdown file's card shows of it: the title Quick Look gives it, then its first line. */
export function documentPreview(markdown: string, path: string): DocumentPreview {
  const { title, body } = splitMarkdownDocument(markdown);
  let fenced = false;
  let lead: string | null = null;
  for (const line of body.split(/\r\n|\r|\n/u)) {
    if (FENCE.test(line)) fenced = !fenced;
    if (fenced || FENCE.test(line) || NOT_TEXT.test(line)) continue;
    const text = plainInline(line.replace(BLOCK_MARKER, ""));
    if (text.length > 0) {
      lead = text;
      break;
    }
  }
  return { title: title === null ? documentTitleFromPath(path) : plainInline(title), lead };
}
