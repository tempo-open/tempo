/**
 * Unpacks a verified extension archive and reads its manifest. The archive came from the network,
 * so extraction trusts nothing: plain files and folders below the destination only, no links,
 * encryption or exotic compression, capped counts and sizes. `_metadata` (the Web Store's signed
 * hashes) is dropped, because Chrome refuses to load an unpacked folder that holds it.
 */
import * as EffectNodeStream from "@effect/platform-node/NodeStream";
import { TempoBrowserProfileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { openZipArchive } from "../../zipArchive.ts";

interface ExtensionArchiveLimits {
  readonly maxEntries: number;
  readonly maxEntryBytes: number;
  readonly maxTotalBytes: number;
}

const DEFAULT_EXTENSION_ARCHIVE_LIMITS: ExtensionArchiveLimits = {
  maxEntries: 20_000,
  maxEntryBytes: 256 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
};

const invalidPackage = (cause?: unknown) =>
  new TempoBrowserProfileError({
    reason: "invalid_package",
    ...(cause === undefined ? {} : { cause }),
  });

const SKIPPED_ROOTS = new Set(["_metadata", "__MACOSX"]);

/** The archive-relative path of an entry, or null when it could escape or is malformed. */
export const safeEntryPath = (fileName: string): string | null => {
  if (
    fileName === "" ||
    fileName.includes("\\") ||
    fileName.includes("\0") ||
    fileName.startsWith("/") ||
    /^[A-Za-z]:/.test(fileName)
  ) {
    return null;
  }
  const segments = fileName.split("/");
  const isDirectory = fileName.endsWith("/");
  const parts = isDirectory ? segments.slice(0, -1) : segments;
  if (parts.length === 0 || parts.some((part) => part === "" || part === "." || part === "..")) {
    return null;
  }
  return parts.join("/");
};

/** Extracts a ZIP of an extension into an empty `destination` that does not exist yet. */
export const extractExtensionArchive = Effect.fn("extensionPackage.extract")(function* (
  archivePath: string,
  destination: string,
  limits: ExtensionArchiveLimits = DEFAULT_EXTENSION_ARCHIVE_LIMITS,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const archive = yield* openZipArchive(archivePath, (_detail, cause) => invalidPackage(cause));
  if (archive.entryCount > limits.maxEntries) {
    return yield* new TempoBrowserProfileError({ reason: "too_large" });
  }
  yield* fs.makeDirectory(destination).pipe(Effect.mapError(storage));
  let totalBytes = 0;
  for (;;) {
    const entry = yield* archive.next;
    if (!entry) break;
    const relative = safeEntryPath(entry.fileName);
    const unixType = (entry.externalFileAttributes >>> 16) & 0o170000;
    const isDirectory = entry.fileName.endsWith("/");
    if (
      relative === null ||
      (unixType !== 0 && unixType !== (isDirectory ? 0o040000 : 0o100000)) ||
      (entry.generalPurposeBitFlag & 1) !== 0 ||
      ![0, 8].includes(entry.compressionMethod)
    ) {
      return yield* invalidPackage();
    }
    if (SKIPPED_ROOTS.has(relative.split("/")[0]!)) continue;
    const target = path.resolve(destination, ...relative.split("/"));
    if (!target.startsWith(`${destination}${path.sep}`)) return yield* invalidPackage();
    if (isDirectory) {
      yield* fs.makeDirectory(target, { recursive: true }).pipe(Effect.mapError(storage));
      continue;
    }
    totalBytes += entry.uncompressedSize;
    if (entry.uncompressedSize > limits.maxEntryBytes || totalBytes > limits.maxTotalBytes) {
      return yield* new TempoBrowserProfileError({ reason: "too_large" });
    }
    yield* fs
      .makeDirectory(path.dirname(target), { recursive: true })
      .pipe(Effect.mapError(storage));
    // yauzl checks each entry's real size against the declared one as it streams.
    yield* Effect.gen(function* () {
      const readable = yield* archive.streamEntry(entry);
      yield* EffectNodeStream.fromReadable<Uint8Array, TempoBrowserProfileError>({
        evaluate: () => readable,
        onError: (cause) => invalidPackage(cause),
      }).pipe(Stream.run(fs.sink(target, { flag: "wx" })), Effect.mapError(asProfileError));
    }).pipe(Effect.scoped);
  }
}, Effect.scoped);

const storage = (cause: unknown) => new TempoBrowserProfileError({ reason: "storage", cause });
const isProfileError = Schema.is(TempoBrowserProfileError);
const asProfileError = (cause: unknown) => (isProfileError(cause) ? cause : storage(cause));

export interface ExtensionManifestInfo {
  readonly name: string;
  readonly version: string;
  readonly description?: string;
  /** The manifest's own `key` (SPKI DER, base64), when it has one. */
  readonly key?: string;
  readonly iconDataUrl?: string;
  readonly popupPage?: string;
  readonly optionsPage?: string;
}

const MANIFEST_MAX_BYTES = 1024 * 1024;
const ICON_MAX_BYTES = 64 * 1024;
const ICON_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const asText = (value: unknown, max = 512) =>
  typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : undefined;

/** An extension-relative page path, without a leading slash; null when it points elsewhere. */
export const safeExtensionPage = (value: unknown): string | undefined => {
  const page = asText(value, 1024)?.replace(/^\/+/, "");
  if (page === undefined || page.includes("://") || page.includes("\\")) return undefined;
  const pathPart = page.split(/[?#]/)[0]!;
  return safeEntryPath(pathPart) === null ? undefined : page;
};

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJson = Schema.decodeUnknownSync(JsonText);
const encodeJson = Schema.encodeSync(JsonText);
/** Manifests may start with a byte order mark, which JSON does not allow. */
const parseJson = (text: string): unknown => decodeJson(text.replace(/^\uFEFF/, ""));

/**
 * Reads and checks `manifest.json` in an extension folder: Manifest V3 with a
 * name and version (Chrome 154 runs nothing older). `__MSG_name__` strings
 * resolve from the default locale.
 */
export const readExtensionManifest = Effect.fn("extensionPackage.readManifest")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const readSmall = Effect.fn("extensionPackage.readSmall")(
    function* (relative: string, max: number) {
      const target = path.resolve(root, ...relative.split("/"));
      if (!target.startsWith(`${root}${path.sep}`)) return undefined;
      const info = yield* fs.stat(target);
      if (info.type !== "File" || Number(info.size) > max) return undefined;
      return yield* fs.readFile(target);
    },
    Effect.orElseSucceed(() => undefined),
  );

  const manifestBytes = yield* readSmall("manifest.json", MANIFEST_MAX_BYTES);
  if (manifestBytes === undefined) {
    return yield* new TempoBrowserProfileError({ reason: "unsupported_manifest" });
  }
  const manifest = yield* Effect.try({
    try: () => asRecord(parseJson(new TextDecoder().decode(manifestBytes))),
    catch: (cause) => new TempoBrowserProfileError({ reason: "unsupported_manifest", cause }),
  });
  if (manifest === undefined || manifest.manifest_version !== 3) {
    return yield* new TempoBrowserProfileError({ reason: "unsupported_manifest" });
  }

  const locale = asText(manifest.default_locale, 32);
  const messages =
    locale !== undefined && /^[A-Za-z0-9_-]+$/.test(locale)
      ? asRecord(
          yield* readSmall(`_locales/${locale}/messages.json`, MANIFEST_MAX_BYTES).pipe(
            Effect.map((bytes) => {
              try {
                return bytes === undefined ? undefined : parseJson(new TextDecoder().decode(bytes));
              } catch {
                return undefined;
              }
            }),
          ),
        )
      : undefined;
  const localized = (value: unknown, max?: number) => {
    const text = asText(value, max);
    const key = text === undefined ? undefined : /^__MSG_(\w+)__$/.exec(text)?.[1];
    if (key === undefined || messages === undefined) return text;
    const entry = Object.entries(messages).find(
      ([name]) => name.toLowerCase() === key.toLowerCase(),
    );
    return asText(asRecord(entry?.[1])?.message, max);
  };

  const name = localized(manifest.name, 128);
  const version = asText(manifest.version, 64);
  if (name === undefined || version === undefined || !/^\d+(\.\d+){0,3}$/.test(version)) {
    return yield* new TempoBrowserProfileError({ reason: "unsupported_manifest" });
  }

  const action = asRecord(manifest.action);
  const icons = { ...asRecord(action?.default_icon), ...asRecord(manifest.icons) };
  const sized = Object.entries(icons)
    .map(([size, file]) => ({ size: Number(size), file: safeExtensionPage(file) }))
    .filter((icon) => Number.isFinite(icon.size) && icon.file !== undefined)
    .sort((left, right) => right.size - left.size);
  const icon = sized.find((candidate) => candidate.size <= 128) ?? sized.at(-1);
  let iconDataUrl: string | undefined;
  if (icon?.file !== undefined) {
    const type = ICON_TYPES[icon.file.split(".").pop()?.toLowerCase() ?? ""];
    const bytes = type === undefined ? undefined : yield* readSmall(icon.file, ICON_MAX_BYTES);
    if (type !== undefined && bytes !== undefined) {
      iconDataUrl = `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
    }
  }
  const description = localized(manifest.description, 512);
  const key = asText(manifest.key, 4096);
  const popupPage = safeExtensionPage(action?.default_popup);
  const optionsPage =
    safeExtensionPage(asRecord(manifest.options_ui)?.page) ??
    safeExtensionPage(manifest.options_page);
  const info: ExtensionManifestInfo = {
    name,
    version,
    ...(description === undefined ? {} : { description }),
    ...(key === undefined ? {} : { key }),
    ...(iconDataUrl === undefined ? {} : { iconDataUrl }),
    ...(popupPage === undefined ? {} : { popupPage }),
    ...(optionsPage === undefined ? {} : { optionsPage }),
  };
  return { manifest, info };
});

/**
 * Writes the developer key into an unpacked Web Store extension's manifest, so
 * Chrome gives it its Web Store id: password managers and other extensions
 * that talk to apps or to each other depend on that id.
 */
export const writeManifestKey = Effect.fn("extensionPackage.writeManifestKey")(function* (
  root: string,
  manifest: Record<string, unknown>,
  publicKey: Uint8Array,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .writeFileString(
      path.join(root, "manifest.json"),
      encodeJson({ ...manifest, key: Buffer.from(publicKey).toString("base64") }),
    )
    .pipe(Effect.mapError(storage));
});
