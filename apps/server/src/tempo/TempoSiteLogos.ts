/**
 * tempo: the logo of a company that is not on the thread logo list (`@t3tools/shared/tempoThreadLogos`),
 * taken from its own website and kept on the thread as a small PNG data URI. The title model may
 * guess the domain, so a site counts only when the thread names it, its home page carries that name
 * and it is not a parked domain. Anything else gets no logo rather than someone else's.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** Twice the tempo look's 18 pt sidebar logo, for Retina screens. */
const ICON_SIZE = 36;
const MAX_BYTES = 1_000_000;
const TIMEOUT = Duration.seconds(20);
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0 Safari/537.36",
  accept: "text/html,image/*;q=0.9,*/*;q=0.8",
};
const PARKED =
  /domain (?:is )?for sale|buy this domain|this domain (?:may be|is) for sale|parked free|hugedomains|sedoparking|afternic|dan\.com/iu;
const SECOND_LEVEL = new Set(["co", "com", "org", "net", "gov", "ac"]);

class SiteLogoHttpError extends Data.TaggedError("SiteLogoHttpError")<{
  readonly url: string;
  readonly reason: string;
}> {}

/** Letters and digits only, so "Acme Widgets" matches acmewidgets.com. */
const squash = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/gu, "");

/** The name a domain gives: acme for acme.com and for app.acme.co.uk. */
export function siteName(domain: string): string {
  return squash(
    domain
      .split(".")
      .slice(0, -1)
      .filter((label) => !SECOND_LEVEL.has(label))
      .at(-1) ?? "",
  );
}

const attribute = (tag: string, name: string) =>
  new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu")
    .exec(tag)
    ?.slice(1)
    .find((value) => value !== undefined) ?? "";

/**
 * The page's own name for itself (title and og:site_name), and its icons, best first: the apple
 * touch icon, then other icons by size. SVG icons are left out because sips cannot read them.
 */
export function readHomePage(html: string, base: string) {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/iu.exec(html)?.[1] ?? "";
  const siteNameTag = /<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*>/iu.exec(html)?.[0];
  const icons = [...html.matchAll(/<link\b[^>]*>/giu)]
    .map(([tag]) => ({
      rel: attribute(tag, "rel").toLowerCase(),
      href: attribute(tag, "href"),
      type: attribute(tag, "type").toLowerCase(),
      size: Number.parseInt(attribute(tag, "sizes"), 10) || 0,
    }))
    .filter(
      (link) =>
        /(?:^|\s)(?:apple-touch-icon(?:-precomposed)?|icon)(?:\s|$)/u.test(link.rel) &&
        link.href !== "" &&
        link.type !== "image/svg+xml" &&
        !/\.svg(?:[?#]|$)/iu.test(link.href),
    )
    .toSorted(
      (a, b) =>
        Number(b.rel.includes("apple-touch-icon")) - Number(a.rel.includes("apple-touch-icon")) ||
        b.size - a.size,
    )
    .flatMap((link) => (URL.canParse(link.href, base) ? [new URL(link.href, base).href] : []));
  return {
    names: `${title} ${siteNameTag === undefined ? "" : attribute(siteNameTag, "content")}`,
    icons: [...new Set([...icons, new URL("/favicon.ico", base).href])],
  };
}

const isImage = (bytes: Uint8Array) =>
  (bytes[0] === 0x89 && bytes[1] === 0x50) || // PNG
  (bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) || // ICO
  (bytes[0] === 0xff && bytes[1] === 0xd8) || // JPEG
  (bytes[0] === 0x47 && bytes[1] === 0x49) || // GIF
  (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57); // WEBP

export class TempoSiteLogos extends Context.Service<
  TempoSiteLogos,
  {
    /** The site's logo as a data URI, or null when the site does not check out. */
    readonly siteLogo: (domain: string, threadText: string) => Effect.Effect<string | null>;
  }
>()("t3/tempo/TempoSiteLogos") {}

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;

  const download = Effect.fn("TempoSiteLogos.download")(function* (url: string) {
    const response = yield* httpClient.execute(
      HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(BROWSER_HEADERS)),
    );
    if (response.status < 200 || response.status >= 300) {
      return yield* new SiteLogoHttpError({ url, reason: `HTTP ${response.status}` });
    }
    const bytes = new Uint8Array(yield* response.arrayBuffer);
    if (bytes.length === 0 || bytes.length > MAX_BYTES) {
      return yield* new SiteLogoHttpError({ url, reason: `${bytes.length} bytes` });
    }
    return bytes;
  });

  /** A 36 px PNG of the icon, through the sips that ships with macOS. */
  const shrink = (icon: Uint8Array) =>
    Effect.scoped(
      Effect.gen(function* () {
        const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-site-logo-" });
        const source = path.join(directory, "icon");
        const target = path.join(directory, "icon.png");
        yield* fileSystem.writeFile(source, icon);
        yield* spawner.string(
          ChildProcess.make(
            "/usr/bin/sips",
            ["-z", `${ICON_SIZE}`, `${ICON_SIZE}`, "-s", "format", "png", source, "--out", target],
            { stdin: "ignore", stderr: "ignore" },
          ),
        );
        return yield* fileSystem.readFile(target);
      }),
    );

  const siteLogo: TempoSiteLogos["Service"]["siteLogo"] = Effect.fn("TempoSiteLogos.siteLogo")(
    function* (domain: string, threadText: string) {
      const name = siteName(domain);
      if (platform !== "darwin" || name.length < 2 || !squash(threadText).includes(name)) {
        return null;
      }
      const base = `https://${domain}/`;
      const html = new TextDecoder().decode(yield* download(base));
      const page = readHomePage(html, base);
      if (!squash(page.names).includes(name) || PARKED.test(html)) return null;
      for (const url of page.icons) {
        const icon = yield* download(url).pipe(Effect.option);
        if (icon._tag === "None" || !isImage(icon.value)) continue;
        const png = yield* shrink(icon.value);
        return `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
      }
      return null;
    },
    (effect, domain) =>
      effect.pipe(
        Effect.timeout(TIMEOUT),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logDebug("No site logo", { domain, cause }).pipe(Effect.as(null)),
        ),
      ),
  );
  return TempoSiteLogos.of({ siteLogo });
});

export const layer = Layer.effect(TempoSiteLogos, make);
