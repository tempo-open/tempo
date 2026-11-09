/** tempo: a shared page's title, line about it, picture and emoji, read from the head of its HTML. */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

const HEAD_LIMIT = 256 * 1024;
const END_OF_HEAD = /<\/head\s*>/iu;

/** A page's text up to the end of its head, where its meta tags sit, and never past HEAD_LIMIT. */
export const readPageHead = <E, R>(body: Stream.Stream<Uint8Array, E, R>) =>
  body.pipe(
    Stream.decodeText(),
    Stream.scan(
      () => "",
      (html, chunk) => html + chunk,
    ),
    Stream.takeUntil((html) => html.length >= HEAD_LIMIT || END_OF_HEAD.test(html)),
    Stream.runLast,
    Effect.map(Option.getOrElse(() => "")),
  );

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (entity, code: string) => {
    if (code.startsWith("#x") || code.startsWith("#X")) {
      return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    }
    if (code.startsWith("#")) return String.fromCodePoint(Number.parseInt(code.slice(1), 10));
    return ENTITIES[code.toLowerCase()] ?? entity;
  });
}

/** Every `<name ...>` tag, with a `>` inside a quoted attribute kept in its tag. */
const tags = (html: string, name: string) =>
  Array.from(
    html.matchAll(new RegExp(`<${name}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, "giu")),
    ([tag]) => tag,
  );

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined);

const clean = (text: string | undefined) => {
  const value = decodeEntities(text ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  return value.length > 0 ? value : null;
};

const SVG_DATA_URI = /^data:image\/svg\+xml((?:;[^,;]*)*),([\s\S]*)$/iu;
const ONE_EMOJI = /^\p{RGI_Emoji}$/v;

function svgText(href: string): string | null {
  const match = SVG_DATA_URI.exec(href.trim());
  if (match === null) return null;
  const [, params = "", data = ""] = match;
  try {
    if (params.toLowerCase().split(";").includes("base64")) {
      return new TextDecoder().decode(Uint8Array.from(atob(data), (char) => char.charCodeAt(0)));
    }
    return decodeURIComponent(data.replace(/%(?![\da-f]{2})/giu, "%25"));
  } catch {
    return null;
  }
}

/** The emoji an icon draws, when the icon is an SVG data URI whose only text is that one emoji. */
function iconEmoji(href: string): string | null {
  const svg = svgText(decodeEntities(href));
  if (svg === null) return null;
  const text = decodeEntities(svg.replace(/<!--[\s\S]*?-->|<[^>]*>/gu, "")).trim();
  return ONE_EMOJI.test(text) ? text : null;
}

export interface PageMeta {
  readonly title: string | null;
  /** What the page says it is about, in one line (`og:description`). */
  readonly about: string | null;
  readonly picture: string | null;
  /** The one emoji the page's icon draws. */
  readonly emoji: string | null;
}

export function readPageMeta(html: string, base: string): PageMeta {
  const meta = new Map<string, string>();
  for (const tag of tags(html, "meta")) {
    const key = (attribute(tag, "property") ?? attribute(tag, "name"))?.toLowerCase();
    const content = attribute(tag, "content");
    if (key !== undefined && content !== undefined && !meta.has(key)) meta.set(key, content);
  }
  const title =
    clean(meta.get("og:title")) ??
    clean(meta.get("twitter:title")) ??
    clean(/<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1]);
  const image = clean(meta.get("og:image")) ?? clean(meta.get("twitter:image"));
  const picture = image === null ? null : URL.parse(image, base);
  const icons = tags(html, "link").flatMap((tag) =>
    /(?:^|\s)icon(?:\s|$)/iu.test(attribute(tag, "rel") ?? "")
      ? [attribute(tag, "href") ?? ""]
      : [],
  );
  return {
    title,
    about: clean(meta.get("og:description")) ?? clean(meta.get("twitter:description")),
    picture: picture !== null && /^https?:$/u.test(picture.protocol) ? picture.href : null,
    emoji: icons.map(iconEmoji).find((emoji) => emoji !== null) ?? null,
  };
}
