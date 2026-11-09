// @effect-diagnostics nodeBuiltinImport:off - Writes stand-in browser executables for the launch.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { afterAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { chromeIdentity, ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";

const MAC_UA = (version: string) =>
  `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${version} Safari/537.36`;
const MAC = { platform: "darwin", arch: "arm64", platformVersion: "27.0.0" } as const;

/** The Sec-CH-UA header a browser with these brands sends. */
const secChUa = (brands: ReadonlyArray<{ readonly brand: string; readonly version: string }>) =>
  brands.map(({ brand, version }) => `"${brand}";v="${version}"`).join(", ");

describe("chromeIdentity", () => {
  it("takes the full version from the product when the user agent gives only the major", () => {
    // Full Chrome for Testing in new headless mode.
    const identity = chromeIdentity(
      { product: "Chrome/154.0.8037.92", userAgent: MAC_UA("HeadlessChrome/154.0.0.0") },
      MAC,
    );
    expect(identity?.userAgent).toBe(MAC_UA("Chrome/154.0.0.0"));
    expect(identity?.userAgentMetadata).toMatchObject({
      fullVersion: "154.0.8037.92",
      platform: "macOS",
      platformVersion: "27.0.0",
      architecture: "arm",
      bitness: "64",
      formFactors: ["Desktop"],
    });
    expect(secChUa(identity!.userAgentMetadata.fullVersionList)).toBe(
      '"Chromium";v="154.0.8037.92", "Google Chrome";v="154.0.8037.92", "Not A(Brand";v="99.0.0.0"',
    );
  });

  it("still presents a browser launched with Chrome's user agent", () => {
    const userAgent = MAC_UA("Chrome/154.0.0.0");
    const identity = chromeIdentity({ product: "HeadlessChrome/154.0.8037.92", userAgent }, MAC);
    expect(identity?.userAgent).toBe(userAgent);
    expect(secChUa(identity!.userAgentMetadata.brands)).toBe(
      '"Chromium";v="154", "Google Chrome";v="154", "Not A(Brand";v="99"',
    );
  });

  it.each([
    ["120", '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"'],
    ["124", '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"'],
    ["131", '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"'],
  ])("gives Chrome %s's own brands and GREASE", (major, header) => {
    const identity = chromeIdentity(
      { product: `Chrome/${major}.0.0.1`, userAgent: MAC_UA(`HeadlessChrome/${major}.0.0.0`) },
      MAC,
    );
    expect(secChUa(identity!.userAgentMetadata.brands)).toBe(header);
  });
});

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
}));
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);

const fakeContext = () => {
  const events = new NodeEvents.EventEmitter();
  return {
    on: (event: string, listener: () => void) => events.on(event, listener),
    pages: () => [],
    close: async () => {},
  };
};
const newContext = vi.fn(async (_options?: object) => fakeContext());
const fakeBrowser = (version: string) => ({
  ...fakeContext(),
  version: () => version,
  newContext,
});

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tempo-browser-identity-"));
afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
/** An executable that answers `--version` as Chrome does. */
const browserReporting = (name: string, version: string) => {
  const path = NodePath.join(directory, name);
  NodeFS.writeFileSync(path, `#!/bin/sh\necho "${version}"\n`, { mode: 0o755 });
  return path;
};

beforeEach(() => {
  newContext.mockClear();
  launches.launch.mockReset().mockResolvedValue(fakeBrowser("153.0.7000.10") as unknown as Browser);
  launches.persistent.mockReset().mockResolvedValue(fakeContext() as unknown as BrowserContext);
});

describe("ServerBrowserContexts", () => {
  it("presents as a Mac's Chrome, with its GPU and the user agent of the browser each context runs in", async () => {
    const shell = browserReporting("shell", "Google Chrome for Testing 153.0.7000.10");
    const chrome = browserReporting("chrome", "Google Chrome for Testing 154.0.8037.92");
    const pool = new ServerBrowserContexts({
      profilesDir: NodePath.join(directory, "profiles"),
      executable: async () => shell,
      profileLaunch: async () => ({ executablePath: chrome, args: [], ignoreDefaultArgs: [] }),
      platform: "darwin",
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await pool.contextFor("work");
    expect(launches.launch.mock.calls[0]?.[0]?.args).toContain("--enable-gpu");
    expect(launches.launch.mock.calls[0]?.[0]?.args).not.toContain("--disable-gpu");
    expect(newContext.mock.calls[0]?.[0]).toMatchObject({ userAgent: MAC_UA("Chrome/153.0.0.0") });
    // A profile's own browser, not the shared one, decides its version.
    expect(launches.persistent.mock.calls[0]?.[1]).toMatchObject({
      userAgent: MAC_UA("Chrome/154.0.0.0"),
    });
    await pool.close();
  });

  it("keeps Linux on software rendering, and headless Chrome's own user agent when the browser gives no version", async () => {
    const linux = new ServerBrowserContexts({
      profilesDir: NodePath.join(directory, "profiles"),
      executable: async () => browserReporting("silent", ""),
      platform: "linux",
    });
    await linux.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await linux.contextFor("work");
    expect(launches.launch.mock.calls[0]?.[0]?.args).toContain("--disable-gpu");
    expect(newContext.mock.calls[0]?.[0]).toMatchObject({
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36",
    });
    expect(launches.persistent.mock.calls[0]?.[1]).not.toHaveProperty("userAgent");
    await linux.close();
  });
});
