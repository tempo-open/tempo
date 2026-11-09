// @effect-diagnostics nodeBuiltinImport:off - The fixture hashes its archive like the pinned table does.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NodeCrypto from "node:crypto";

import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import { extensionBrowserRelease } from "./ExtensionBrowser.ts";
import { makeZip, type ZipFixtureEntry } from "./testing/crxFixtures.ts";

const LAYOUT = {
  toolDirectory: "chrome",
  archiveRoot: "chrome-fixture/",
  executable: "Chrome.app/Contents/MacOS/Chrome",
};

const install = (entries: ReadonlyArray<ZipFixtureEntry>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extension-browser-" });
    const archive = makeZip(entries);
    const browser = yield* PreviewBrowser.makePreviewBrowser({
      baseDir,
      release: {
        version: "9.9.9",
        platform: "fixture",
        url: "https://storage.googleapis.com/chrome-fixture.zip",
        bytes: archive.byteLength,
        sha256: NodeCrypto.createHash("sha256").update(archive).digest("hex"),
        layout: LAYOUT,
      },
    }).pipe(
      Effect.provideService(HostProcess.Platform, "darwin"),
      Effect.provideService(HostProcess.Architecture, "arm64"),
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(archive))),
        ),
      ),
    );
    return { baseDir, executable: yield* Effect.exit(browser.executable) };
  });

describe("extensionBrowserRelease", () => {
  it("pins full Chrome for Testing beside the headless shell, at the same version", () => {
    const release = extensionBrowserRelease("darwin", "arm64");
    const shell = PreviewBrowser.previewBrowserRelease("darwin", "arm64");
    expect(release).toMatchObject({
      version: shell?.version,
      platform: "mac-arm64",
      url: `https://storage.googleapis.com/chrome-for-testing-public/${shell?.version}/mac-arm64/chrome-mac-arm64.zip`,
      layout: {
        toolDirectory: "chrome",
        archiveRoot: "chrome-mac-arm64/",
        executable: "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      },
    });
    expect(release?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(extensionBrowserRelease("linux", "x64")?.layout?.executable).toBe("chrome");
    expect(extensionBrowserRelease("win32", "x64")?.layout?.executable).toBe("chrome.exe");
    expect(extensionBrowserRelease("freebsd", "x64")).toBeNull();
  });
});

it.layer(NodeServices.layer)("full Chrome install", (it) => {
  it.effect("installs an app bundle with its framework links", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { baseDir, executable } = yield* install([
        { name: "chrome-fixture/Chrome.app/Contents/MacOS/Chrome", data: "#!", mode: 0o100755 },
        {
          name: "chrome-fixture/Chrome.app/Contents/Frameworks/F.framework/Versions/A/F",
          data: "lib",
        },
        {
          name: "chrome-fixture/Chrome.app/Contents/Frameworks/F.framework/Versions/Current",
          data: "A",
          mode: 0o120777,
        },
      ]);
      const expected = path.join(
        baseDir,
        "tools",
        "chrome",
        "fixture",
        "9.9.9",
        "Chrome.app",
        "Contents",
        "MacOS",
        "Chrome",
      );
      expect(executable).toMatchObject({ _tag: "Success", value: expected });
      const linked = path.join(
        baseDir,
        "tools/chrome/fixture/9.9.9/Chrome.app/Contents/Frameworks/F.framework/Versions/Current/F",
      );
      expect(yield* fs.readFileString(linked)).toBe("lib");
    }).pipe(Effect.scoped),
  );

  it.effect("refuses links that leave the install", () =>
    Effect.gen(function* () {
      for (const target of ["../../../../escape", "/etc"]) {
        const { executable } = yield* install([
          { name: "chrome-fixture/Chrome.app/Contents/MacOS/Chrome", data: "#!", mode: 0o100755 },
          { name: "chrome-fixture/evil", data: target, mode: 0o120777 },
        ]);
        expect(executable._tag).toBe("Failure");
      }
    }).pipe(Effect.scoped),
  );
});
