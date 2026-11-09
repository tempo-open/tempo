/**
 * Reads the `export const meta = { name, description, phases }` header Claude
 * Code requires at the top of every workflow script. Claude requires the header
 * to be a pure literal, so a small literal reader is enough; the script itself
 * is never evaluated.
 */

export interface ClaudeWorkflowMetaPhase {
  readonly title: string;
  readonly detail?: string;
}

export interface ClaudeWorkflowMeta {
  readonly name?: string;
  readonly description?: string;
  readonly phases: ReadonlyArray<ClaudeWorkflowMetaPhase>;
}

type Literal = string | number | boolean | null | ReadonlyArray<Literal> | LiteralObject;
interface LiteralObject {
  readonly [key: string]: Literal;
}

class LiteralReader {
  private index = 0;
  private readonly source: string;
  constructor(source: string) {
    this.source = source;
  }

  read(): Literal {
    this.skip();
    const char = this.source[this.index];
    if (char === "{") return this.object();
    if (char === "[") return this.array();
    if (char === '"' || char === "'" || char === "`") return this.string(char);
    const word = this.source.slice(this.index).match(/^(-?\d+(?:\.\d+)?|true|false|null)/)?.[0];
    if (word === undefined) throw new Error("unsupported literal");
    this.index += word.length;
    if (word === "true") return true;
    if (word === "false") return false;
    if (word === "null") return null;
    return Number(word);
  }

  private skip() {
    for (;;) {
      const rest = this.source.slice(this.index);
      const whitespace = rest.match(/^\s+/)?.[0];
      if (whitespace) {
        this.index += whitespace.length;
        continue;
      }
      if (rest.startsWith("//")) {
        const end = rest.indexOf("\n");
        this.index += end === -1 ? rest.length : end + 1;
        continue;
      }
      if (rest.startsWith("/*")) {
        const end = rest.indexOf("*/");
        this.index += end === -1 ? rest.length : end + 2;
        continue;
      }
      return;
    }
  }

  private expect(char: string) {
    this.skip();
    if (this.source[this.index] !== char) throw new Error(`expected ${char}`);
    this.index += 1;
  }

  private string(quote: string): string {
    this.index += 1;
    let value = "";
    while (this.index < this.source.length) {
      const char = this.source[this.index]!;
      this.index += 1;
      if (char === quote) return value;
      if (quote === "`" && char === "$" && this.source[this.index] === "{") {
        throw new Error("template interpolation is not a literal");
      }
      if (char === "\\") {
        const escaped = this.source[this.index] ?? "";
        this.index += 1;
        value += escaped === "n" ? "\n" : escaped === "t" ? "\t" : escaped;
        continue;
      }
      value += char;
    }
    throw new Error("unterminated string");
  }

  private key(): string {
    this.skip();
    const char = this.source[this.index];
    if (char === '"' || char === "'") return this.string(char);
    const identifier = this.source.slice(this.index).match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (identifier === undefined) throw new Error("expected key");
    this.index += identifier.length;
    return identifier;
  }

  private object(): LiteralObject {
    this.expect("{");
    const entries: Array<[string, Literal]> = [];
    for (;;) {
      this.skip();
      if (this.source[this.index] === "}") {
        this.index += 1;
        return Object.fromEntries(entries);
      }
      const key = this.key();
      this.expect(":");
      entries.push([key, this.read()]);
      this.skip();
      if (this.source[this.index] === ",") this.index += 1;
    }
  }

  private array(): ReadonlyArray<Literal> {
    this.expect("[");
    const items: Literal[] = [];
    for (;;) {
      this.skip();
      if (this.source[this.index] === "]") {
        this.index += 1;
        return items;
      }
      items.push(this.read());
      this.skip();
      if (this.source[this.index] === ",") this.index += 1;
    }
  }
}

function nonEmptyText(value: Literal | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function metaPhase(value: Literal): ClaudeWorkflowMetaPhase | undefined {
  if (typeof value === "string") {
    const title = nonEmptyText(value);
    return title === undefined ? undefined : { title };
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const phase = value as LiteralObject;
    const title = nonEmptyText(phase.title) ?? nonEmptyText(phase.name);
    if (title === undefined) return undefined;
    const detail = nonEmptyText(phase.detail) ?? nonEmptyText(phase.description);
    return detail === undefined ? { title } : { title, detail };
  }
  return undefined;
}

/** The script's meta header, or undefined when it has none Claude could read either. */
export function parseClaudeWorkflowMeta(script: string): ClaudeWorkflowMeta | undefined {
  const match = /export\s+const\s+meta\s*=\s*/.exec(script);
  if (match === null) return undefined;
  let literal: Literal;
  try {
    literal = new LiteralReader(script.slice(match.index + match[0].length)).read();
  } catch {
    return undefined;
  }
  if (literal === null || typeof literal !== "object" || Array.isArray(literal)) return undefined;
  const meta = literal as LiteralObject;
  const phases = Array.isArray(meta.phases)
    ? (meta.phases as ReadonlyArray<Literal>).flatMap((phase) => {
        const parsed = metaPhase(phase);
        return parsed === undefined ? [] : [parsed];
      })
    : [];
  const name = nonEmptyText(meta.name);
  const description = nonEmptyText(meta.description);
  return {
    ...(name === undefined ? {} : { name }),
    ...(description === undefined ? {} : { description }),
    phases,
  };
}
