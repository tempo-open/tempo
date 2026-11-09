export interface DocumentProperty {
  readonly key: string;
  readonly value: string;
}

export interface MarkdownDocumentParts {
  /** The text of a leading level one heading, which the card shows as the page title. */
  readonly title: string | null;
  /** Top level scalar frontmatter fields, shown the way Notion shows page properties. */
  readonly properties: ReadonlyArray<DocumentProperty>;
  /** The markdown with the frontmatter and the title heading blanked, so line numbers still match. */
  readonly body: string;
}

const LEADING_FRONTMATTER =
  /^\uFEFF?---[ \t]*(?:\r\n|\r|\n)((?:[\s\S]*?(?:\r\n|\r|\n))?)(?:---|\.\.\.)[ \t]*(?=\r\n|\r|\n|$)/;
const FRONTMATTER_FIELD = /^([A-Za-z_][\w .-]*?)[ \t]*:[ \t]+(.+?)[ \t]*$/;
const TITLE_HEADING = /^\uFEFF? {0,3}#[ \t]+(.+?)(?:[ \t]+#+)?[ \t]*$/;
const MAX_PROPERTY_LENGTH = 400;

const blank = (text: string) => text.replace(/[^\r\n]/g, " ");

function unquote(value: string): string {
  const first = value[0];
  if ((first === '"' || first === "'") && value.endsWith(first) && value.length >= 2) {
    const inner = value.slice(1, -1);
    return first === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner.replaceAll("''", "'");
  }
  return value;
}

function parseProperties(frontmatter: string): DocumentProperty[] {
  const properties: DocumentProperty[] = [];
  for (const line of frontmatter.split(/\r\n|\r|\n/)) {
    const match = FRONTMATTER_FIELD.exec(line);
    if (!match) continue;
    const [, key = "", raw = ""] = match;
    // Block scalars, flow collections and anchors are not plain text worth showing.
    if (/^[|>[{&*!]/.test(raw)) continue;
    const value = unquote(raw).trim();
    if (value.length === 0 || value.length > MAX_PROPERTY_LENGTH) continue;
    properties.push({ key, value });
  }
  return properties;
}

export function splitMarkdownDocument(markdown: string): MarkdownDocumentParts {
  let body = markdown;
  let properties: DocumentProperty[] = [];
  const frontmatter = LEADING_FRONTMATTER.exec(body);
  if (frontmatter) {
    properties = parseProperties(frontmatter[1] ?? "");
    body = blank(frontmatter[0]) + body.slice(frontmatter[0].length);
  }

  const lines = body.split(/(\r\n|\r|\n)/);
  const firstIndex = lines.findIndex((part, index) => index % 2 === 0 && part.trim().length > 0);
  const heading = firstIndex >= 0 ? TITLE_HEADING.exec(lines[firstIndex] ?? "") : null;
  if (!heading || firstIndex < 0) return { title: null, properties, body };

  lines[firstIndex] = blank(lines[firstIndex] ?? "");
  return { title: heading[1] ?? null, properties, body: lines.join("") };
}

/** The file name without its markdown extension, the title of a document without a heading. */
export function documentTitleFromPath(path: string): string {
  const name = path.split(/[\\/]/).at(-1) ?? path;
  return name.replace(/\.(?:md|mdx|markdown|mdown|mkd)$/i, "") || name;
}

export function documentFileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

/**
 * The block to reveal for a link to `line`: the last block that starts on or
 * before it, so a line inside a paragraph or list lands on that block.
 */
export function blockIndexForLine(blockLines: ReadonlyArray<number>, line: number): number {
  let found = -1;
  for (let index = 0; index < blockLines.length; index += 1) {
    const start = blockLines[index] ?? Number.POSITIVE_INFINITY;
    if (start > line) break;
    found = index;
  }
  return found;
}
