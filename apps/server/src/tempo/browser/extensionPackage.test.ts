import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { TempoBrowserProfileError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  extractExtensionArchive,
  readExtensionManifest,
  safeEntryPath,
  safeExtensionPage,
  writeManifestKey,
} from "./extensionPackage.ts";
import { makeZip, manifestJson, type ZipFixtureEntry } from "./testing/crxFixtures.ts";

const PNG = Buffer.from("89504e470d0a1a0a", "hex");

/** Writes a ZIP of these entries; `unpack` extracts it to `root`. */
const archiveOf = (
  entries: ReadonlyArray<ZipFixtureEntry>,
  limits?: Parameters<typeof extractExtensionArchive>[2],
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extension-package-" });
    const archive = path.join(directory, "archive.zip");
    yield* fs.writeFile(archive, makeZip(entries));
    const root = path.join(directory, "root");
    return { fs, path, directory, root, unpack: extractExtensionArchive(archive, root, limits) };
  });

const reasonOf = <A, R>(effect: Effect.Effect<A, TempoBrowserProfileError, R>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason));

it("rejects entry names that could leave the extension folder", () => {
  expect(safeEntryPath("js/app.js")).toBe("js/app.js");
  expect(safeEntryPath("icons/")).toBe("icons");
  for (const name of [
    "../evil",
    "a/../../evil",
    "/etc/passwd",
    "C:/x",
    "a\\b",
    "a//b",
    "./a",
    "",
  ]) {
    expect(safeEntryPath(name)).toBeNull();
  }
  expect(safeExtensionPage("/popup.html?view=small")).toBe("popup.html?view=small");
  expect(safeExtensionPage("https://evil.example/")).toBeUndefined();
  expect(safeExtensionPage("../options.html")).toBeUndefined();
});

it.layer(NodeServices.layer)("extension packages", (it) => {
  it.effect("unpacks files and folders and drops the Web Store's _metadata", () =>
    Effect.gen(function* () {
      const { fs, path, root, unpack } = yield* archiveOf([
        { name: "manifest.json", data: "{}" },
        { name: "js/", mode: 0o040755 },
        { name: "js/app.js", data: "console.log(1)" },
        { name: "_metadata/verified_contents.json", data: "[]" },
      ]);
      yield* unpack;
      expect(yield* fs.readFileString(path.join(root, "js", "app.js"))).toBe("console.log(1)");
      expect(yield* fs.exists(path.join(root, "_metadata"))).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses traversal, links, and archives past the size caps", () =>
    Effect.gen(function* () {
      const traversal = yield* archiveOf([{ name: "../escape.js", data: "x" }]);
      expect(yield* reasonOf(traversal.unpack)).toBe("invalid_package");
      expect(
        yield* traversal.fs.exists(traversal.path.join(traversal.directory, "escape.js")),
      ).toBe(false);

      const link = yield* archiveOf([{ name: "evil", data: "/etc/passwd", mode: 0o120777 }]);
      expect(yield* reasonOf(link.unpack)).toBe("invalid_package");

      const limits = { maxEntries: 2, maxEntryBytes: 8, maxTotalBytes: 12 };
      const many = yield* archiveOf([{ name: "a" }, { name: "b" }, { name: "c" }], limits);
      expect(yield* reasonOf(many.unpack)).toBe("too_large");
      const big = yield* archiveOf([{ name: "a", data: "123456789" }], limits);
      expect(yield* reasonOf(big.unpack)).toBe("too_large");
      const total = yield* archiveOf(
        [
          { name: "a", data: "1234567" },
          { name: "b", data: "1234567" },
        ],
        limits,
      );
      expect(yield* reasonOf(total.unpack)).toBe("too_large");
    }).pipe(Effect.scoped),
  );

  it.effect("reads a Manifest V3 extension with localized names, icon, and pages", () =>
    Effect.gen(function* () {
      const { fs, path, root, unpack } = yield* archiveOf([
        {
          name: "manifest.json",
          data: manifestJson({
            manifest_version: 3,
            name: "__MSG_appName__",
            version: "8.10.2",
            default_locale: "en",
            icons: { "16": "icon16.png", "128": "icon128.png" },
            action: { default_popup: "popup/index.html" },
            options_ui: { page: "options.html" },
          }),
        },
        {
          name: "_locales/en/messages.json",
          data: manifestJson({ appName: { message: "Vault" } }),
        },
        { name: "icon16.png", data: PNG },
        { name: "icon128.png", data: PNG },
      ]);
      yield* unpack;
      const { manifest, info } = yield* readExtensionManifest(root);
      expect(info).toEqual({
        name: "Vault",
        version: "8.10.2",
        iconDataUrl: `data:image/png;base64,${PNG.toString("base64")}`,
        popupPage: "popup/index.html",
        optionsPage: "options.html",
      });

      yield* writeManifestKey(root, manifest, new Uint8Array([1, 2, 3]));
      const rewritten = yield* readExtensionManifest(root);
      expect(rewritten.info.key).toBe("AQID");
      expect(yield* fs.exists(path.join(root, "manifest.json"))).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses Manifest V2 and nameless extensions", () =>
    Effect.gen(function* () {
      const v2 = yield* archiveOf([
        {
          name: "manifest.json",
          data: manifestJson({ manifest_version: 2, name: "Old", version: "1" }),
        },
      ]);
      yield* v2.unpack;
      expect(yield* reasonOf(readExtensionManifest(v2.root))).toBe("unsupported_manifest");
      const nameless = yield* archiveOf([
        { name: "manifest.json", data: manifestJson({ manifest_version: 3, version: "1" }) },
      ]);
      yield* nameless.unpack;
      expect(yield* reasonOf(readExtensionManifest(nameless.root))).toBe("unsupported_manifest");
    }).pipe(Effect.scoped),
  );
});
