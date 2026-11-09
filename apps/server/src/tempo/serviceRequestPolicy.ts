/**
 * The rules every company-service request follows, as plain functions:
 * where a path may go, which response headers an agent sees, and how known
 * secrets are scrubbed from what comes back. ServiceConnections applies them.
 *
 * @module serviceRequestPolicy
 */
import type { TempoServiceRequestResult } from "@t3tools/contracts";

/** Responses are cut here; a cut JSON body is returned as text. */
export const SERVICE_RESPONSE_MAX_BYTES = 1_048_576;

export const REDACTED = "[redacted]";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The canonical base URL a local connection may be saved with, or null: https
 * (http only for loopback), no credentials, query, or fragment, no trailing
 * slash. Requests are pinned to its origin and path.
 */
export function normalizeServiceBaseUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return null;
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  // From its parts, so a bare trailing "?" or "#" (empty search and hash) is dropped too.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

/**
 * A saved path prefix in canonical form ("/keys", never "/keys/"), "" for the
 * root (which allows every path), or null when it is not a plain path.
 */
export function normalizeServicePathPrefix(value: string): string | null {
  const trimmed = value.trim();
  const path = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  if (!isPlainPath(path)) return null;
  if (path.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return path.replace(/\/+$/, "");
}

// Query, fragment, backslashes, control characters, and a leading "//" (another host) are refused.
function isPlainPath(path: string): boolean {
  return (
    path.startsWith("/") &&
    !path.startsWith("//") &&
    !/[?#\\]/.test(path) &&
    !/[\u0000-\u001f\u007f]/.test(path) &&
    path.length <= 2_048
  );
}

export type ServiceUrlResolution =
  | {
      readonly _tag: "Resolved";
      readonly url: URL;
      readonly relativePath: string;
      /** `relativePath` percent-decoded once, as an upstream that decodes "%2F" would route it. */
      readonly decodedPath: string;
    }
  | { readonly _tag: "InvalidPath" }
  | { readonly _tag: "OutsideBase" };

/**
 * Joins a request path onto a base URL after the URL parser resolves dot segments, and refuses any
 * result that leaves the base's origin or path. `relativePath` is the resolved path below the base,
 * for prefix checks. A path that only climbs once decoded ("/keys/..%2F..%2Fadmin") is refused too,
 * since some upstreams decode encoded separators before routing.
 */
export function resolveServiceUrl(baseUrl: string, path: string): ServiceUrlResolution {
  const requested = path.trim() === "" ? "/" : path.trim();
  const absolute = requested.startsWith("/") ? requested : `/${requested}`;
  if (!isPlainPath(absolute)) return { _tag: "InvalidPath" };
  let base: URL;
  let url: URL;
  try {
    base = new URL(baseUrl);
    url = new URL(`${baseUrl.replace(/\/+$/, "")}${absolute}`);
  } catch {
    return { _tag: "InvalidPath" };
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  if (url.origin !== base.origin) return { _tag: "OutsideBase" };
  if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
    return { _tag: "OutsideBase" };
  }
  const relativePath = url.pathname.slice(basePath.length) || "/";
  let decodedPath: string;
  try {
    decodedPath = decodeURIComponent(relativePath);
  } catch {
    return { _tag: "InvalidPath" };
  }
  if (
    /\\/.test(decodedPath) ||
    /[\u0000-\u001f\u007f]/.test(decodedPath) ||
    decodedPath.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    return { _tag: "InvalidPath" };
  }
  return { _tag: "Resolved", url, relativePath, decodedPath };
}

/** Whole segments only: "/keys" allows "/keys" and "/keys/abc", not "/keysmith". */
export function pathAllowedByPrefixes(
  relativePath: string,
  prefixes: ReadonlyArray<string>,
): boolean {
  if (prefixes.length === 0) return true;
  return prefixes.some(
    (prefix) => prefix === "" || relativePath === prefix || relativePath.startsWith(`${prefix}/`),
  );
}

export type ServiceQuery = Readonly<
  Record<string, string | number | boolean | ReadonlyArray<string | number | boolean>>
>;

export function appendServiceQuery(url: URL, query: ServiceQuery | undefined): URL {
  if (query === undefined) return url;
  const next = new URL(url);
  for (const [name, value] of Object.entries(query)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      next.searchParams.append(name, String(item));
    }
  }
  return next;
}

/**
 * Replaces every known secret, and its URL-encoded form, with `marker`.
 * Secrets shorter than six characters would scrub ordinary text, so they are
 * not matched; saved connection secrets are at least eight.
 */
export function makeSecretRedactor(
  secrets: ReadonlyArray<string>,
  marker: string = REDACTED,
): (text: string) => string {
  const needles = [
    ...new Set(
      secrets
        .flatMap((secret) => [secret, encodeURIComponent(secret)])
        .filter((s) => s.length >= 6),
    ),
  ].toSorted((left, right) => right.length - left.length);
  if (needles.length === 0) return (text) => text;
  return (text) => needles.reduce((current, needle) => current.split(needle).join(marker), text);
}

/** Redacts strings and keys anywhere in a parsed JSON value, which catches escaped forms. */
export function redactJsonValue(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item, redact));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [redact(key), redactJsonValue(item, redact)]),
    );
  }
  return value;
}

const SECRET_FIELD = /key|token|secret|password|passphrase|authorization|credential|cookie/i;

/**
 * A payload as an approval card may show it: the value of any field whose
 * name looks like it holds a secret becomes `[redacted]`, at any depth.
 */
export function maskSecretFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskSecretFields);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        SECRET_FIELD.test(key) && item !== null && typeof item !== "boolean"
          ? REDACTED
          : maskSecretFields(item),
      ]),
    );
  }
  return value;
}

// Headers an agent may see. Everything else, including any auth or cookie header, is dropped.
const SAFE_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-range",
  "date",
  "etag",
  "last-modified",
  "cache-control",
  "retry-after",
  "link",
  "location",
  "x-request-id",
  "cf-ray",
]);
const SAFE_RESPONSE_HEADER_PREFIXES = ["x-ratelimit-", "ratelimit-"];

export function safeResponseHeaders(
  headers: Readonly<Record<string, string | undefined>>,
  redact: (text: string) => string,
): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (value === undefined) continue;
    if (
      SAFE_RESPONSE_HEADERS.has(name) ||
      SAFE_RESPONSE_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
    ) {
      safe[name] = redact(value);
    }
  }
  return safe;
}

const BINARY_CONTENT_TYPES = [
  "image/",
  "audio/",
  "video/",
  "font/",
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
];

/**
 * The body an agent sees: parsed JSON when it is whole JSON, otherwise text,
 * with known secrets redacted either way. Binary bodies are not shown.
 */
export function decodeServiceBody(input: {
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
  readonly contentType: string | undefined;
  readonly redact: (text: string) => string;
}): Pick<TempoServiceRequestResult, "body" | "bodyFormat"> {
  if (input.bytes.length === 0) return { body: null, bodyFormat: "empty" };
  const contentType = input.contentType?.toLowerCase() ?? "";
  if (BINARY_CONTENT_TYPES.some((prefix) => contentType.startsWith(prefix))) {
    return { body: null, bodyFormat: "binary" };
  }
  const text = input.redact(new TextDecoder().decode(input.bytes));
  const looksJson = contentType.includes("json") || /^\s*[[{]/.test(text);
  if (!input.truncated && looksJson) {
    try {
      return { body: redactJsonValue(JSON.parse(text), input.redact), bodyFormat: "json" };
    } catch {
      // Not JSON after all; the agent gets the text.
    }
  }
  return { body: text, bodyFormat: "text" };
}
