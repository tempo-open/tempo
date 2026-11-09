/**
 * The full Chrome for Testing build, which runs a profile's extensions in new headless mode: T3's
 * pinned headless shell cannot. It installs on first use like the shell, at the same version. To
 * bump it, update each `bytes` and `sha256` below from that version's `chrome-<platform>.zip` in
 * https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../../config.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";

/** Matches the headless shell's pin, so both report the same Chrome to sites and the Web Store. */
export const EXTENSION_BROWSER_VERSION = "156.0.8078.70";

const MAC_EXECUTABLE = "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
const ARCHIVES = {
  linux64: {
    bytes: 201_035_256,
    sha256: "baac330433bb105012b7429ad77d4ba3d4ec3768810008ce9257d5d930c1b0cd",
    executable: "chrome",
  },
  "linux-arm64": {
    bytes: 200_845_435,
    sha256: "46dce94a0790d177927044e83ee7e0f571bc22e90e6fafe21fce5c1e248bc865",
    executable: "chrome",
  },
  "mac-arm64": {
    bytes: 194_910_526,
    sha256: "1070e2acc6fec1b80aac9215c9b83a381334a8c556df941e5146efb816121adb",
    executable: MAC_EXECUTABLE,
  },
  "mac-x64": {
    bytes: 205_543_880,
    sha256: "3218f6e802588632f2f8055b90035b306cad48874daf6067330e0f012afdb7ab",
    executable: MAC_EXECUTABLE,
  },
  win32: {
    bytes: 188_579_460,
    sha256: "853955e981b07b8c44dfc77e658f6bfc806868a74176a44900aecda65ea4c26e",
    executable: "chrome.exe",
  },
  win64: {
    bytes: 209_092_934,
    sha256: "8ab65752ca6106bb8a5bf3afaa710ab4f62a57c27ed39db4977422c929fce0b3",
    executable: "chrome.exe",
  },
} as const;

/** The full build for a host, laid out for the shared installer; null where Chrome for Testing has none. */
export const extensionBrowserRelease = (
  platform: NodeJS.Platform,
  arch: NodeJS.Architecture,
): PreviewBrowser.PreviewBrowserRelease | null => {
  const shell = PreviewBrowser.previewBrowserRelease(platform, arch);
  if (shell === null) return null;
  const chrome = shell.platform as keyof typeof ARCHIVES;
  const archive = ARCHIVES[chrome];
  return {
    version: EXTENSION_BROWSER_VERSION,
    platform: chrome,
    url: `https://storage.googleapis.com/chrome-for-testing-public/${EXTENSION_BROWSER_VERSION}/${chrome}/chrome-${chrome}.zip`,
    bytes: archive.bytes,
    sha256: archive.sha256,
    layout: {
      toolDirectory: "chrome",
      archiveRoot: `chrome-${chrome}/`,
      executable: archive.executable,
    },
  };
};

/** Same shape as PreviewBrowser: `executable` installs on first use and reports progress. */
export class ExtensionBrowser extends Context.Service<
  ExtensionBrowser,
  PreviewBrowser.PreviewBrowser["Service"]
>()("t3/tempo/browser/ExtensionBrowser") {}

export const layer = Layer.effect(
  ExtensionBrowser,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const platform = yield* HostProcess.Platform;
    const arch = yield* HostProcess.Architecture;
    return ExtensionBrowser.of(
      yield* PreviewBrowser.makePreviewBrowser({
        baseDir: config.baseDir,
        release: extensionBrowserRelease(platform, arch),
      }),
    );
  }),
);
