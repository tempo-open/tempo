import "./quickLookDocument.css";

import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { resolvePathLinkTarget, splitFilePathPosition } from "@t3tools/shared/fileLinks";
import { isHostPath } from "@t3tools/shared/path";
import type { DiffsHighlighter } from "@pierre/diffs";
import { createContext, memo, use, type ComponentProps, type ReactNode } from "react";
import ReactMarkdown, {
  defaultUrlTransform,
  type Components,
  type ExtraProps,
} from "react-markdown";
import remarkGfm from "remark-gfm";

import { useAssetUrlState } from "~/assets/assetUrls";
import { workspaceAssetResource } from "~/components/files/filePreviewMode";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { resolveDiffThemeName } from "~/lib/diffRendering";
import { getSyntaxHighlighterPromise } from "~/lib/syntaxHighlighting";

import { documentTitleFromPath, splitMarkdownDocument } from "./quickLookDocument.logic";

export type DocumentLinkTarget =
  | { readonly kind: "web"; readonly url: string }
  | { readonly kind: "file"; readonly path: string; readonly line?: number | undefined }
  | { readonly kind: "anchor"; readonly id: string };

interface DocumentContextValue {
  readonly documentDir: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly onLink: (target: DocumentLinkTarget) => void;
}

interface TreeNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: TreeNode[];
  position?: { start: { line: number } };
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

const DocumentContext = createContext<DocumentContextValue | null>(null);

type MarkdownProps<Tag extends keyof React.JSX.IntrinsicElements> = ComponentProps<Tag> &
  ExtraProps;

const treeOf = (node: ExtraProps["node"]) => node as unknown as TreeNode | undefined;
const lineProp = (props: object) => (props as { readonly "data-line"?: number })["data-line"];

const LIGHT_THEME = resolveDiffThemeName("light");
const CALLOUT_MARKER = /^\[!(note|tip|important|warning|caution)\][ \t]*(?:\r?\n)?/i;
const BLOCK_TAGS = new Set([
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "aside",
  "pre",
  "table",
  "hr",
]);
const PLAIN_TEXT = new Set(["text", "txt", "plain", "plaintext"]);
const LANGUAGE_LABELS: Record<string, string> = {
  bash: "Bash",
  c: "C",
  cpp: "C++",
  css: "CSS",
  diff: "Diff",
  go: "Go",
  html: "HTML",
  java: "Java",
  js: "JavaScript",
  javascript: "JavaScript",
  json: "JSON",
  jsonc: "JSON",
  jsx: "JSX",
  kotlin: "Kotlin",
  md: "Markdown",
  markdown: "Markdown",
  mermaid: "Mermaid",
  py: "Python",
  python: "Python",
  rb: "Ruby",
  ruby: "Ruby",
  rs: "Rust",
  rust: "Rust",
  sh: "Shell",
  shell: "Shell",
  sql: "SQL",
  swift: "Swift",
  toml: "TOML",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  xml: "XML",
  yaml: "YAML",
  yml: "YAML",
  zsh: "Shell",
};

function nodeText(node: TreeNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(nodeText).join("");
}

function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s/g, "-");
}

/** GitHub style `> [!NOTE]` quotes become Notion callouts. */
function remarkCallouts() {
  const walk = (node: TreeNode) => {
    for (const child of node.children ?? []) walk(child);
    if (node.type !== "blockquote") return;
    const paragraph = node.children?.[0];
    const text = paragraph?.type === "paragraph" ? paragraph.children?.[0] : undefined;
    const match = text?.type === "text" ? CALLOUT_MARKER.exec(text.value ?? "") : null;
    if (!text || !match) return;
    text.value = (text.value ?? "").slice(match[0].length);
    const kind = (match[1] ?? "note").toLowerCase();
    node.data = {
      hName: "aside",
      hProperties: { dataDocCallout: "", dataLabel: kind.charAt(0).toUpperCase() + kind.slice(1) },
    };
  };
  return (tree: unknown) => walk(tree as TreeNode);
}

/** Marks each block with its source line, for revealing `file.md:42`, and gives headings anchor ids. */
function rehypeDocumentBlocks() {
  return (tree: unknown) => {
    const ids = new Map<string, number>();
    const walk = (node: TreeNode) => {
      if (node.type === "element" && node.tagName) {
        const properties = (node.properties ??= {});
        if (BLOCK_TAGS.has(node.tagName) && node.position) {
          properties.dataLine = node.position.start.line;
        }
        if (/^h[1-6]$/.test(node.tagName)) {
          const base = slugify(nodeText(node)) || "section";
          const seen = ids.get(base) ?? 0;
          ids.set(base, seen + 1);
          properties.id = seen === 0 ? base : `${base}-${seen}`;
        }
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree as TreeNode);
  };
}

const REMARK_PLUGINS = [remarkGfm, remarkCallouts];
const REHYPE_PLUGINS = [rehypeDocumentBlocks];
const TITLE_ELEMENTS = ["p", "code", "em", "strong", "del"];
const TITLE_COMPONENTS: Components = { p: ({ children }) => children };

function urlTransform(url: string): string {
  return url.startsWith("file://") ? url : defaultUrlTransform(url);
}

export function classifyDocumentHref(href: string, documentDir: string): DocumentLinkTarget | null {
  if (href.startsWith("#")) {
    try {
      return { kind: "anchor", id: decodeURIComponent(href.slice(1)) };
    } catch {
      return { kind: "anchor", id: href.slice(1) };
    }
  }
  if (/^(?:https?|mailto):/i.test(href)) return { kind: "web", url: href };
  let raw = href;
  if (href.startsWith("file://")) {
    try {
      raw = decodeURIComponent(new URL(href).pathname);
    } catch {
      return null;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(href)) {
    return null;
  }
  const [withoutQuery = raw] = raw.split("?", 1);
  const hashAt = withoutQuery.indexOf("#");
  const pathPart = hashAt >= 0 ? withoutQuery.slice(0, hashAt) : withoutQuery;
  if (pathPart.length === 0) return null;
  let decoded = pathPart;
  try {
    decoded = decodeURIComponent(pathPart);
  } catch {
    // A literal % in a file name.
  }
  const position = splitFilePathPosition(decoded, hashAt >= 0 ? withoutQuery.slice(hashAt) : "");
  return {
    kind: "file",
    path: resolvePathLinkTarget(position.path, documentDir),
    line: position.line,
  };
}

export function documentDirectory(path: string, cwd: string): string {
  const absolute = isHostPath(path) ? path : resolvePathLinkTarget(path, cwd);
  const separator = Math.max(absolute.lastIndexOf("/"), absolute.lastIndexOf("\\"));
  return separator > 0 ? absolute.slice(0, separator) : cwd;
}

function CopyCodeButton({ code }: { readonly code: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ timeout: 1400 });
  return (
    <button
      type="button"
      data-doc-code-copy=""
      data-doc-ui=""
      onClick={() => copyToClipboard(code, undefined)}
    >
      {isCopied ? "Copied" : "Copy"}
    </button>
  );
}

const FENCE_LANGUAGE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*([\w#+.-]+)/gm;
const loadedHighlighters = new Map<string, DiffsHighlighter>();
const highlighterLoads = new Map<string, Promise<unknown>>();

/**
 * Every highlighter the document's code blocks need, loaded before it renders, so the
 * page appears once with its final layout and a link to a line inside code can land on it.
 */
function documentHighlighters(markdown: string): Promise<unknown> {
  const languages = new Set(["text"]);
  for (const match of markdown.matchAll(FENCE_LANGUAGE)) {
    if (match[1]) languages.add(match[1].toLowerCase());
  }
  const key = [...languages].toSorted().join(" ");
  let load = highlighterLoads.get(key);
  if (!load) {
    load = Promise.all(
      [...languages].map((language) =>
        getSyntaxHighlighterPromise(language).then(
          (highlighter) => void loadedHighlighters.set(language, highlighter),
          () => undefined,
        ),
      ),
    );
    highlighterLoads.set(key, load);
  }
  return load;
}

function highlightedHtml(code: string, language: string): string | null {
  const highlighter = loadedHighlighters.get(language) ?? loadedHighlighters.get("text");
  if (!highlighter) return null;
  try {
    return highlighter.codeToHtml(code, { lang: language, theme: LIGHT_THEME });
  } catch {
    try {
      return highlighter.codeToHtml(code, { lang: "text", theme: LIGHT_THEME });
    } catch {
      return null;
    }
  }
}

function DocumentCodeBlock({ node }: MarkdownProps<"pre">) {
  const pre = treeOf(node);
  const code = pre?.children?.find((child) => child.tagName === "code");
  const classes = code?.properties?.className;
  const languageClass = Array.isArray(classes)
    ? classes.find((name): name is string => String(name).startsWith("language-"))
    : undefined;
  const language = languageClass ? languageClass.slice("language-".length).toLowerCase() : null;
  const label =
    language && !PLAIN_TEXT.has(language) ? (LANGUAGE_LABELS[language] ?? language) : null;
  const text = nodeText(code).replace(/\n$/, "");
  const html = highlightedHtml(text, language ?? "text");
  const line = pre?.properties?.dataLine;
  return (
    <div
      data-doc-code=""
      data-language={label ?? undefined}
      data-line={typeof line === "number" ? line : undefined}
    >
      {label ? <span data-doc-code-lang="">{label}</span> : null}
      <CopyCodeButton code={text} />
      {html === null ? (
        <pre>
          <code>{text}</code>
        </pre>
      ) : (
        <div dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}

function DocumentImage({ src, alt }: MarkdownProps<"img">) {
  const context = use(DocumentContext);
  const source = typeof src === "string" ? src : "";
  const direct = source.length === 0 || /^(?:https?|data|blob):/i.test(source);
  const target = direct || !context ? null : classifyDocumentHref(source, context.documentDir);
  const resource =
    target?.kind === "file" && context
      ? workspaceAssetResource({
          kind: "workspace-file",
          threadRef: context.threadRef,
          draft: false,
          workspaceRoot: context.cwd,
          absolutePath: target.path,
        })
      : null;
  const asset = useAssetUrlState(context?.environmentId ?? null, resource);
  const url = direct ? source : asset._tag === "Success" ? asset.url : null;
  if (!url) return null;
  return <img src={url} alt={alt ?? ""} loading="lazy" decoding="async" />;
}

function DocumentLink({ href, children }: MarkdownProps<"a">) {
  const context = use(DocumentContext);
  return (
    <a
      href={href}
      onClick={(event) => {
        if (!href || !context) return;
        const target = classifyDocumentHref(href, context.documentDir);
        if (!target) return;
        event.preventDefault();
        context.onLink(target);
      }}
    >
      {children}
    </a>
  );
}

function DocumentListItem(props: MarkdownProps<"li">) {
  if (!props.className?.includes("task-list-item")) {
    return <li data-line={lineProp(props)}>{props.children}</li>;
  }
  const box = treeOf(props.node)?.children?.find((child) => child.tagName === "input");
  return (
    <li
      data-doc-task=""
      data-line={lineProp(props)}
      data-checked={box?.properties?.checked === true ? "true" : "false"}
    >
      {props.children}
    </li>
  );
}

function DocumentCheckbox({ type, checked }: MarkdownProps<"input">) {
  if (type !== "checkbox") return null;
  return <span data-doc-check="" role="img" aria-label={checked ? "Done" : "Not done"} />;
}

function DocumentTable(props: MarkdownProps<"table">) {
  return (
    <div data-doc-table="" data-line={lineProp(props)}>
      <table>{props.children}</table>
    </div>
  );
}

function DocumentList(props: MarkdownProps<"ul">) {
  return <ul data-line={lineProp(props)}>{props.children}</ul>;
}

const DOCUMENT_COMPONENTS: Components = {
  a: DocumentLink,
  img: DocumentImage,
  input: DocumentCheckbox,
  li: DocumentListItem,
  pre: DocumentCodeBlock,
  table: DocumentTable,
  ul: DocumentList,
};

/** tempo: a markdown file set the way Notion sets a page. */
export const QuickLookDocument = memo(function QuickLookDocument(props: {
  readonly markdown: string;
  readonly path: string;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly threadRef: ScopedThreadRef;
  readonly onLink: (target: DocumentLinkTarget) => void;
  readonly footer?: ReactNode;
  /** Called with the article once it is on screen, which waits for its highlighters. */
  readonly onArticle?: (article: HTMLElement | null) => void;
}) {
  const { markdown, path, cwd, environmentId, threadRef, onLink, footer, onArticle } = props;
  use(documentHighlighters(markdown));
  const parts = splitMarkdownDocument(markdown);
  const context: DocumentContextValue = {
    documentDir: documentDirectory(path, cwd),
    cwd,
    environmentId,
    threadRef,
    onLink,
  };

  return (
    <DocumentContext value={context}>
      <article ref={onArticle} data-tempo-doc="">
        <h1 data-doc-title="">
          {parts.title ? (
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              allowedElements={TITLE_ELEMENTS}
              unwrapDisallowed
              components={TITLE_COMPONENTS}
            >
              {parts.title}
            </ReactMarkdown>
          ) : (
            documentTitleFromPath(path)
          )}
        </h1>
        {parts.properties.length > 0 ? (
          <dl data-doc-properties="">
            {parts.properties.map((property) => (
              <div key={property.key} data-doc-property="">
                <dt>{property.key}</dt>
                <dd>{property.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        <div data-doc-body="">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_PLUGINS}
            urlTransform={urlTransform}
            components={DOCUMENT_COMPONENTS}
          >
            {parts.body}
          </ReactMarkdown>
        </div>
        {footer}
      </article>
    </DocumentContext>
  );
});
