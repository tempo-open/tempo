import * as NodeEvents from "node:events";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import type { BrowserContext, Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../../config.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as Broker from "../../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../../preview/DesktopBrowserChannel.ts";
import * as Manager from "../../preview/Manager.ts";
import * as PreviewAgentActivity from "../../preview/PreviewAgentActivity.ts";
import * as PreviewBrowser from "../../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../../preview/ServerBrowser.ts";
import type { BrowserAuthenticatorTarget } from "./BrowserAuthenticator.ts";
import { UBLOCK_ORIGIN_LITE_ID } from "./BrowserExtensions.ts";
import type { PasswordTabTarget } from "./BrowserPasswords.ts";
import * as TempoBrowser from "./TempoBrowser.ts";

// The server browser's tempo paths with Chromium replaced: one context per
// profile, restarted on request, holding any number of pages.
vi.mock("../../preview/ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      const key = JSON.stringify([profileId, isolationKey ?? null]);
      let context = liveContexts.get(key);
      if (!context) {
        context = makeContext(profileId, this.onClose);
        liveContexts.set(key, context);
        contexts.push(context);
      }
      return context as unknown as BrowserContext;
    }
    async restartProfile(profileId: string) {
      const key = JSON.stringify([profileId, null]);
      const context = liveContexts.get(key);
      liveContexts.delete(key);
      await context?.close();
    }
    async scratchPage() {
      return makeContext("scratch").newPage();
    }
    async connectDesktopPage() {
      throw new Error("No desktop in these tests.");
    }
    async clearProfile() {}
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

/**
 * Script the pages ran, with the page's URL at the time, each passkey lock and
 * restore, each emptying of filled passwords, and each DevTools session the
 * server detached, in order.
 */
const commands: Array<string> = [];
/** The options of each screenshot the pages' DevTools sessions took. */
const captures: Array<unknown> = [];

function makePage(owner: () => unknown) {
  const events = new NodeEvents.EventEmitter();
  let url = "about:blank";
  let viewport = { width: 1280, height: 800 };
  let closed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: owner,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    title: vi.fn(async () => "test page"),
    viewportSize: () => viewport,
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string) => {
      url = next;
      events.emit("load");
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "",
      interactiveElements: [],
    })),
    ariaSnapshot: vi.fn(async () => '- button "go" [ref=e1]'),
    locator: vi.fn(() => {
      throw new Error("Unexpected locator action");
    }),
    mouse: { click: vi.fn(async () => {}) },
    opener: async () => null,
    isClosed: () => closed,
    close: vi.fn(async () => {
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
  return page;
}

type FakePage = ReturnType<typeof makePage>;

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeContext(profileId: string, onClose?: (context: BrowserContext) => void) {
  const events = new NodeEvents.EventEmitter();
  const pages: Array<FakePage> = [];
  let closed = false;
  const context = {
    profileId,
    pages,
    /** A page the browser opened by itself, such as a popup. */
    openPage: () => {
      const page = makePage(() => context);
      pages.push(page);
      return page;
    },
    newPage: async () => context.openPage() as unknown as Page,
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (page: FakePage) => ({
      on: vi.fn(),
      off: vi.fn(),
      detach: vi.fn(async () => {
        commands.push("detach session");
      }),
      send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
        const params = (input ?? {}) as {
          readonly worldName?: string;
          readonly contextId?: number;
          readonly expression?: string;
          readonly format?: string;
          readonly arguments?: ReadonlyArray<{ readonly value: unknown }>;
        };
        // The server's own reads, not scripts an agent runs: snapshots read password fields
        // from an isolated world in each frame, and a new tab probes for Chrome's PDF viewer.
        if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
        if (method === "Page.createIsolatedWorld")
          return { executionContextId: params.worldName === "t3-preview" ? 1 : 7 };
        if (method === "Runtime.evaluate" && params.contextId === 1)
          return { result: { value: [] } };
        if (method === "Runtime.evaluate" && params.expression === "navigator.pdfViewerEnabled")
          return { result: { value: true } };
        if (method === "Runtime.evaluate") commands.push(`${method} ${page.url()}`);
        if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
        if (method === "Page.getLayoutMetrics")
          return { cssVisualViewport: { pageX: 0, pageY: 0 } };
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        if (method === "Page.captureScreenshot") {
          captures.push(input);
          return { data: params.format === "png" ? PNG_HEADER : "ZnJhbWU=" };
        }
        // A screenshot shrinks in the page: the size and JPEG quality it asks for. A snapshot's PNG
        // comes back as the header its size is read from, a thumbnail's JPEG as "frame".
        if (method === "Runtime.callFunctionOn") {
          const shrink = params.arguments?.slice(1).map((argument) => argument.value);
          captures.push({ shrink });
          return { result: { value: shrink?.length === 3 ? "ZnJhbWU=" : PNG_HEADER } };
        }
        return { result: { value: "evaluated" } };
      }),
    }),
    close: vi.fn(async () => {
      if (closed) return;
      closed = true;
      for (const page of pages) await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

const contexts: Array<ReturnType<typeof makeContext>> = [];
const liveContexts = new Map<string, ReturnType<typeof makeContext>>();

/** Each tab the server set saved passkeys up for, and what agents did there. */
interface Attached {
  readonly target: BrowserAuthenticatorTarget;
  touched: boolean;
}
const attached: Array<Attached> = [];
/** Each tab the server set saved passwords up for. */
const passwordTabs: Array<PasswordTabTarget> = [];
const attachWaiters: Array<{ readonly count: number; readonly resolve: () => void }> = [];
/** Resolves once this many tabs have attached. */
const attachedCount = (count: number) =>
  Effect.promise(
    () =>
      new Promise<void>((resolve) => {
        if (attached.length >= count) resolve();
        else attachWaiters.push({ count, resolve });
      }),
  );

class ProfileChanges extends Context.Service<ProfileChanges, PubSub.PubSub<string>>()(
  "t3/tempo/browser/ServerBrowserTempo.test/ProfileChanges",
) {}

const tempoBrowser = Layer.effect(
  TempoBrowser.TempoBrowser,
  Effect.gen(function* () {
    const changes = yield* ProfileChanges;
    const unused = Effect.die("unused in these tests");
    return TempoBrowser.TempoBrowser.of({
      getProfile: () => unused,
      addExtension: () => unused,
      setExtensionEnabled: () => unused,
      removeExtension: () => unused,
      checkExtensionUpdates: () => unused,
      setPasskeySettings: () => unused,
      removePasskey: () => unused,
      setPasswordSettings: () => unused,
      removePassword: () => unused,
      forgetProfile: () => unused,
      profileLaunch: () => Effect.succeed({ args: [], ignoreDefaultArgs: [] }),
      profileLaunchReady: () => Effect.void,
      profileChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      attachTab: (target) =>
        Effect.sync(() => {
          const record: Attached = { target, touched: target.agentTouched };
          const index = attached.push(record) - 1;
          for (const waiter of attachWaiters.splice(0)) {
            if (attached.length >= waiter.count) waiter.resolve();
            else attachWaiters.push(waiter);
          }
          return {
            agentAction: async (run) => {
              record.touched = true;
              commands.push(`lock tab ${index}`);
              return run();
            },
            personNavigation: async (run) => {
              commands.push(`person navigates tab ${index}`);
              return run();
            },
            agentTouched: () => record.touched,
            sessionDetached: () => {
              commands.push(`restore tab ${index}`);
            },
            detach: () => {},
            idle: async () => {},
          };
        }),
      attachPasswords: (target) =>
        Effect.sync(() => {
          const index = passwordTabs.push(target) - 1;
          return {
            beforeAgentAction: async () => {
              commands.push(`empty passwords tab ${index}`);
            },
            detach: () => {},
            idle: async () => {},
          };
        }),
      extensionPageUrl: () => unused,
    });
  }),
).pipe(Layer.provideMerge(Layer.effect(ProfileChanges, PubSub.unbounded<string>())));

const testThread = {
  threadId: ThreadId.make("tempo-browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("tempo-browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "tempo-browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const viewerInput = (tabId: string) => ({
  threadId: testThread.threadId,
  tabId,
  canOperate: true,
  maxWidth: 1280,
  maxHeight: 800,
  quality: 70,
});

const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  tempoBrowser,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: false,
    awaitAttached: () => Effect.succeed(false),
    detached: Stream.empty,
    attached: Stream.empty,
    isAttached: () => Effect.succeed(false),
    endpoint: () => Effect.die("no desktop"),
    pointer: () => Effect.void,
    turn: () => Effect.void,
    agentDrove: () => Effect.void,
  }),
  PreviewAgentActivity.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-tempo-server-browser-" })),
  Layer.provideMerge(NodeServices.layer),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));

const EXTENSION_POPUP = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/popup.html";

/** The first viewer output that tells it how its tab ended. */
const ending = (viewer: ServerBrowser.ServerBrowserViewer) =>
  Effect.gen(function* () {
    for (;;) {
      const item = yield* Queue.take(viewer.output);
      if (item._tag === "reconnect" || item._tag === "gone") return item._tag;
    }
  });

beforeEach(() => {
  contexts.length = 0;
  liveContexts.clear();
  attached.length = 0;
  passwordTabs.length = 0;
  attachWaiters.length = 0;
  commands.length = 0;
  captures.length = 0;
});

it.live("a profile change reopens its tabs at their pages and keeps viewers and agent locks", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      const changes = yield* ProfileChanges;
      yield* Effect.yieldNow;
      yield* browser.reportProfiles({ profiles: [], defaultProfileId: "default" });
      const person = yield* manager.open({
        threadId: testThread.threadId,
        runtime: "server",
        url: "https://example.com/person",
      });
      const viewer = yield* browser.attachViewer(viewerInput(person.tabId));
      const agent = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: "https://example.com/agent", reuseExistingTab: false, show: false },
      });
      const extension = yield* browser.openPage({
        threadId: testThread.threadId,
        profileId: "default",
        url: EXTENSION_POPUP,
      });
      yield* attachedCount(3);
      expect(attached.map((tab) => tab.touched)).toEqual([false, true, false]);
      const before = contexts[0]!;

      yield* PubSub.publish(changes, "default");
      // The viewer is told to reconnect, not that its tab is gone.
      expect(yield* ending(viewer)).toBe("reconnect");
      // Viewers and agents reach the reopened tabs.
      yield* browser.attachViewer(viewerInput(person.tabId));
      yield* browser.attachViewer(viewerInput(extension.tabId));
      yield* broker.invoke({
        scope,
        tabId: PreviewTabId.make(agent.tabId!),
        operation: "snapshot",
        input: {},
      });

      expect(before.close).toHaveBeenCalled();
      const after = contexts[1]!;
      expect(after).not.toBe(before);
      // Every tab comes back at its page, the extension's included.
      const urls = after.pages.flatMap((page) => page.goto.mock.calls.map(([url]) => url));
      expect(urls.toSorted()).toEqual(
        [EXTENSION_POPUP, "https://example.com/agent", "https://example.com/person"].toSorted(),
      );
      // A page an agent had is still its page: its passkeys stay locked.
      const reopened = attached.slice(3).map((tab) => tab.target.agentTouched);
      expect(reopened.toSorted()).toEqual([false, false, true]);
      const sessions = (yield* manager.list({ threadId: testThread.threadId })).sessions;
      expect(sessions.map((session) => session.tabId).toSorted()).toEqual(
        [person.tabId, agent.tabId!, extension.tabId].toSorted(),
      );
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent's action locks its tab and the tabs it can script before it runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const person = yield* manager.open({
        threadId: testThread.threadId,
        runtime: "server",
        url: "https://example.com/opener",
      });
      // Reading waits for the tab to finish opening, and locks nothing.
      yield* broker.invoke({
        scope,
        tabId: PreviewTabId.make(person.tabId),
        operation: "snapshot",
        input: {},
      });
      // The person's page opens a sign-in popup.
      const context = contexts[0]!;
      context.pages[0]!.emit("popup", context.openPage());
      yield* attachedCount(2);
      const popup = (yield* manager.list({ threadId: testThread.threadId })).sessions.find(
        (session) => session.tabId !== person.tabId,
      )!;
      expect(attached.map((tab) => tab.touched)).toEqual([false, false]);

      yield* broker.invoke({
        scope,
        tabId: PreviewTabId.make(popup.tabId),
        operation: "snapshot",
        input: {},
      });
      expect(commands.filter((command) => command.startsWith("lock"))).toEqual([]);

      // Acting in the popup locks it and its opener first.
      yield* broker.invoke({
        scope,
        tabId: PreviewTabId.make(popup.tabId),
        operation: "evaluate",
        input: { expression: "document.title" },
      });
      const evaluated = commands.findIndex((command) => command.startsWith("Runtime.evaluate"));
      expect(evaluated).toBeGreaterThan(-1);
      expect(commands.slice(0, 2).toSorted()).toEqual(["lock tab 0", "lock tab 1"]);
      // Once both pages are the agent's, what was filled in them is emptied, then it acts.
      expect(commands.slice(2, evaluated).toSorted()).toEqual([
        "empty passwords tab 0",
        "empty passwords tab 1",
      ]);
      expect(attached.map((tab) => tab.touched)).toEqual([true, true]);
      // Saved passwords go by the same agent tracking as passkeys.
      expect(passwordTabs.map((tab) => tab.agentTouched())).toEqual([true, true]);
      // Each sees the other as a linked tab holding an agent's page.
      expect(attached.map((tab) => tab.target.linkedTabsTouched())).toEqual([true, true]);

      // A popup either opens later starts locked: their script can reach it.
      context.pages[0]!.emit("popup", context.openPage());
      yield* attachedCount(3);
      expect(attached[2]!.target.agentTouched).toBe(true);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a person's address bar, reload, and history run as their own navigations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const person = yield* manager.open({
        threadId: testThread.threadId,
        runtime: "server",
        url: "https://example.com/person",
      });
      // Each of these claims the tab, as any deliberate input does.
      const viewer = yield* browser.attachViewer(viewerInput(person.tabId));
      yield* viewer.input({ type: "navigate", url: "https://example.com/next" });
      yield* viewer.input({ type: "reload" });
      yield* viewer.input({ type: "history", delta: -1 });
      expect(commands.filter((command) => command.startsWith("person"))).toEqual(
        Array.from({ length: 3 }, () => "person navigates tab 0"),
      );
      const page = contexts[0]!.pages[0]!;
      expect(page.goto).toHaveBeenCalledWith("https://example.com/next", expect.anything());
      expect(page.reload).toHaveBeenCalled();
      expect(page.goBack).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a tab's thumbnail is its view shrunk to the width the overview asks for", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      yield* Effect.yieldNow;
      const person = yield* manager.open({
        threadId: testThread.threadId,
        runtime: "server",
        url: "https://example.com/person",
      });
      // The viewer waits for the tab's page, which the overview never opens itself.
      yield* browser.attachViewer(viewerInput(person.tabId));
      const thumbnail = (tabId: string) =>
        browser.thumbnail({ threadId: testThread.threadId, tabId, maxWidth: 640 });
      expect(yield* thumbnail(person.tabId)).toEqual(Option.some(Buffer.from("frame")));
      // The 1280 px view renders at twice that; its full-size PNG shrinks to a quarter, as a JPEG.
      expect(captures.slice(-2)).toEqual([{ format: "png" }, { shrink: [320, 200, 0.6] }]);
      expect(yield* thumbnail("closed-tab")).toEqual(Option.none());
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a viewer leaving or a recording ending sets the tab's passkeys up again", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      yield* browser.reportProfiles({ profiles: [], defaultProfileId: "default" });
      const person = yield* manager.open({
        threadId: testThread.threadId,
        runtime: "server",
        url: "https://example.com/person",
      });
      // Chrome drops a page's virtual authenticators with any DevTools session that leaves it.
      yield* Effect.scoped(browser.attachViewer(viewerInput(person.tabId)));
      expect(commands).toEqual(["detach session", "restore tab 0"]);

      const agent = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: "https://example.com/agent", reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(agent.tabId!);
      yield* broker.invoke({ scope, tabId, operation: "recordingStart", input: {} });
      commands.length = 0;
      // These pages paint no frames, so the stop fails, after its session has left.
      const stopped = yield* broker
        .invoke<PreviewAutomationStatus>({ scope, tabId, operation: "recordingStop", input: {} })
        .pipe(Effect.flip);
      expect(stopped).toMatchObject({ reason: "The recording captured no frames." });
      expect(commands).toEqual(["detach session", "restore tab 1"]);
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("a profile change leaves an agent's throwaway tab and its popup alone", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const manager = yield* Manager.PreviewManager;
      const broker = yield* Broker.PreviewAutomationBroker;
      const changes = yield* ProfileChanges;
      yield* Effect.yieldNow;
      // With no profiles reported, an agent's tab gets a throwaway browser.
      const agent = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: "https://example.com/agent", reuseExistingTab: false, show: false },
      });
      const throwaway = contexts[0]!;
      throwaway.pages[0]!.emit("popup", throwaway.openPage());
      const popup = (yield* manager.list({ threadId: testThread.threadId })).sessions.find(
        (session) => session.tabId !== agent.tabId,
      )!;
      // Reading the popup waits for its tab to open.
      yield* broker.invoke({
        scope,
        tabId: PreviewTabId.make(popup.tabId),
        operation: "snapshot",
        input: {},
      });
      const person = yield* manager.open({
        threadId: testThread.threadId,
        runtime: "server",
        url: "https://example.com/person",
      });
      const viewer = yield* browser.attachViewer(viewerInput(person.tabId));
      // Only the person's tab, in the default profile's own browser, keeps passkeys and passwords.
      expect(attached).toHaveLength(1);
      expect(passwordTabs.map((tab) => tab.profileId)).toEqual(["default"]);

      yield* PubSub.publish(changes, "default");
      expect(yield* ending(viewer)).toBe("reconnect");
      yield* browser.attachViewer(viewerInput(person.tabId));
      expect(throwaway.close).not.toHaveBeenCalled();
      expect(throwaway.pages.map((page) => page.isClosed())).toEqual([false, false]);
      expect(contexts[1]!.close).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("extension pages open as tabs agents can neither drive nor read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      const opened = yield* browser.openPage({
        threadId: testThread.threadId,
        profileId: "default",
        url: EXTENSION_POPUP,
      });
      expect(contexts[0]!.pages[0]!.goto).toHaveBeenCalledWith(EXTENSION_POPUP, expect.anything());
      for (const operation of ["evaluate", "snapshot"] as const) {
        const refused = yield* broker
          .invoke<PreviewAutomationStatus>({
            scope,
            tabId: PreviewTabId.make(opened.tabId),
            operation,
            input: operation === "evaluate" ? { expression: "chrome.cookies" } : {},
          })
          .pipe(Effect.flip);
        expect(refused).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          reason: "humanControl",
        });
      }
      expect(commands.filter((command) => command.startsWith("Runtime.evaluate"))).toEqual([]);

      // Incognito keeps no extensions.
      const incognito = yield* browser
        .openPage({ threadId: testThread.threadId, profileId: "incognito", url: EXTENSION_POPUP })
        .pipe(Effect.flip);
      expect(incognito._tag).toBe("ServerBrowserLaunchError");
    }),
  ).pipe(Effect.provide(layer)),
);

it.live("an agent can leave uBlock Origin Lite's block page but runs no script there", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* ServerBrowser.ServerBrowser;
      const broker = yield* Broker.PreviewAutomationBroker;
      yield* Effect.yieldNow;
      // The agent's tab runs in the person's profile, where uBlock Origin Lite is.
      yield* browser.reportProfiles({ profiles: [], defaultProfileId: "default" });
      const agent = yield* broker.invoke<PreviewAutomationStatus>({
        scope,
        operation: "open",
        input: { url: "https://example.com/start", reuseExistingTab: false, show: false },
      });
      const tabId = PreviewTabId.make(agent.tabId!);
      const page = contexts[0]!.pages[0]!;
      const refused = { _tag: "PreviewAutomationControlInterruptedError", reason: "humanControl" };

      // A link to a site its lists block outright lands on its warning page.
      yield* Effect.promise(() =>
        page.goto(
          `chrome-extension://${UBLOCK_ORIGIN_LITE_ID}/strictblock.html#https://ads.example/`,
        ),
      );
      const script = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "evaluate",
          input: { expression: "chrome.runtime.id" },
        })
        .pipe(Effect.flip);
      expect(script).toMatchObject(refused);
      expect(commands.filter((command) => command.startsWith("Runtime.evaluate"))).toEqual([]);

      // It reads the warning, presses its buttons, and goes elsewhere.
      yield* broker.invoke({ scope, tabId, operation: "snapshot", input: {} });
      yield* broker.invoke({ scope, tabId, operation: "click", input: { x: 640, y: 400 } });
      expect(page.mouse.click).toHaveBeenCalledWith(640, 400, expect.anything());
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: "https://example.com/elsewhere" },
      });
      expect(page.url()).toBe("https://example.com/elsewhere");

      // Any other extension page still refuses it.
      yield* Effect.promise(() => page.goto(EXTENSION_POPUP));
      const elsewhere = yield* broker
        .invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "navigate",
          input: { url: "https://example.com/" },
        })
        .pipe(Effect.flip);
      expect(elsewhere).toMatchObject(refused);
    }),
  ).pipe(Effect.provide(layer)),
);
