// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns Playwright resources outside the Effect runtime (tempo: and times the shared browser's idle close).
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

/** tempo: how long the shared browser stays up after its last context closes, for the next tab. */
const SHARED_BROWSER_IDLE_MS = 5 * 60_000;

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
  /**
   * What a persistent profile's launch adds, such as its extensions and a
   * browser that runs them. tempo: it also gets the profile's folder, to ready what
   * the extensions keep there before the browser starts.
   */
  readonly profileLaunch?: (
    profileId: string,
    directory: string,
  ) => Promise<{
    readonly executablePath?: string;
    readonly args: ReadonlyArray<string>;
    readonly ignoreDefaultArgs: ReadonlyArray<string>;
  }>;
  /** tempo: the host OS, for its GPU and Chrome's user agent; without it, launches keep neither. */
  readonly platform?: NodeJS.Platform;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

// tempo: what a person's Chrome tells sites. Its reduced user agent freezes the OS part.
const UA_OS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "Macintosh; Intel Mac OS X 10_15_7",
  linux: "X11; Linux x86_64",
  win32: "Windows NT 10.0; Win64; x64",
};

/**
 * Chrome's user agent as a context option, which Playwright gives every frame before it runs; a
 * page's own override misses cross-site frames, where Cloudflare's challenge saw "HeadlessChrome".
 * Chrome's `--user-agent` would also reach service workers, but Playwright then takes the browser
 * for a headful one and pads its window, and so every screencast frame.
 */
const chromeUserAgent = (platform: NodeJS.Platform, version: string | undefined) => {
  const os = UA_OS[platform];
  const major = /^\d+/.exec(version ?? "")?.[0];
  return os && major
    ? {
        userAgent: `Mozilla/5.0 (${os}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
      }
    : {};
};

/** The version an executable reports, such as 154.0.8037.92, before it launches. */
const executableVersion = (executablePath: string) =>
  new Promise<string | undefined>((resolve) => {
    NodeChildProcess.execFile(executablePath, ["--version"], { timeout: 5_000 }, (error, stdout) =>
      resolve(error ? undefined : /\b\d+\.\d+\.\d+\.\d+\b/.exec(stdout)?.[0]),
    );
  });

/** As Chrome reports it: macOS's own version rather than Darwin's, or the Linux kernel's. */
const platformVersion = async (platform: NodeJS.Platform) => {
  const release =
    platform === "darwin"
      ? await NodeFSP.readFile("/System/Library/CoreServices/SystemVersion.plist", "utf8").then(
          (plist) => /<key>ProductVersion<\/key>\s*<string>([^<]*)</.exec(plist)?.[1],
          () => undefined,
        )
      : platform === "linux"
        ? NodeOS.release()
        : undefined;
  const parts = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(release ?? "");
  return parts ? `${parts[1]}.${parts[2] ?? 0}.${parts[3] ?? 0}` : "";
};

const GREASE = [" ", "(", ":", "-", ".", "/", ")", ";", "=", "?", "_"];
/** Chrome's order of [GREASE, Chromium, Google Chrome], by major version mod 6. */
const BRAND_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [2, 0, 1],
  [1, 2, 0],
  [2, 1, 0],
] as const;

/**
 * Change user agent and Sec-CH-UA together; sites block mismatches. tempo: the version is the
 * product's (Chrome for Testing's user agent gives only the major), and the brands follow
 * Chrome's order and GREASE for that major (components/embedder_support/user_agent_utils.cc).
 */
export const chromeIdentity = (
  browser: { readonly product: string; readonly userAgent: string },
  host: {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
    readonly platformVersion: string;
  },
) => {
  const version = /\/((\d+)[\d.]*)$/.exec(browser.product);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!fullVersion || !major) return null;
  const seed = Number(major);
  const greased = ["8", "99", "24"][seed % 3]!;
  const brands = (chrome: string, grease: string) => {
    const named = [
      { brand: `Not${GREASE[seed % 11]}A${GREASE[(seed + 1) % 11]}Brand`, version: grease },
      { brand: "Chromium", version: chrome },
      { brand: "Google Chrome", version: chrome },
    ];
    return BRAND_ORDERS[seed % 6]!.map((index) => named[index]!);
  };
  return {
    userAgent: browser.userAgent.replace(/HeadlessChrome\/[\d.]+/, `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands(major, greased),
      fullVersionList: brands(fullVersion, `${greased}.0.0.0`),
      fullVersion,
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platformVersion,
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
      formFactors: ["Desktop"],
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const browser = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(browser, {
    ...host,
    platformVersion: await platformVersion(host.platform),
  });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
  // tempo: clipboard writes, leaving every other permission at Chrome's default;
  // Playwright's `grantPermissions` denied the rest. The headless shell already
  // reports notifications denied, so their permission must say so too.
  const { browserContextId } = (await cdp.send("Target.getTargetInfo")).targetInfo;
  const permit = (name: string, setting: "granted" | "denied") =>
    cdp.send("Browser.setPermission", {
      permission: { name },
      setting,
      ...(browserContextId === undefined ? {} : { browserContextId }),
    });
  await permit("clipboard-write", "granted");
  if (browser.product.startsWith("HeadlessChrome/")) await permit("notifications", "denied");
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private closing: Promise<void> | undefined;
  // tempo: the shared browser closes SHARED_BROWSER_IDLE_MS after its last context does,
  // and the next tab waits for that close before launching it again.
  private readonly sharedContexts = new Set<BrowserContext>();
  private sharedIdleTimer: ReturnType<typeof setTimeout> | undefined;
  private sharedClosing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executablePath = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executablePath,
      env,
      args: [
        // tempo: a Mac's own GPU; no Mac's Chrome reports SwiftShader for WebGL.
        this.options.platform === "darwin" ? "--enable-gpu" : "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(options: { readonly executablePath: string }, start: () => Promise<A>) {
    try {
      return await start();
    } catch (cause) {
      throw (await this.options.diagnose?.(options.executablePath, cause)) ?? cause;
    }
  }

  private sharedBrowser() {
    // tempo: a context is about to open in it, so a pending idle close counts from now.
    if (this.sharedIdleTimer !== undefined) this.closeSharedWhenIdle();
    if (!this.browser) {
      const closing = this.sharedClosing;
      const ready = closing ? closing.then(() => this.launchOptions()) : this.launchOptions();
      const launched = ready.then(async (options) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(options, () => chromium.launch(options));
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  /** tempo: counts a context of the shared browser toward keeping it up. */
  private trackShared(context: BrowserContext) {
    this.sharedContexts.add(context);
    clearTimeout(this.sharedIdleTimer);
    this.sharedIdleTimer = undefined;
    context.on("close", () => {
      this.sharedContexts.delete(context);
      if (this.sharedContexts.size === 0) this.closeSharedWhenIdle();
    });
  }

  /** tempo: closes the shared browser once it has had no context for SHARED_BROWSER_IDLE_MS. */
  private closeSharedWhenIdle() {
    clearTimeout(this.sharedIdleTimer);
    this.sharedIdleTimer = undefined;
    const browser = this.browser;
    if (!browser || this.closing) return;
    this.sharedIdleTimer = setTimeout(() => {
      this.sharedIdleTimer = undefined;
      if (this.browser !== browser || this.sharedContexts.size > 0 || this.closing) return;
      this.browser = undefined;
      const closing = browser.then((idle) => idle.close()).then(constVoid, constVoid);
      this.sharedClosing = closing;
      void closing.then(() => {
        if (this.sharedClosing === closing) this.sharedClosing = undefined;
      });
    }, SHARED_BROWSER_IDLE_MS);
    this.sharedIdleTimer.unref();
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    const { platform } = this.options;
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      // tempo: Chrome's user agent in every frame; see `chromeUserAgent`.
      const userAgent = platform && chromeUserAgent(platform, browser.version());
      const context = await browser.newContext({ ...contextOptions, ...userAgent });
      this.trackShared(context); // tempo: keeps the shared browser up while it is open.
      return context;
    }
    const directory = this.profileDirectory(profileId);
    const defaults = await this.launchOptions();
    // tempo: the hook may change what the profile keeps in its folder; the browser is not running yet.
    const extra = await this.options.profileLaunch?.(profileId, directory);
    const options = extra
      ? {
          ...defaults,
          executablePath: extra.executablePath ?? defaults.executablePath,
          args: [...defaults.args, ...extra.args],
          ignoreDefaultArgs: [...defaults.ignoreDefaultArgs, ...extra.ignoreDefaultArgs],
        }
      : defaults;
    const { chromium } = loadPlaywright();
    await NodeFSP.mkdir(directory, { recursive: true });
    // tempo: the version of the browser this profile runs, which may not be the shared one.
    const userAgent =
      platform && chromeUserAgent(platform, await executableVersion(options.executablePath));
    return this.launch(options, () =>
      chromium.launchPersistentContext(directory, { ...options, ...contextOptions, ...userAgent }),
    );
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    this.trackShared(context); // tempo: keeps the shared browser up while it is open.
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  /**
   * Closes a human profile's persistent context, keeping its storage, so the
   * next tab relaunches it with the profile's current launch settings. Tabs
   * that open meanwhile wait for the relaunch.
   */
  async restartProfile(profileId: string) {
    const key = JSON.stringify([profileId, null]);
    const pending = this.contexts.get(key);
    if (!pending) return;
    this.contexts.delete(key);
    const closing = pending.then(
      (context) => context.close(),
      () => undefined,
    );
    this.clearing.set(key, closing);
    try {
      await closing;
    } finally {
      if (this.clearing.get(key) === closing) this.clearing.delete(key);
    }
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [...this.contexts.values()].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    // tempo: an idle close still running finishes too.
    clearTimeout(this.sharedIdleTimer);
    await this.sharedClosing;
    this.contexts.clear();
  }
}
