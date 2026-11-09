// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.
// Screencasts ignore emulated device scale; real 2x keeps captures sharp.
// --disable-gpu uses cheaper software compositing while preserving SwiftShader WebGL.
import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_BROWSER_RECORDING_FRAME_RATE,
  FILL_PREVIEW_VIEWPORT,
  findBrowserProfile,
  INCOGNITO_BROWSER_PROFILE_ID,
  resolveBrowserProfiles,
  type BrowserProfile,
  type PreviewReportProfilesInput,
  PREVIEW_AUTOMATION_SERVER_OPERATIONS,
  PreviewViewportSetting as PreviewViewportSettingSchema,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationActionEvent,
  type PreviewAutomationClickInput,
  type PreviewAutomationDialogInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationOpenInput,
  type PreviewAutomationPressInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationStatus,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
  PreviewClearProfileError,
  type PreviewEvent,
  type PreviewNavStatus,
  type PreviewSessionSnapshot,
  type PreviewViewportSetting,
  ThreadId,
  SERVER_BROWSER_AUTOMATION_CLIENT_ID,
  type PreviewAppearancePreference,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
// tempo: the server browser is always controllable.
import { claimsBrowserControl } from "@t3tools/shared/tempoBrowserControl";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { constVoid } from "effect/Function";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type {
  BrowserContext,
  CDPSession,
  Dialog,
  Download,
  FileChooser,
  Frame,
  Page,
} from "playwright-core";

import { PENDING_ATTACHMENT_THREAD_SEGMENT } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { resolveRootCliCommand } from "../cli/invocation.ts";
import type { BrowserAuthenticatorSession } from "../tempo/browser/BrowserAuthenticator.ts";
import type { PasswordTab } from "../tempo/browser/BrowserPasswords.ts";
import { agentMayUsePage } from "../tempo/browser/agentExtensionPages.ts";
import * as TempoBrowser from "../tempo/browser/TempoBrowser.ts";
import {
  STILL_LEVEL,
  STREAM_LEVELS,
  StreamLink,
  type ViewerLink,
} from "../tempo/browser/streamLink.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopBrowserChannel from "./DesktopBrowserChannel.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";
import * as PreviewBrowserHost from "./PreviewBrowserHost.ts";
import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";
import { BrowserControlInterrupted, humanControlError, SessionControl } from "./SessionControl.ts";
import { installPdfDocumentNavigation, isPdfAssetUrl } from "./PdfDocumentNavigation.ts";

const SERVER_HOST_CLIENT_ID = SERVER_BROWSER_AUTOMATION_CLIENT_ID;
const RENDER_SCALE = 2;
// tempo: frame acks are paced by the viewer's link (StreamLink.frameIntervalMs).
const SCREENCAST_SETTLE_MS = 200;
const SCREENCAST_MOTION_FRAMES = 4;
const SCREENCAST_MOTION_WINDOW_MS = 300;
const SCREENCAST_MOTION_QUALITY = 50;
// tempo: frames within the motion window that make a page on a measured link count as moving.
const MEASURED_MOTION_FRAMES = 2;
// tempo: how long a due frame may take before the screencast restarts, and how often in a row.
// A resized view often repaints for nothing Chromium captures, so its frame is due sooner.
const FRAME_DUE_MS = 1_000;
const RESIZED_FRAME_DUE_MS = 150;
const FRAME_DUE_RESTARTS = 2;
// tempo: Chromium sends no screencast frame while this many wait for acks.
const CHROMIUM_FRAMES_IN_FLIGHT = 3;
// tempo: viewer input that drops a measured link's screencast to the link's level.
const POINTER_AND_KEY_INPUT: ReadonlySet<string> = new Set(["mouse", "wheel", "key", "text"]);
const HOST_RECONNECT_DELAY = "1 second";
const DESKTOP_ATTACH_TIMEOUT = "10 seconds";
const VIEWER_OUTPUT_LIMIT = 64;
const RECORDING_SCREENCAST = { format: "jpeg", quality: 90, everyNthFrame: 1 } as const;
const decodeViewportSetting = Schema.decodeUnknownSync(PreviewViewportSettingSchema);
const AGENT_CURSOR_MOVE_MS = 160;
const AGENT_CURSOR_CLICK_LEAD_MS = 40;

const sleepUntil = (deadline: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, deadline - Date.now())));

const EDITABLE_AT_POINT_SCRIPT = `(x, y) => {
  let element = document.elementFromPoint(x, y);
  while (element && element.shadowRoot) {
    const inner = element.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === element) break;
    element = inner;
  }
  if (element && element.tagName === "LABEL" && element.control) element = element.control;
  if (!element) return false;
  if (element.tagName === "IFRAME" || element.tagName === "FRAME") return true;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return !element.disabled && !element.readOnly;
  if (element.tagName !== "INPUT") return false;
  const nonText = ["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"];
  return !nonText.includes(element.type) && !element.disabled && !element.readOnly;
}`;
const UNATTACHED_FILL_VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 15_000;
const VIEWER_NAVIGATION_OPTIONS = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
const ACTION_TIMELINE_LIMIT = 50;

export class ServerBrowserTabNotFoundError extends Schema.TaggedError<ServerBrowserTabNotFoundError>()(
  "ServerBrowserTabNotFoundError",
  { threadId: Schema.String, tabId: Schema.String },
) {
  override get message(): string {
    return "The server preview tab does not exist.";
  }
}

const isTabNotFound = Schema.is(ServerBrowserTabNotFoundError);
const isHostSetupError = Schema.is(
  Schema.Union([
    PreviewBrowserHost.PreviewBrowserSandboxError,
    PreviewBrowserHost.PreviewBrowserLibrariesError,
    PreviewBrowserHost.PreviewBrowserRootError,
  ]),
);

export class ServerBrowserLaunchError extends Schema.TaggedError<ServerBrowserLaunchError>()(
  "ServerBrowserLaunchError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The server preview browser could not start.";
  }
}

export type ServerBrowserViewerOutput =
  | {
      readonly _tag: "frame";
      readonly data: Uint8Array;
      readonly ack: Effect.Effect<void>;
      /** tempo: the CSS size the frame shows, from Chromium's capture; viewers map pointers through it. */
      readonly page?: { readonly width: number; readonly height: number };
      /** tempo: the `STREAM_LEVELS` entry it was captured at. */
      readonly level?: number;
    }
  | { readonly _tag: "viewport"; readonly width: number; readonly height: number }
  | {
      readonly _tag: "control";
      readonly canOperate: boolean;
      readonly controller: "agent" | "you" | "another-viewer" | "unclaimed";
      readonly generation: number;
      readonly dialog: {
        readonly type: string;
        readonly message: string;
        readonly defaultValue: string;
      } | null;
    }
  | {
      readonly _tag: "probe";
      readonly x: number;
      readonly y: number;
      readonly editable: boolean;
    }
  | { readonly _tag: "clipboard"; readonly text: string }
  | {
      readonly _tag: "pointer";
      readonly phase: "move" | "click";
      readonly x: number;
      readonly y: number;
      readonly sequence: number;
    }
  | {
      readonly _tag: "fileChooser";
      readonly id: string;
      readonly multiple: boolean;
      readonly accept: string;
    }
  | { readonly _tag: "fileChooserClosed"; readonly id: string }
  | { readonly _tag: "popup"; readonly tabId: string }
  | {
      readonly _tag: "download";
      readonly id: string;
      readonly fileName: string;
      readonly sizeBytes: number;
    }
  | { readonly _tag: "gone" }
  | { readonly _tag: "reconnect" };

export interface ServerBrowserViewer {
  readonly output: Queue.Dequeue<ServerBrowserViewerOutput>;
  readonly input: (message: unknown) => Effect.Effect<void>;
  /** tempo: the viewer's link, measured by its frame acks; it sizes and paces the frames. */
  readonly link?: ViewerLink;
}

export class ServerBrowser extends Context.Service<
  ServerBrowser,
  {
    readonly attachViewer: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
      readonly maxHeight: number;
      readonly quality: number;
      readonly canOperate: boolean;
      /** tempo: the viewer's client session; passkeys reach the laptop of whoever holds the tab. */
      readonly sessionId?: string | undefined;
    }) => Effect.Effect<
      ServerBrowserViewer,
      ServerBrowserTabNotFoundError | ServerBrowserLaunchError,
      Scope.Scope
    >;

    readonly answerFileChooser: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly chooserId: string;
      readonly files: ReadonlyArray<{
        readonly name: string;
        readonly mimeType: string;
        readonly buffer: Buffer;
      }>;
    }) => Effect.Effect<boolean>;
    readonly openDownload: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly downloadId: string;
    }) => Effect.Effect<Option.Option<{ readonly path: string; readonly fileName: string }>>;
    /** tempo: a still of the tab's view, for the phone's tab overview; none once the tab is gone. */
    readonly thumbnail: (input: {
      readonly threadId: string;
      readonly tabId: string;
      readonly maxWidth: number;
    }) => Effect.Effect<Option.Option<Uint8Array>>;

    readonly clearProfile: (profileId: string) => Effect.Effect<void, PreviewClearProfileError>;

    readonly reportProfiles: (input: PreviewReportProfilesInput) => Effect.Effect<void>;
    /**
     * Opens a page the server navigates itself, such as an extension's popup,
     * as a new tab of a persistent profile.
     */
    readonly openPage: (input: {
      readonly threadId: ThreadId;
      readonly profileId: string;
      readonly url: string;
    }) => Effect.Effect<{ readonly tabId: string }, ServerBrowserLaunchError>;
  }
>()("t3/preview/ServerBrowser") {}

interface ViewerState {
  readonly id: string;
  readonly canOperate: boolean;
  /** tempo: the client session the viewer connected with. */
  readonly sessionId: string | undefined;
  readonly pressedKeys: Map<string, { key: string; code: string }>;
  readonly pressedButtons: Map<"left" | "middle" | "right", { x: number; y: number }>;
  readonly push: (output: ServerBrowserViewerOutput) => void;
  readonly pause: () => Promise<void>;
  readonly resume: () => Promise<void>;
  /** tempo: lets go of the keys and buttons the viewer holds, once it loses the tab. */
  readonly releaseInput: () => Promise<void>;
  /** tempo: a frame should follow within `dueMs`, as after the tab's view changed size; else the screencast restarts. */
  readonly expectFrame: (dueMs: number) => void;
  scrolledAt: number;
  /** tempo: when the viewer last sent input; an extension's page opens beside the tab used last. */
  inputAt: number;

  requestedSize: { width: number; height: number; order: number } | null;
}

interface EncoderWindow {
  __t3Recorder: {
    cursor(x: number, y: number, click: boolean): void;
    frame(data: string, width: number): Promise<boolean>;
    stop(): Promise<{ mimeType: string | null; count: number; bytes: number }>;
    chunk(index: number): Promise<string>;
  };
}

interface Recording {
  readonly encoder: Page;
  readonly session: CDPSession;
  readonly startedAt: string;
  readonly framesInFlight: Set<Promise<void>>;
}

interface ServerTab {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly frameSessions: Map<Frame, CDPSession>;
  readonly createdAt: number;
  usedAt: number;
  readonly viewers: Set<ViewerState>;
  readonly consoleEntries: Array<PreviewAutomationConsoleEntry>;
  readonly networkEntries: Array<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: Array<PreviewAutomationActionEvent>;
  readonly control: SessionControl;
  agentOperating: boolean;
  fileChooserIntercepted: boolean;
  readonly onFileChooser: (chooser: FileChooser) => void;

  readonly isolatedContext: boolean;

  readonly desktop: { readonly close: () => Promise<void> } | null;
  readonly profileId: string | undefined;
  readonly openerTabId: string | undefined;

  readonly downloads: Array<ServerDownload>;
  fileChooser: {
    readonly id: string;
    readonly chooser: FileChooser;
    readonly accept: string;
    readonly offeredTo: string | null;
  } | null;
  dialog: Dialog | null;
  setting: PreviewViewportSetting;
  colorScheme: PreviewAppearancePreference;
  zoomFactor: number;
  loading: boolean;
  closing: boolean;
  recording: Recording | null;
  initialNavigation: Promise<void> | null;
  navigationGeneration: number;

  abortedNavigation: {
    readonly url: string;
    readonly generation: number;
    readonly timer: ReturnType<typeof setTimeout>;
  } | null;

  recordingStart: Promise<Recording> | null;
  captureLock: Promise<void>;
  /** tempo: the tab's passkey authenticator, if its profile keeps passkeys. */
  passkeys: BrowserAuthenticatorSession | null;
  /** tempo: saves and fills the tab's passwords, if its profile keeps data. */
  passwords: PasswordTab | null;
  capturing: number;
  /** tempo: whether a pin of the tab's view to its layout size is on its way (`pinViewport`). */
  pinning: boolean;
}

interface ServerDownload {
  readonly id: string;
  readonly fileName: string;
  readonly path: string;
  readonly sizeBytes: number;
  readonly url: string;
  readonly completedAt: string;
}

/** Read-only operations remain available during human control; evaluate requires control because scripts can mutate the page. */
const READ_OPERATIONS: ReadonlySet<PreviewAutomationRequest["operation"]> = new Set([
  "status",
  "snapshot",
  "waitFor",
]);

// tempo: no cap on open tabs (upstream allows 8 per agent session, 32 per server); the idle
// sweep below still closes agent tabs nobody has used or watched for 30 minutes.
const AGENT_TAB_LIMIT = Number.POSITIVE_INFINITY;
const SERVER_TAB_LIMIT = Number.POSITIVE_INFINITY;
const AGENT_TAB_IDLE_MS = 30 * 60 * 1000;
const IDLE_SWEEP_INTERVAL = "1 minute";

const DOWNLOAD_LIMIT = 20;
const ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS = 5_000;
const DOWNLOAD_MAX_BYTES = 1024 * 1024 * 1024;

const tabKey = (threadId: string, tabId: string) => `${threadId}\u0000${tabId}`;

/** tempo: how long a new page has to be claimed by the server before it counts as an extension's. */
const UNCLAIMED_PAGE_GRACE_MS = 1_000;
/** tempo: agents never drive an extension's own pages, but may leave uBlock Origin Lite's block page. */
const refusesAgent = (
  tab: { readonly page: Page },
  operation: PreviewAutomationRequest["operation"],
) => !agentMayUsePage(tab.page.url(), operation);

const pushBounded = <A>(
  buffer: Array<A>,
  entry: A,
  limit = ServerBrowserPage.DIAGNOSTIC_BUFFER_LIMIT,
) => {
  buffer.push(entry);
  if (buffer.length > limit) buffer.splice(0, buffer.length - limit);
};

const viewportSettingsEqual = (left: PreviewViewportSetting, right: PreviewViewportSetting) =>
  left._tag === right._tag &&
  (left._tag === "fill" ||
    (right._tag !== "fill" && left.width === right.width && left.height === right.height));

const fixedViewportSize = (setting: PreviewViewportSetting) =>
  setting._tag === "fill" ? null : { width: setting.width, height: setting.height };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;

const num = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;

const modifiersOf = (message: Record<string, unknown>) => {
  const value = num(message.modifiers);
  return Number.isInteger(value) && value >= 0 && value < 16 ? value : 0;
};

// Linux/headless Chromium needs commands for Cmd editing shortcuts and Ctrl copy/cut.
const editingCommand = (key: string, modifiers: number) => {
  const modifier = modifiers & 0b0111;
  if (modifier !== 2 && modifier !== 4) return null;
  const lower = key.toLowerCase();
  const command =
    lower === "c"
      ? "copy"
      : lower === "x"
        ? "cut"
        : modifier !== 4
          ? null
          : lower === "a"
            ? "selectAll"
            : lower === "z"
              ? modifiers & 8
                ? "redo"
                : "undo"
              : null;
  return command ? { commands: [command] } : null;
};

const CLIPBOARD_TEXT_LIMIT = 1024 * 1024;
const CLIPBOARD_WORLD = "t3-preview-clipboard";
// Chromium shares its clipboard across contexts; capture real copy/cut keys in a page-inaccessible world instead.
const CLIPBOARD_SCRIPT = `(() => {
  let keying = false;
  let copied = "";
  // The same Ctrl or Cmd + C or X that editingCommand sends as copy or cut.
  addEventListener("keydown", (event) => {
    if (!event.isTrusted || event.altKey || event.ctrlKey === event.metaKey) return;
    const key = event.key.toLowerCase();
    if (key !== "c" && key !== "x") return;
    keying = true;
    copied = "";
    setTimeout(() => { keying = false; });
  }, true);
  const selection = () => {
    let field = document.activeElement;
    while (field?.shadowRoot?.activeElement) field = field.shadowRoot.activeElement;
    if ((field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) && field.selectionStart !== null)
      return field.value.slice(field.selectionStart, field.selectionEnd ?? field.selectionStart);
    return String(document.getSelection() ?? "");
  };
  const record = (text) => {
    copied = String(text ?? "").slice(0, ${CLIPBOARD_TEXT_LIMIT});
  };
  // Capturing at window runs before page handlers can stop the event, and
  // before cut removes the selection.
  const snapshot = (event) => {
    if (keying && event.isTrusted) record(selection());
  };
  // Bubbling back to window picks up text a page handler set instead.
  const replace = (event) => {
    if (keying && event.isTrusted && event.defaultPrevented) record(event.clipboardData?.getData("text/plain"));
  };
  for (const type of ["copy", "cut"]) {
    addEventListener(type, snapshot, true);
    addEventListener(type, replace);
  }
  globalThis.takeCopy = () => {
    const text = copied;
    copied = "";
    return text;
  };
})();`;

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const previewBrowser = yield* PreviewBrowser.PreviewBrowser;
  const desktopChannel = yield* DesktopBrowserChannel.DesktopBrowserChannel;
  const agentTurns = yield* (yield* PreviewAgentActivity.PreviewAgentActivity).changes;
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
  const launchServices = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner>();
  // tempo: extensions and saved passkeys, when the server provides them.
  const tempoBrowser = Option.getOrUndefined(
    yield* Effect.serviceOption(TempoBrowser.TempoBrowser),
  );
  const setupCommand = yield* resolveRootCliCommand(PreviewBrowserHost.SETUP_SUBCOMMAND);

  const tabs = new Map<string, ServerTab>();
  const pendingTabs = new Map<string, Promise<ServerTab>>();

  const closedPendingTabs = new Set<string>();
  const adoptedPages = new Map<
    string,
    {
      readonly page: Page;
      readonly openerTabId: string | undefined;
      /** tempo: null when the page may not reach saved passkeys; else whether an agent was behind it. */
      readonly passkeys: { readonly agentTouched: boolean } | null;
    }
  >();
  /** tempo: pages the server opened or adopted; a page nobody claims was opened by an extension. */
  const claimedPages = new WeakSet<Page>();
  /** Tabs reopening after their profile's browser restarts; their viewers reconnect. */
  const restartingTabs = new Set<string>();
  /** tempo: whether an agent was behind each reopening tab's page, so it stays locked. */
  const reopenAgentTouched = new Map<string, boolean>();
  /** tempo: desktop tabs the desktop already knows an agent drove (`markDesktopAgentDrove`). */
  const desktopAgentDrove = new WeakSet<ServerTab>();
  const closedSessions = new Set<string>();
  let hostConnectionId: string | null = null;
  let viewerResizeOrder = 0;

  const contexts = new ServerBrowserContexts({
    profilesDir: NodePath.join(config.stateDir, "server-browser", "profiles"),
    executable: () => runPromise(previewBrowser.executable),
    // tempo: the host's GPU and Chrome's user agent for its OS.
    platform: host.platform,
    // Playwright's launch error drops Chrome's own output; its sandbox note survives.
    diagnose: (executable, cause) =>
      Effect.runPromiseWith(launchServices)(
        PreviewBrowserHost.diagnoseLaunchFailure({
          executable,
          setupCommand,
          output: /sandboxing failed/i.test(String(cause))
            ? PreviewBrowserHost.NO_SANDBOX_SIGNATURE
            : "",
        }),
      ),
    onContextClose: (context) => {
      for (const tab of tabs.values()) {
        if (tab.page.context() === context) dropTab(tab, true);
      }
    },
    ...(tempoBrowser
      ? {
          profileLaunch: (profileId, directory) =>
            runPromise(tempoBrowser.profileLaunch(profileId, directory)),
        }
      : {}),
  });

  const dialogStatus = (tab: ServerTab) =>
    tab.dialog
      ? {
          type: tab.dialog.type(),
          message: tab.dialog.message().slice(0, 4000),
          defaultValue: tab.dialog.defaultValue().slice(0, 4000),
        }
      : null;

  const updateFileChooserInterception = (tab: ServerTab) => {
    // Only agents and streamed controllers can answer intercepted uploads; native desktop views use the OS picker.
    const intercept = !tab.desktop || tab.agentOperating || tab.control.controller !== null;
    if (intercept === tab.fileChooserIntercepted) return;
    tab.fileChooserIntercepted = intercept;
    if (intercept) tab.page.on("filechooser", tab.onFileChooser);
    else tab.page.off("filechooser", tab.onFileChooser);
  };

  const broadcastControl = (tab: ServerTab) => {
    updateFileChooserInterception(tab);
    for (const viewer of tab.viewers)
      viewer.push({
        _tag: "control",
        canOperate: viewer.canOperate,
        controller:
          tab.control.controller === viewer.id
            ? "you"
            : tab.control.controller !== null
              ? "another-viewer"
              : tab.control.agentId !== null
                ? "agent"
                : "unclaimed",
        generation: tab.control.generation,
        dialog: dialogStatus(tab),
      });
  };

  const resolveDialog = async (tab: ServerTab, input: PreviewAutomationDialogInput) => {
    const dialog = tab.dialog;
    if (!dialog) throw new Error("No dialog is pending.");
    if (input.accept) await dialog.accept(input.promptText);
    else await dialog.dismiss();
    if (tab.dialog === dialog) tab.dialog = null;
    ServerBrowserPage.invalidateRefs(tab.page);
    broadcastControl(tab);
  };

  const report = (tab: ServerTab, navStatus: PreviewNavStatus) => {
    void tab.cdp
      .send("Page.getNavigationHistory")
      .catch(() => null)
      .then((history) => {
        const index = history?.currentIndex ?? 0;
        const count = history?.entries.length ?? 0;
        runFork(
          manager
            .reportStatus({
              threadId: tab.threadId,
              tabId: tab.tabId,
              serverControlled: true,
              navStatus,
              canGoBack: index > 0,
              canGoForward: index < count - 1,
            })
            .pipe(Effect.ignore),
        );
      });
  };

  const reportLoaded = async (tab: ServerTab) => {
    const url = tab.page.url();
    // Chromium's error page loads after `requestfailed` and must not clear LoadFailed.
    if (url === "about:blank" || url.startsWith("chrome-error://")) return;
    const title = (await tab.page.title().catch(() => "")).slice(0, 512);
    if (tab.loading || tab.page.url() !== url) return;
    report(tab, { _tag: "Success", url: url.slice(0, 2048), title });
  };

  const reportLiveTabs = () => {
    const connectionId = hostConnectionId;
    if (connectionId === null) return;
    runFork(
      environment.getEnvironmentId.pipe(
        Effect.flatMap((environmentId) =>
          broker.focusHost({
            clientId: SERVER_HOST_CLIENT_ID,
            environmentId,
            connectionId,
            focused: true,
            liveTabs: [...tabs.values()].map((tab) => ({
              threadId: tab.threadId,
              tabId: tab.tabId,
              visible: tab.viewers.size > 0,
            })),
          }),
        ),
      ),
    );
  };

  const layoutSize = (tab: ServerTab) => {
    const size = tab.page.viewportSize();
    if (!size || tab.desktop) return size;
    return {
      width: Math.max(1, Math.round(size.width / tab.zoomFactor)),
      height: Math.max(1, Math.round(size.height / tab.zoomFactor)),
    };
  };

  // tempo: sizes the tab's view to its layout at its zoom through its own session after each viewport
  // or zoom change; Playwright skips an unchanged viewport, which kept a zoom at 100%. In new
  // headless mode a profile's tabs share one window, sized without its tab strip and toolbar
  // (frames ~87 px short), whose relayout can undo a pin: attachViewer re-pins on a size change.
  const pinViewport = async (tab: ServerTab) => {
    const layout = layoutSize(tab);
    if (tab.desktop || !layout) return;
    tab.pinning = true;
    await tab.cdp
      .send("Emulation.setDeviceMetricsOverride", {
        width: layout.width,
        height: layout.height,
        deviceScaleFactor: RENDER_SCALE * tab.zoomFactor,
        mobile: false,
      })
      .then(constVoid, constVoid);
    tab.pinning = false;
    for (const viewer of tab.viewers) viewer.expectFrame(RESIZED_FRAME_DUE_MS);
  };

  const broadcastViewport = (tab: ServerTab) => {
    const size = layoutSize(tab);
    if (!size) return;
    for (const viewer of tab.viewers) viewer.push({ _tag: "viewport", ...size });
  };

  const applySetting = async (tab: ServerTab, setting: PreviewViewportSetting) => {
    tab.setting = setting;

    if (tab.desktop) return;
    const size =
      fixedViewportSize(setting) ??
      [...tab.viewers]
        .map((viewer) => viewer.requestedSize)
        .filter((requested) => requested !== null)
        .sort((left, right) => right.order - left.order)[0] ??
      UNATTACHED_FILL_VIEWPORT;
    await tab.page.setViewportSize({ width: size.width, height: size.height });
    await pinViewport(tab);
    broadcastViewport(tab);
  };

  const applyRendering = async (tab: ServerTab, snapshot: PreviewSessionSnapshot) => {
    const colorScheme = snapshot.colorScheme ?? "system";
    if (colorScheme !== tab.colorScheme) {
      tab.colorScheme = colorScheme;
      await tab.page.emulateMedia({ colorScheme: colorScheme === "system" ? null : colorScheme });
    }
    const zoomFactor = snapshot.zoomFactor ?? 1;
    if (zoomFactor !== tab.zoomFactor && !tab.desktop) {
      tab.zoomFactor = zoomFactor;
      await pinViewport(tab);
      broadcastViewport(tab);
    }
  };

  const sessionOpen = (tab: ServerTab) => !closedSessions.has(tabKey(tab.threadId, tab.tabId));

  const dropTab = (tab: ServerTab, closeSession: boolean) => {
    const key = tabKey(tab.threadId, tab.tabId);
    if (tabs.get(key) !== tab) return;
    tabs.delete(key);
    tab.closing = true;
    clearAbortedNavigation(tab);
    // A desktop page outlives the connection unless its session closed with it.
    const end =
      (tab.desktop && !closeSession && sessionOpen(tab)) || restartingTabs.has(key)
        ? "reconnect"
        : "gone";
    for (const viewer of tab.viewers) viewer.push({ _tag: end });
    void tab.control.close().catch(constVoid);
    tab.passkeys?.detach();
    tab.passwords?.detach();
    if (tab.desktop) void tab.desktop.close().catch(constVoid);
    else void tab.page.close().catch(constVoid);
    if (tab.isolatedContext) void tab.page.context().close().catch(constVoid);
    void tab.recording?.encoder.close().catch(constVoid);
    void NodeFSP.rm(downloadDir(tab), { recursive: true, force: true }).catch(constVoid);
    reportLiveTabs();
    if (closeSession) {
      runFork(manager.close({ threadId: tab.threadId, tabId: tab.tabId }).pipe(Effect.ignore));
    }
  };

  const desktopRenders = (snapshot: PreviewSessionSnapshot) =>
    desktopChannel.available && !snapshot.headless
      ? runPromise(
          desktopChannel.awaitAttached(
            { threadId: snapshot.threadId, tabId: snapshot.tabId },
            DESKTOP_ATTACH_TIMEOUT,
          ),
        )
      : Promise.resolve(false);

  const connectDesktop = async (snapshot: PreviewSessionSnapshot) => {
    const scope = await runPromise(Scope.make());
    try {
      const endpoint = await runPromise(
        desktopChannel
          .endpoint({ threadId: snapshot.threadId, tabId: snapshot.tabId })
          .pipe(Scope.provide(scope)),
      );
      const connected = await contexts.connectDesktopPage(endpoint);
      return {
        page: connected.page,
        close: async () => {
          await connected.browser.close().catch(constVoid);
          await runPromise(Scope.close(scope, Exit.void));
        },
      };
    } catch (cause) {
      await runPromise(Scope.close(scope, Exit.void));
      throw cause;
    }
  };

  const createTab = async (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const adopted = adoptedPages.get(tabKey(snapshot.threadId, snapshot.tabId));
    adoptedPages.delete(tabKey(snapshot.threadId, snapshot.tabId));
    // tempo: a desktop tab an agent opens asks the person before its passkeys. The
    // desktop hears it before the tab can attach, so its page never asks first.
    const agentOpened =
      desktopChannel.available && adopted === undefined && snapshot.automationOwner !== undefined;
    if (agentOpened) {
      await runPromise(
        desktopChannel.agentDrove({ threadId: snapshot.threadId, tabId: snapshot.tabId }),
      );
    }
    const desktop =
      adopted === undefined && (await desktopRenders(snapshot))
        ? await connectDesktop(snapshot)
        : null;
    // Otherwise a desktop that attaches late shows its own page, and the agent drives another.
    if (!desktop && desktopChannel.available) {
      await runPromise(
        manager
          .markHeadless({ threadId: ThreadId.make(snapshot.threadId), tabId: snapshot.tabId })
          .pipe(Effect.ignore),
      );
    }
    const isolatedContext =
      adopted === undefined &&
      desktop === null &&
      ((snapshot.automationOwner !== undefined && snapshot.profileId === undefined) ||
        snapshot.profileId === INCOGNITO_BROWSER_PROFILE_ID);
    const context =
      adopted?.page.context() ??
      desktop?.page.context() ??
      (await contexts.contextFor(
        snapshot.profileId ?? "default",
        isolatedContext ? tabKey(snapshot.threadId, snapshot.tabId) : undefined,
      ));
    if (adopted?.page.isClosed()) throw new Error("The popup closed before it opened.");
    if (!desktop) await prepareContext(context);
    const page = adopted?.page ?? desktop?.page ?? (await context.newPage());
    claimedPages.add(page);
    const cdp = await context.newCDPSession(page);
    await installPdfDocumentNavigation(cdp);
    // The desktop's page is already a normal browser. A popup's first request
    // went out before it became a tab; everything after presents as Chrome.
    if (!desktop) await presentAsChrome(cdp, host);
    if (!desktop) await recordCopies(cdp);
    page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    const control = new SessionControl(
      snapshot.automationOwner ?? null,
      () => {
        ServerBrowserPage.invalidateRefs(page);
        // tempo: viewers hear every change of hands, including an agent's action
        // taking back an idle person's tab.
        if (!tab.closing) broadcastControl(tab);
      },
      {
        releaseInput: async (viewerId) => {
          await [...tab.viewers].find((viewer) => viewer.id === viewerId)?.releaseInput();
        },
      },
    );
    const tab: ServerTab = {
      threadId: ThreadId.make(snapshot.threadId),
      tabId: snapshot.tabId,
      page,
      cdp,
      frameSessions: new Map(),
      createdAt: Date.now(),
      usedAt: Date.now(),
      viewers: new Set(),
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      control,
      agentOperating: false,
      fileChooserIntercepted: false,
      onFileChooser: (chooser) => void offerFileChooser(tab, chooser),
      isolatedContext,
      desktop: desktop === null ? null : { close: desktop.close },
      profileId: snapshot.profileId,
      openerTabId: adopted?.openerTabId,
      downloads: [],
      fileChooser: null,
      dialog: null,
      setting: snapshot.viewport ?? FILL_PREVIEW_VIEWPORT,
      colorScheme: "system",
      zoomFactor: 1,
      loading: false,
      closing: false,
      recording: null,
      recordingStart: null,
      initialNavigation: null,
      navigationGeneration: 0,
      abortedNavigation: null,
      captureLock: Promise.resolve(),
      capturing: 0,
      passkeys: null,
      passwords: null,
      pinning: false,
    };
    if (!desktop) {
      await page.setViewportSize(fixedViewportSize(tab.setting) ?? UNATTACHED_FILL_VIEWPORT);
      await pinViewport(tab);
    }
    await applyRendering(tab, snapshot);
    // tempo: saved passkeys, set up before the page loads so a sign-in on load
    // finds them. Only in a profile that keeps data: never incognito, an
    // agent's throwaway context, a desktop page, or a popup of one of those.
    const reopenedTouched = reopenAgentTouched.get(tabKey(snapshot.threadId, snapshot.tabId));
    reopenAgentTouched.delete(tabKey(snapshot.threadId, snapshot.tabId));
    if (
      tempoBrowser &&
      !desktop &&
      !isolatedContext &&
      snapshot.profileId !== INCOGNITO_BROWSER_PROFILE_ID &&
      adopted?.passkeys !== null
    ) {
      tab.passkeys = await runPromise(
        tempoBrowser.attachTab({
          profileId: snapshot.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
          cdp,
          agentTouched:
            adopted?.passkeys?.agentTouched ??
            reopenedTouched ??
            snapshot.automationOwner !== undefined,
          linkedTabsTouched: () =>
            [...openerFamily(tab)].some((member) => member !== tab && agentTouched(member)),
          threadId: tab.threadId,
          controllerSessionId: () =>
            [...tab.viewers].find((viewer) => viewer.id === control.controller)?.sessionId ?? null,
        }),
      );
    }
    if (agentOpened && desktop) desktopAgentDrove.add(tab);
    // tempo: saved passwords, in every tab of a profile that keeps data, the
    // desktop app's own included (Electron, which draws those, keeps none).
    // Not incognito, an agent's throwaway tab, or a popup of one of those.
    if (
      tempoBrowser &&
      snapshot.profileId !== INCOGNITO_BROWSER_PROFILE_ID &&
      !(snapshot.automationOwner !== undefined && snapshot.profileId === undefined) &&
      adopted?.passkeys !== null
    ) {
      tab.passwords = await runPromise(
        tempoBrowser.attachPasswords({
          profileId: snapshot.profileId ?? DEFAULT_BROWSER_PROFILE_ID,
          cdp,
          agentTouched: () => agentTouched(tab),
        }),
      );
    }
    const isMainNavigation = (request: { isNavigationRequest(): boolean; frame(): unknown }) =>
      request.isNavigationRequest() && request.frame() === page.mainFrame();
    const navigationGenerations = new WeakMap<object, number>();
    page.on("request", (request) => {
      if (!isMainNavigation(request)) return;
      navigationGenerations.set(request, ++tab.navigationGeneration);
      clearAbortedNavigation(tab);
      tab.loading = true;
      report(tab, {
        _tag: "Loading",
        url: ServerBrowserPage.withoutDataPayload(request.url()).slice(0, 2048),
        title: "",
      });
    });
    page.on("load", () => {
      tab.loading = false;
      void reportLoaded(tab);
    });
    page.on("framenavigated", (frame) => {
      // Same-document navigations (SPA routes) fire no load event.
      if (frame === page.mainFrame() && !tab.loading) void reportLoaded(tab);
      if (!desktop) void recordFrameCopies(tab, frame);
    });
    // An adopted popup's frames may have loaded before the tab listened.
    if (adopted) for (const frame of page.frames()) void recordFrameCopies(tab, frame);
    page.on("requestfailed", (request) => {
      const errorText = request.failure()?.errorText ?? "";
      pushBounded(tab.networkEntries, {
        url: ServerBrowserPage.withoutDataPayload(request.url()),
        method: request.method(),
        status: null,
        failed: true,
        errorText,
        timestamp: new Date().toISOString(),
      });
      if (!isMainNavigation(request)) return;
      // Newer navigations own status; untracked initial popup requests yield to any tracked navigation.
      const generation = navigationGenerations.get(request) ?? 0;
      if (generation !== tab.navigationGeneration) return;
      // An aborted navigation is usually a download; its `download` event settles the status.
      if (errorText.includes("ERR_ABORTED")) {
        const url = request.url();
        const navigationGeneration = tab.navigationGeneration;
        clearAbortedNavigation(tab);
        tab.abortedNavigation = {
          url,
          generation: navigationGeneration,
          timer: setTimeout(() => {
            if (tab.abortedNavigation?.generation !== navigationGeneration) return;
            tab.abortedNavigation = null;
            if (!tab.closing) settleAbortedNavigation(tab, navigationGeneration, url, undefined);
          }, ABORTED_NAVIGATION_DOWNLOAD_WAIT_MS),
        };
        return;
      }
      tab.loading = false;
      const { code, description } = ServerBrowserPage.parseNetError(errorText);
      report(tab, {
        _tag: "LoadFailed",
        url: ServerBrowserPage.withoutDataPayload(request.url()).slice(0, 2048),
        title: "",
        code,
        description,
      });
    });
    page.on("response", (response) => {
      pushBounded(tab.networkEntries, {
        url: ServerBrowserPage.withoutDataPayload(response.url()),
        method: response.request().method(),
        status: response.status(),
        failed: false,
        timestamp: new Date().toISOString(),
      });
    });
    page.on("console", (message) => {
      pushBounded(tab.consoleEntries, {
        level: message.type(),
        text: ServerBrowserPage.consoleText(message).slice(0, 2_000),
        timestamp: new Date().toISOString(),
      });
    });
    page.on("dialog", (dialog) => {
      tab.dialog = dialog;
      broadcastControl(tab);
    });
    page.on("download", (download) => void saveDownload(tab, download));
    updateFileChooserInterception(tab);
    // Popups become tabs and keep `window.opener`, so sign-in popups can report back.
    page.on("popup", (popup) => void adoptPopup(tab, popup));
    // Playwright cannot reload a crashed page, so it must leave the tab list.
    const key = tabKey(tab.threadId, tab.tabId);
    if (closedPendingTabs.delete(key)) {
      tab.passkeys?.detach();
      tab.passwords?.detach();
      await control.close().catch(constVoid);
      if (desktop) await desktop.close().catch(constVoid);
      else await page.close().catch(constVoid);
      if (isolatedContext) await context.close().catch(constVoid);
      throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
    }
    page.on("close", () => dropTab(tab, true));
    page.on("crash", () => dropTab(tab, true));
    tabs.set(key, tab);
    reportLiveTabs();
    // Existing desktop and popup PDFs can start loading before interception attaches.
    if (
      snapshot.navStatus._tag === "Loading" &&
      ((!adopted && !desktop) || isPdfAssetUrl(snapshot.navStatus.url))
    ) {
      const options = { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS } as const;
      tab.initialNavigation = (
        (desktop || adopted) && page.url() === snapshot.navStatus.url
          ? page.reload(options)
          : page.goto(snapshot.navStatus.url, options)
      ).then(constVoid, (cause: unknown) => {
        throw ServerBrowserPage.toOperationError(cause, NAVIGATION_TIMEOUT_MS);
      });

      if (tab.control.agentId !== null) tab.control.track(tab.initialNavigation);
      else void tab.initialNavigation.catch(constVoid);
    }
    return tab;
  };

  const downloadsRoot = NodePath.join(config.stateDir, "server-browser", "downloads");
  // Tab ids are opaque server strings; hashing keeps them out of the path.
  const downloadDir = (tab: ServerTab) =>
    NodePath.join(
      downloadsRoot,
      NodeCrypto.createHash("sha256").update(tabKey(tab.threadId, tab.tabId)).digest("hex"),
    );

  const clearAbortedNavigation = (tab: ServerTab) => {
    if (tab.abortedNavigation !== null) clearTimeout(tab.abortedNavigation.timer);
    tab.abortedNavigation = null;
  };

  const settleAbortedNavigation = (
    tab: ServerTab,
    generation: number,
    url: string,
    offered: { readonly id: string; readonly fileName: string } | undefined,
  ) => {
    if (tab.navigationGeneration !== generation) return;
    tab.loading = false;
    if (tab.page.url() !== "about:blank") {
      void reportLoaded(tab);
      return;
    }
    report(tab, {
      _tag: "LoadFailed",
      url: ServerBrowserPage.withoutDataPayload(url).slice(0, 2048),
      title: "",
      code: -3,
      description: "ERR_ABORTED",
      ...(offered === undefined ? {} : { download: offered }),
    });
  };

  const saveDownload = async (tab: ServerTab, download: Download) => {
    const id = NodeCrypto.randomUUID();
    const path = NodePath.join(downloadDir(tab), id);
    const navigation =
      download.url() === tab.abortedNavigation?.url ? tab.abortedNavigation.generation : null;
    if (navigation !== null) clearAbortedNavigation(tab);
    let offered: { readonly id: string; readonly fileName: string } | undefined;
    try {
      if (await download.failure()) return;
      await NodeFSP.mkdir(downloadDir(tab), { recursive: true, mode: 0o700 });
      // mkdir leaves the mode of a folder that already exists, such as one an older build made.
      await NodeFSP.chmod(downloadDir(tab), 0o700);
      await download.saveAs(path);
      // saveAs copies with the process umask; a download should stay readable by its owner only.
      await NodeFSP.chmod(path, 0o600);
      const { size } = await NodeFSP.stat(path);
      if (tab.closing || size > DOWNLOAD_MAX_BYTES) {
        await NodeFSP.rm(path, { force: true });
        return;
      }
      const saved: ServerDownload = {
        id,
        fileName: download.suggestedFilename().slice(0, 255) || "download",
        path,
        sizeBytes: size,
        url: ServerBrowserPage.withoutDataPayload(download.url()).slice(0, 2048),
        completedAt: new Date().toISOString(),
      };
      tab.downloads.push(saved);
      for (const evicted of tab.downloads.splice(0, tab.downloads.length - DOWNLOAD_LIMIT)) {
        await NodeFSP.rm(evicted.path, { force: true }).catch(constVoid);
      }
      offered = { id, fileName: saved.fileName };
      const shownInTab =
        navigation === tab.navigationGeneration && tab.page.url() === "about:blank";
      if (shownInTab) return;
      const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
      controller?.push({
        _tag: "download",
        id,
        fileName: saved.fileName,
        sizeBytes: saved.sizeBytes,
      });
    } catch (cause) {
      await NodeFSP.rm(path, { force: true }).catch(constVoid);
      runFork(Effect.logWarning("server preview download failed", { cause }));
    } finally {
      if (navigation !== null && !tab.closing) {
        settleAbortedNavigation(tab, navigation, download.url(), offered);
      }
      // saveAs copies the artifact; cached profile contexts otherwise retain the original.
      await download.delete().catch(constVoid);
    }
  };

  const fileChooserMessage = (tab: ServerTab): ServerBrowserViewerOutput | null =>
    tab.fileChooser
      ? {
          _tag: "fileChooser",
          id: tab.fileChooser.id,
          multiple: tab.fileChooser.chooser.isMultiple(),
          accept: tab.fileChooser.accept,
        }
      : null;

  const offerFileChooser = async (tab: ServerTab, chooser: FileChooser) => {
    const previous = tab.fileChooser;
    const accept =
      (await chooser
        .element()
        .getAttribute("accept")
        .catch(() => null)) ?? "";
    if (previous) closeFileChooser(tab);
    tab.fileChooser = {
      id: NodeCrypto.randomUUID(),
      chooser,
      accept: accept.slice(0, 1024),
      offeredTo: null,
    };
    pushFileChooser(tab);
  };

  const pushFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    const controller = [...tab.viewers].find((viewer) => viewer.id === tab.control.controller);
    if (!open || !controller) return;
    if (open.offeredTo !== controller.id) {
      tab.fileChooser = { ...open, id: NodeCrypto.randomUUID(), offeredTo: controller.id };
      if (open.offeredTo !== null)
        for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
    }
    const message = fileChooserMessage(tab);
    if (message) controller.push(message);
  };

  const closeFileChooser = (tab: ServerTab) => {
    const open = tab.fileChooser;
    if (!open) return;
    tab.fileChooser = null;
    for (const viewer of tab.viewers) viewer.push({ _tag: "fileChooserClosed", id: open.id });
  };

  const setChooserFiles = async (
    input: Parameters<ServerBrowser["Service"]["answerFileChooser"]>[0],
  ) => {
    const tab = tabs.get(tabKey(input.threadId, input.tabId));
    const open = tab?.fileChooser;
    if (
      !tab ||
      !open ||
      open.id !== input.chooserId ||
      open.offeredTo === null ||
      open.offeredTo !== tab.control.controller
    )
      return false;
    if (input.files.length > 0) {
      await open.chooser.setFiles(
        open.chooser.isMultiple() ? [...input.files] : input.files.slice(0, 1),
      );
    }
    if (tab.fileChooser === open) closeFileChooser(tab);
    return true;
  };
  const uploadFiles = async (tab: ServerTab, input: PreviewAutomationUploadInput) => {
    const relative = input.paths.find((path) => !NodePath.isAbsolute(path));
    if (relative !== undefined)
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        `Upload paths must be absolute: ${relative}`,
      );
    if (await ServerBrowserPage.setInputFiles(tab.page, input)) return undefined;
    const open = tab.fileChooser;
    if (!open)
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "No file picker is open. Click the page's upload control first, or pass the file input's locator.",
      );
    if (input.paths.length > 1 && !open.chooser.isMultiple())
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationExecutionError",
        "This file picker accepts one file.",
      );
    if (input.paths.length > 0)
      await open.chooser.setFiles([...input.paths], {
        timeout: input.timeoutMs ?? NAVIGATION_TIMEOUT_MS,
      });
    if (tab.fileChooser === open) closeFileChooser(tab);
    return undefined;
  };

  const answerFileChooser: ServerBrowser["Service"]["answerFileChooser"] = (input) =>
    Effect.promise(() => setChooserFiles(input).catch(() => false));

  const openDownload: ServerBrowser["Service"]["openDownload"] = (input) =>
    Effect.sync(() => {
      const download = tabs
        .get(tabKey(input.threadId, input.tabId))
        ?.downloads.find((candidate) => candidate.id === input.downloadId);
      return download === undefined
        ? Option.none()
        : Option.some({ path: download.path, fileName: download.fileName });
    });

  const preparedContexts = new WeakSet<BrowserContext>();
  const prepareContext = async (context: BrowserContext) => {
    if (preparedContexts.has(context)) return;
    preparedContexts.add(context);
    // tempo: `presentAsChrome` grants clipboard writes per tab, without denying every other permission.
    // tempo: pages an extension opens itself (chrome.tabs.create, its popout windows).
    if (tempoBrowser) context.on("page", (page) => void adoptExtensionPage(context, page));
  };

  const recordCopies = async (cdp: CDPSession) => {
    // Scripts for new documents run only while this session's Page domain is on.
    await cdp.send("Page.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: CLIPBOARD_SCRIPT,
      worldName: CLIPBOARD_WORLD,
      runImmediately: true,
    });
  };

  /**
   * tempo: a page the server did not open, which in a profile's own browser means
   * an extension opened it. It becomes a tab in the thread whose tab in that
   * browser a person used last, and that person is switched to it, as with a
   * popup. With no such tab it closes rather than run unseen.
   */
  const adoptExtensionPage = async (context: BrowserContext, page: Page) => {
    await new Promise((resolve) => setTimeout(resolve, UNCLAIMED_PAGE_GRACE_MS));
    if (claimedPages.has(page) || page.isClosed() || (await page.opener()) !== null) return;
    claimedPages.add(page);
    const lastInput = (tab: ServerTab) =>
      Math.max(tab.createdAt, ...[...tab.viewers].map((viewer) => viewer.inputAt));
    const home = [...tabs.values()]
      .filter(
        (tab) =>
          !tab.closing && !tab.isolatedContext && !tab.desktop && tab.page.context() === context,
      )
      .sort((a, b) => lastInput(b) - lastInput(a))[0];
    if (!home) {
      runFork(Effect.logInfo("Closed a page an extension opened with no tab to show it in."));
      await page.close().catch(constVoid);
      return;
    }
    const controller = [...home.viewers].find((viewer) => viewer.id === home.control.controller);
    const url = page.url();
    await runPromise(
      manager.open({
        threadId: home.threadId,
        ...(/^https?:/i.test(url) ? { url } : {}),
        runtime: "server",
        ...(home.profileId === undefined ? {} : { profileId: home.profileId }),
        beforePublish: (snapshot) =>
          adoptedPages.set(tabKey(snapshot.threadId, snapshot.tabId), {
            page,
            openerTabId: undefined,
            passkeys: { agentTouched: false },
          }),
      }),
    ).then(
      (snapshot) => controller?.push({ _tag: "popup", tabId: snapshot.tabId }),
      async () => {
        await page.close().catch(constVoid);
      },
    );
  };

  /** Out-of-process frames need their own copy-recording session until target closure. */
  const recordFrameCopies = async (tab: ServerTab, frame: Frame) => {
    if (frame === tab.page.mainFrame() || tab.frameSessions.has(frame)) return;

    const cdp = await tab.page
      .context()
      .newCDPSession(frame)
      .catch(() => null);
    if (!cdp) return;
    if (tab.frameSessions.has(frame) || frame.isDetached()) {
      await cdp.detach().catch(constVoid);
      return;
    }
    tab.frameSessions.set(frame, cdp);
    cdp.on("close", () => {
      if (tab.frameSessions.get(frame) !== cdp) return;
      tab.frameSessions.delete(frame);

      if (!frame.isDetached()) void recordFrameCopies(tab, frame);
    });
    await recordCopies(cdp).catch(constVoid);
  };

  const takeSessionCopies = async (cdp: CDPSession) => {
    const tree = await cdp.send("Page.getFrameTree").catch(() => null);
    if (!tree) return [];
    const frameIds = (node: typeof tree.frameTree): Array<string> => [
      node.frame.id,
      ...(node.childFrames ?? []).flatMap(frameIds),
    ];
    return Promise.all(
      frameIds(tree.frameTree).map((frameId) =>
        cdp
          .send("Page.createIsolatedWorld", { frameId, worldName: CLIPBOARD_WORLD })
          .then(({ executionContextId }) =>
            cdp.send("Runtime.evaluate", {
              contextId: executionContextId,
              expression: "globalThis.takeCopy?.()",
              returnByValue: true,
            }),
          )
          .then(
            ({ result }) => (typeof result.value === "string" ? result.value : ""),
            () => "",
          ),
      ),
    );
  };

  const takeCopiedText = async (tab: ServerTab) => {
    const copies = await Promise.all(
      [tab.cdp, ...tab.frameSessions.values()].map(takeSessionCopies),
    );
    return copies.flat().find((text) => text.length > 0);
  };

  const adoptPopup = async (opener: ServerTab, popup: Page) => {
    claimedPages.add(popup);
    const agentId = opener.control.agentId;
    if (opener.closing || (agentId !== null && atTabLimit(agentId))) {
      await popup.close().catch(constVoid);
      return;
    }
    const url = popup.url();

    const controller = [...opener.viewers].find(
      (viewer) => viewer.id === opener.control.controller,
    );
    await runPromise(
      manager.open({
        threadId: opener.threadId,
        ...(/^https?:/i.test(url) ? { url } : {}),
        runtime: "server",
        ...(opener.profileId === undefined ? {} : { profileId: opener.profileId }),
        ...(opener.control.agentId === null
          ? {}
          : { automationOwner: opener.control.agentId, reveal: false }),
        beforePublish: (snapshot) =>
          adoptedPages.set(tabKey(snapshot.threadId, snapshot.tabId), {
            page: popup,
            openerTabId: opener.tabId,
            // Script in any tab linked to the opener can reach the popup too.
            passkeys:
              opener.passkeys === null
                ? null
                : { agentTouched: [...openerFamily(opener)].some(agentTouched) },
          }),
      }),
    ).then(
      (snapshot) => {
        if (opener.control.agentId === null)
          controller?.push({ _tag: "popup", tabId: snapshot.tabId });
      },
      async () => {
        await popup.close().catch(constVoid);
      },
    );
  };

  const ensureTab = (snapshot: PreviewSessionSnapshot): Promise<ServerTab> => {
    const key = tabKey(snapshot.threadId, snapshot.tabId);
    const pending = pendingTabs.get(key);
    if (pending) return pending;
    const existing = tabs.get(key);
    if (existing) return Promise.resolve(existing);
    const opening = createTab(snapshot)
      .catch((cause: unknown) => {
        runFork(
          Effect.logWarning(
            isHostSetupError(cause) ? cause.message : "server preview tab failed to start",
            { cause },
          ),
        );
        throw cause;
      })
      .finally(() => {
        pendingTabs.delete(key);
        closedPendingTabs.delete(key);
      });
    pendingTabs.set(key, opening);
    return opening;
  };

  const findTab = Effect.fn("ServerBrowser.findTab")(function* (threadId: string, tabId: string) {
    const existing = tabs.get(tabKey(threadId, tabId));
    if (existing) return existing;
    const { sessions } = yield* manager.list({ threadId: ThreadId.make(threadId) });
    const snapshot = sessions.find(
      (session) => session.tabId === tabId && session.runtime === "server",
    );
    if (!snapshot) return yield* new ServerBrowserTabNotFoundError({ threadId, tabId });
    return yield* Effect.tryPromise({
      try: () => ensureTab(snapshot),
      catch: (cause) => (isTabNotFound(cause) ? cause : new ServerBrowserLaunchError({ cause })),
    });
  });

  const atTabLimit = (agentSessionId: string) =>
    tabs.size + pendingTabs.size >= SERVER_TAB_LIMIT ||
    [...tabs.values()].filter((tab) => tab.control.agentId === agentSessionId).length >=
      AGENT_TAB_LIMIT;

  const assertTabCapacity = (agentSessionId: string) => {
    if (atTabLimit(agentSessionId))
      throw new BrowserControlInterrupted(
        `Too many server browser tabs are open (${AGENT_TAB_LIMIT} per agent session, ${SERVER_TAB_LIMIT} per server). Close one with t3_preview_close or reuse one from preview_status tabs.`,
        "tabLimit",
      );
  };

  // Desktop browsing bypasses streamed viewers and server input tracking,
  // so these idle signals only apply to headless tabs.
  const closeIdleAgentTabs = () => {
    const cutoff = Date.now() - AGENT_TAB_IDLE_MS;
    for (const tab of tabs.values()) {
      if (
        tab.control.agentId !== null &&
        tab.desktop === null &&
        tab.viewers.size === 0 &&
        tab.usedAt < cutoff
      )
        dropTab(tab, true);
    }
  };

  const latestThreadTab = (threadId: string, agentSessionId?: string) => {
    const threadTabs = [...tabs.values()].filter((tab) => tab.threadId === threadId);
    return (
      threadTabs
        .filter((tab) => tab.control.agentId === agentSessionId)
        .sort((left, right) => right.createdAt - left.createdAt)[0] ??
      threadTabs.sort(
        (left, right) =>
          Number(right.viewers.size > 0) - Number(left.viewers.size > 0) ||
          right.usedAt - left.usedAt,
      )[0]
    );
  };

  const tabOwner = (tab: ServerTab) =>
    // tempo: an idle person no longer keeps the tab from agents.
    tab.control.humanActive()
      ? ("human" as const)
      : tab.control.agentId !== null
        ? ("agent" as const)
        : ("unclaimed" as const);

  let reportedProfiles: {
    readonly profiles: ReadonlyArray<BrowserProfile>;
    readonly defaultProfileId: string;
  } | null = null;
  // Agent recordings encode here, so they need the client's Browser recording frame rate. The
  // last report outlives the client, which lets agents record while no client is connected.
  let recordingFrameRate = DEFAULT_BROWSER_RECORDING_FRAME_RATE;

  const reportProfiles: ServerBrowser["Service"]["reportProfiles"] = (input) =>
    Effect.sync(() => {
      if (input.recordingFrameRate !== undefined) recordingFrameRate = input.recordingFrameRate;
      const profiles = resolveBrowserProfiles(input.profiles);
      reportedProfiles = {
        profiles,
        defaultProfileId:
          findBrowserProfile(profiles, input.defaultProfileId)?.id ?? DEFAULT_BROWSER_PROFILE_ID,
      };
    });

  const profileStatus = () => {
    const profiles = reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    return {
      profiles: profiles.map((profile) => ({
        id: profile.id,
        name: profile.name,
        ...(profile.kind === "incognito" ? { incognito: true } : {}),
      })),
      ...(reportedProfiles ? { defaultProfileId: reportedProfiles.defaultProfileId } : {}),
    };
  };

  const resolveOpenProfile = (requested: string | undefined): string | undefined => {
    if (requested === undefined) return reportedProfiles?.defaultProfileId;
    const profiles = reportedProfiles?.profiles ?? BUILT_IN_BROWSER_PROFILES;
    const wanted = requested.toLowerCase();
    const match =
      findBrowserProfile(profiles, requested) ??
      profiles.find((profile) => profile.name.toLowerCase() === wanted);
    if (match) return match.id;
    throw new ServerBrowserPage.ServerBrowserOperationError(
      "PreviewAutomationUnknownProfileError",
      `No browser profile is named "${requested}". Use one of: ${profiles
        .map((profile) => `${profile.name} (id ${profile.id})`)
        .join(", ")}.`,
    );
  };

  const statusWithTitle = async (
    tab: ServerTab | undefined,
    agentSessionId?: string,
  ): Promise<PreviewAutomationStatus> => {
    if (!tab) {
      return {
        available: false,
        visible: false,
        tabId: null,
        url: null,
        title: null,
        loading: false,
        ...profileStatus(),
      };
    }
    const url = tab.page.url();
    const viewport = tab.page.viewportSize();
    const status = {
      available: true,
      visible: tab.viewers.size > 0,
      tabId: tab.tabId,
      url: url === "about:blank" ? null : url,
      title: null,
      loading: tab.loading,
      control: {
        owner: tabOwner(tab),
        ownedByCaller: tab.control.agentId === agentSessionId,
        generation: tab.control.generation,
      },
      dialog: dialogStatus(tab),
      fileChooser: tab.fileChooser
        ? { multiple: tab.fileChooser.chooser.isMultiple(), accept: tab.fileChooser.accept }
        : null,
      viewportSetting: tab.setting,
      ...(viewport ? { viewport } : {}),
      tabs: [...tabs.values()]
        .filter((candidate) => candidate.threadId === tab.threadId)
        .map((candidate) => ({
          tabId: candidate.tabId,
          url: candidate.page.url() === "about:blank" ? null : candidate.page.url(),
          ...(candidate.openerTabId === undefined ? {} : { openerTabId: candidate.openerTabId }),
          owner: tabOwner(candidate),
          ownedByCaller: candidate.control.agentId === agentSessionId,
          visible: candidate.viewers.size > 0,
          ...(candidate.profileId === undefined ? {} : { profileId: candidate.profileId }),
        })),
      ...profileStatus(),
      downloads: tab.downloads.map(({ fileName, path, sizeBytes, url, completedAt }) => ({
        fileName,
        path,
        sizeBytes,
        url,
        completedAt,
      })),
    };
    if (status.url === null || tab.dialog) return status;
    return { ...status, title: (await tab.page.title().catch(() => "")) || null };
  };

  const resolveNavigationUrl = (input: PreviewAutomationNavigateInput) => {
    if (input.url !== undefined) return normalizePreviewUrl(input.url);
    const target = input.target!;
    if (target.kind === "url") return normalizePreviewUrl(target.url);

    const path = target.path ?? "";
    return `${target.protocol ?? "http"}://localhost:${target.port}${path.startsWith("/") || path === "" ? path : `/${path}`}`;
  };

  const navigate = async (
    tab: ServerTab,
    url: string,
    readiness: "load" | "domContentLoaded" | "none",
    timeout: number,
  ) => {
    const navigation = tab.page.goto(url, {
      timeout,
      waitUntil:
        readiness === "domContentLoaded"
          ? "domcontentloaded"
          : readiness === "none"
            ? "commit"
            : "load",
    });
    if (readiness === "none") {
      tab.control.track(navigation);
      return;
    }
    await navigation.catch((cause: unknown) => {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("Download is starting")) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `${url} is a file this browser cannot show, so it was downloaded instead. preview_status lists it under downloads.`,
        );
      }
      if (/ERR_[A-Z_]+/.test(message)) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          `Navigation to ${url} failed: ${ServerBrowserPage.parseNetError(message).description}`,
        );
      }
      throw ServerBrowserPage.toOperationError(cause, timeout);
    });
  };

  const withCaptureLock = <A>(tab: ServerTab, operation: () => Promise<A>): Promise<A> => {
    const run = tab.captureLock.then(() => {
      if (tab.closing) throw new Error("The preview tab closed.");
      return operation();
    });
    tab.captureLock = run.then(constVoid, constVoid);
    return run;
  };

  /**
   * tempo: ends a session a viewer or recording opened on a tab's page. Chrome
   * drops the page's virtual authenticators with it, so the tab's saved
   * passkeys are set up again.
   */
  const detachPageSession = async (tab: ServerTab, session: CDPSession) => {
    await session.detach().catch(constVoid);
    tab.passkeys?.sessionDetached();
  };

  const startRecording = (tab: ServerTab): Promise<Recording> => {
    const started = withCaptureLock(tab, async () => {
      if (tab.recording) return tab.recording;
      const encoder = await contexts.scratchPage();
      let session: CDPSession | null = null;
      try {
        await encoder.evaluate(ServerBrowserPage.recordingEncoderScript(recordingFrameRate));
        // Seed idle pages before returning so an immediate stop has a frame to encode.
        const firstFrame = await ServerBrowserPage.captureViewport(tab.cdp, {
          format: "jpeg",
          quality: RECORDING_SCREENCAST.quality,
        });
        await encoder.evaluate(
          ([data, width]) =>
            (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
          [firstFrame, tab.page.viewportSize()?.width ?? UNATTACHED_FILL_VIEWPORT.width] as const,
        );
        const opened = await tab.page.context().newCDPSession(tab.page);
        session = opened;
        const framesInFlight = new Set<Promise<void>>();
        opened.on("Page.screencastFrame", (frame) => {
          const cssWidth = tab.page.viewportSize()?.width ?? frame.metadata.deviceWidth;
          const delivered: Promise<void> = encoder
            .evaluate(
              ([data, width]) =>
                (globalThis as unknown as EncoderWindow).__t3Recorder.frame(data, width),
              [frame.data, cssWidth] as const,
            )
            .then(async (accepted) => {
              if (!accepted) await opened.send("Page.stopScreencast");
            })
            .catch(constVoid)
            .finally(() => {
              framesInFlight.delete(delivered);
              void opened
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(constVoid);
            });
          framesInFlight.add(delivered);
        });
        await opened.send("Page.startScreencast", RECORDING_SCREENCAST);
        if (tab.closing) throw new Error("The tab closed while the recording started.");
        const recording: Recording = {
          encoder,
          session: opened,
          startedAt: new Date().toISOString(),
          framesInFlight,
        };
        tab.recording = recording;
        return recording;
      } catch (cause) {
        await encoder.close().catch(constVoid);
        if (session) await detachPageSession(tab, session);
        throw cause;
      }
    }).finally(() => {
      if (tab.recordingStart === started) tab.recordingStart = null;
    });
    tab.recordingStart = started;
    return started;
  };

  const withScreencastsPaused = <A>(tab: ServerTab, capture: () => Promise<A>): Promise<A> =>
    withCaptureLock(tab, async () => {
      tab.capturing += 1;
      const recording = tab.recording;
      try {
        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.pause()),
          recording?.session.send("Page.stopScreencast").catch(constVoid),
        ]);
        return await capture();
      } finally {
        tab.capturing -= 1;

        await Promise.all([
          ...[...tab.viewers].map((viewer) => viewer.resume()),
          recording && tab.recording === recording
            ? recording.session.send("Page.startScreencast", RECORDING_SCREENCAST).catch(constVoid)
            : undefined,
        ]);
      }
    });

  // tempo: shrunk to the width asked for, so its capture pauses the tab's screencasts.
  const thumbnail: ServerBrowser["Service"]["thumbnail"] = (input) =>
    Effect.promise(async () => {
      const tab = tabs.get(tabKey(input.threadId, input.tabId));
      const data =
        tab &&
        (await withScreencastsPaused(tab, () =>
          ServerBrowserPage.thumbnail({
            page: tab.page,
            cdp: tab.cdp,
            renderScale: tab.desktop ? "display" : RENDER_SCALE,
            maxWidth: input.maxWidth,
          }),
        ).catch(() => undefined));
      return data ? Option.some(Buffer.from(data, "base64")) : Option.none();
    });

  const stopRecording = (tab: ServerTab) =>
    withCaptureLock(tab, async () => {
      const recording = tab.recording;
      if (!recording) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationRecordingNotActiveError",
          "No recording is active for this tab.",
        );
      }
      let mimeType: string | null;
      const chunks: Array<Buffer> = [];
      try {
        await recording.session.send("Page.stopScreencast").catch(constVoid);
        await Promise.all(recording.framesInFlight);
        await detachPageSession(tab, recording.session);
        const stopped = await recording.encoder.evaluate(() =>
          (globalThis as unknown as EncoderWindow).__t3Recorder.stop(),
        );
        mimeType = stopped.mimeType;
        // Checked before the transfer so an oversized video never lands in this process.
        if (stopped.bytes > PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingTooLargeError",
            "The recording is larger than the attachment limit.",
          );
        }
        for (let index = 0; index < stopped.count; index += 1) {
          const chunk = await recording.encoder.evaluate(
            (chunkIndex) => (globalThis as unknown as EncoderWindow).__t3Recorder.chunk(chunkIndex),
            index,
          );
          chunks.push(Buffer.from(chunk, "base64"));
        }
      } finally {
        await recording.encoder.close().catch(constVoid);
        tab.recording = null;
      }
      const data = Buffer.concat(chunks);
      if (!mimeType || data.byteLength === 0) {
        throw new ServerBrowserPage.ServerBrowserOperationError(
          "PreviewAutomationExecutionError",
          "The recording captured no frames.",
        );
      }

      const extension = mimeType.startsWith("video/mp4") ? "mp4" : "webm";
      const pendingId = `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}-${extension}`;
      const path = NodePath.join(config.attachmentsDir, `${pendingId}.${extension}`);
      await NodeFSP.mkdir(config.attachmentsDir, { recursive: true });
      await NodeFSP.writeFile(path, data);
      return {
        id: pendingId,
        tabId: tab.tabId,
        path,
        mimeType: mimeType.split(";")[0]!,
        sizeBytes: data.byteLength,
        createdAt: new Date().toISOString(),
        uploadedAttachmentId: pendingId,
      };
    });

  let pointerSequence = 0;
  const pointerFor =
    (tab: ServerTab): ServerBrowserPage.PointerReporter =>
    async ({ x, y }, phase) => {
      const encoder = tab.recording?.encoder;

      if (tab.viewers.size === 0 && !encoder && !tab.desktop) return;
      const show = (next: "move" | "click") => {
        const sequence = ++pointerSequence;
        for (const viewer of tab.viewers)
          viewer.push({ _tag: "pointer", phase: next, x, y, sequence });
        if (tab.desktop)
          runFork(
            desktopChannel.pointer(
              { threadId: tab.threadId, tabId: tab.tabId },
              { phase: next, x, y },
            ),
          );
        void encoder
          ?.evaluate(
            ([px, py, click]) =>
              (globalThis as unknown as EncoderWindow).__t3Recorder?.cursor(px, py, click),
            [x, y, next === "click"] as const,
          )
          .catch(constVoid);
      };
      show("move");
      await sleepUntil(Date.now() + AGENT_CURSOR_MOVE_MS);
      if (phase !== "click") return;
      show("click");
      await sleepUntil(Date.now() + AGENT_CURSOR_CLICK_LEAD_MS);
    };

  const recordAction = <A>(tab: ServerTab, action: string, run: () => Promise<A>): Promise<A> => {
    const event: {
      -readonly [K in keyof PreviewAutomationActionEvent]: PreviewAutomationActionEvent[K];
    } = {
      id: NodeCrypto.randomUUID(),
      action,
      status: "running",
      startedAt: new Date().toISOString(),
    };
    pushBounded(tab.actionTimeline, event, ACTION_TIMELINE_LIMIT);
    return run().then(
      (result) => {
        event.status = "succeeded";
        event.completedAt = new Date().toISOString();
        return result;
      },
      (cause: unknown) => {
        event.status = "failed";
        event.completedAt = new Date().toISOString();
        event.error = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
        throw cause;
      },
    );
  };

  const requireTab = async (request: PreviewAutomationRequest) => {
    if (!request.agentSessionId)
      throw new BrowserControlInterrupted("The agent session is missing. Reconnect the provider.");
    const owned = [...tabs.values()].filter(
      (tab) => tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
    );
    if (!request.tabIdExplicit && owned.length > 1)
      throw new BrowserControlInterrupted(
        "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
        "tabRequired",
      );
    const tab =
      request.tabId === undefined
        ? latestThreadTab(request.threadId, request.agentSessionId)
        : await runPromise(
            findTab(request.threadId, request.tabId).pipe(Effect.orElseSucceed(constVoid)),
          );
    if (!tab) {
      throw new ServerBrowserPage.ServerBrowserOperationError(
        "PreviewAutomationTabNotFoundError",
        "No server preview tab is open for this thread. Call preview_open first.",
      );
    }
    if (!READ_OPERATIONS.has(request.operation) && !tab.control.agentMayAct(request.agentSessionId))
      throw new BrowserControlInterrupted(
        "This tab belongs to another agent session. You can read it, but open your own tab to act.",
        "agentMismatch",
      );
    if (refusesAgent(tab, request.operation)) throw extensionPageRefused();
    return tab;
  };

  // tempo: agents and the pages they touch.
  const extensionPageRefused = () =>
    new BrowserControlInterrupted(
      "This tab is a browser extension's own page. Only people can use it.",
      "humanControl",
    );

  /**
   * Whether an agent opened or acted in the tab's page. A desktop tab has no
   * passkey session; one an agent drove stays its page, as the server never
   * sees a person load a new one there.
   */
  const agentTouched = (tab: ServerTab) =>
    tab.passkeys?.agentTouched() ?? (tab.control.agentId !== null || desktopAgentDrove.has(tab));

  /** A person's navigation from the browser's controls, which can return a page to them. */
  const asPerson = <A>(tab: ServerTab, run: () => Promise<A>) =>
    tab.passkeys ? tab.passkeys.personNavigation(run) : run();

  /** Tabs linked through `window.opener` with this one, whose scripts can reach each other. */
  const openerFamily = (tab: ServerTab) => {
    const family = new Set([tab]);
    for (let grew = true; grew;) {
      grew = false;
      for (const candidate of tabs.values()) {
        if (family.has(candidate) || candidate.threadId !== tab.threadId) continue;
        const linked = [...family].some(
          (member) =>
            member.tabId === candidate.openerTabId || member.openerTabId === candidate.tabId,
        );
        if (linked) {
          family.add(candidate);
          grew = true;
        }
      }
    }
    return family;
  };

  /**
   * tempo: tells the desktop, once per tab, that an agent drove a tab it draws.
   * Its passkey bridge then asks the person before each site's first request.
   * The line goes out before the agent's own CDP input, on the same pipe.
   */
  const markDesktopAgentDrove = async (tab: ServerTab) => {
    if (tab.desktop === null || desktopAgentDrove.has(tab)) return;
    desktopAgentDrove.add(tab);
    await runPromise(desktopChannel.agentDrove({ threadId: tab.threadId, tabId: tab.tabId }));
  };

  /**
   * tempo: an agent's action in a tab. The tab, and every tab its scripts can
   * reach, lose saved passkeys before it runs (BrowserPasskeys), and the
   * passwords they filled unless agents may use them (BrowserPasswords).
   * Extension pages refuse it even if the tab navigated to one meanwhile.
   */
  const asAgent =
    <A>(tab: ServerTab, operation: PreviewAutomationRequest["operation"], run: () => Promise<A>) =>
    async () => {
      await Promise.all(
        [...openerFamily(tab)].map((member) =>
          member === tab ? undefined : member.passkeys?.agentAction(async () => {}),
        ),
      );
      await Promise.all([...openerFamily(tab)].map(markDesktopAgentDrove));
      const act = async () => {
        if (refusesAgent(tab, operation)) throw extensionPageRefused();
        // Every page here counts as the agent's by now, so no fill lands after this.
        await Promise.all(
          [...openerFamily(tab)].map((member) => member.passwords?.beforeAgentAction()),
        );
        return run();
      };
      return tab.passkeys ? tab.passkeys.agentAction(act) : act();
    };

  const markUsed = (request: PreviewAutomationRequest) => {
    const now = Date.now();
    for (const tab of tabs.values()) {
      if (
        tab.threadId === request.threadId &&
        (tab.control.agentId === request.agentSessionId || tab.tabId === request.tabId)
      )
        tab.usedAt = now;
    }
  };

  const runOperation = async (
    request: PreviewAutomationRequest,
    deadlineMs: number,
  ): Promise<unknown> => {
    const input = request.input;
    switch (request.operation) {
      case "status":
        return statusWithTitle(
          request.tabId === undefined
            ? latestThreadTab(request.threadId, request.agentSessionId)
            : tabs.get(tabKey(request.threadId, request.tabId)),
          request.agentSessionId,
        );
      case "open": {
        if (!request.agentSessionId)
          throw new BrowserControlInterrupted(
            "The agent session is missing. Reconnect the provider.",
          );
        const open = input as PreviewAutomationOpenInput;
        const url = open.url === undefined ? undefined : normalizePreviewUrl(open.url);
        const reuse = open.reuseExistingTab ?? true;
        if (
          reuse &&
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (tab) =>
              tab.threadId === request.threadId && tab.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs are open. Pass tabId or reuseExistingTab=false.",
            "tabRequired",
          );

        const found =
          reuse && request.tabId !== undefined
            ? await runPromise(
                findTab(request.threadId, request.tabId).pipe(
                  Effect.catchTags({
                    ServerBrowserTabNotFoundError: () => Effect.void,
                  }),
                ),
              )
            : undefined;
        if (reuse && request.tabIdExplicit && !found) {
          const { sessions } = await runPromise(
            manager.list({ threadId: ThreadId.make(request.threadId) }),
          );
          const desktop = sessions.some(
            (session) => session.tabId === request.tabId && session.runtime !== "server",
          );
          throw new ServerBrowserPage.ServerBrowserOperationError(
            desktop ? "PreviewAutomationExecutionError" : "PreviewAutomationTabNotFoundError",
            desktop
              ? "This tab belongs to the desktop runtime. This environment's server browser cannot control desktop tabs. Omit tabId to open a server tab instead."
              : "The requested server preview tab does not exist.",
          );
        }
        // Reusing another session's tab requires explicit tabId; reading it grants no implicit takeover.
        const existing =
          found && (request.tabIdExplicit || found.control.agentId === request.agentSessionId)
            ? found
            : undefined;
        const navigationTimeout = Math.min(request.timeoutMs, NAVIGATION_TIMEOUT_MS);
        const profileId = existing ? undefined : resolveOpenProfile(open.profileId);
        if (!existing) {
          closeIdleAgentTabs();
          assertTabCapacity(request.agentSessionId);
        }
        const tab =
          existing ??
          (await ensureTab(
            await runPromise(
              manager.open({
                threadId: request.threadId,
                ...(url ? { url } : {}),
                ...(profileId === undefined ? {} : { profileId }),
                runtime: "server",
                reveal: false,
                automationOwner: request.agentSessionId,
              }),
            ),
          ));
        if (existing?.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status and use preview_dialog first.",
            "dialogPending",
          );
        if (existing && refusesAgent(existing, "open")) throw extensionPageRefused();
        return tab.control.agent(
          request.agentSessionId,
          asAgent(tab, "open", async () => {
            if (tab.dialog)
              throw new BrowserControlInterrupted(
                "A browser dialog is pending. Read preview_status and use preview_dialog first.",
                "dialogPending",
              );
            if (existing) {
              if (url) await navigate(tab, url, "load", navigationTimeout);
            } else {
              await tab.initialNavigation;
            }
            const reveal = open.open ?? open.show;
            if (reveal !== false) {
              await runPromise(
                manager.requestReveal({
                  threadId: tab.threadId,
                  tabId: tab.tabId,
                  force: reveal === true,
                }),
              );
            }
            if (!existing && url) {
              await tab.page
                .waitForLoadState("load", { timeout: navigationTimeout })
                .catch(constVoid);
            }
            return statusWithTitle(tab, request.agentSessionId);
          }),
          deadlineMs,
        );
      }
      case "recordingStop": {
        if (
          !request.tabIdExplicit &&
          [...tabs.values()].filter(
            (candidate) =>
              candidate.threadId === request.threadId &&
              candidate.control.agentId === request.agentSessionId,
          ).length > 1
        )
          throw new BrowserControlInterrupted(
            "Multiple tabs belong to this agent session. Pass a tabId from preview_open or preview_status tabs.",
            "tabRequired",
          );
        const recordings = [...tabs.values()].filter(
          (candidate) =>
            candidate.threadId === request.threadId &&
            candidate.control.agentMayAct(request.agentSessionId ?? "") &&
            (candidate.recording || candidate.recordingStart),
        );
        const targetTabId =
          request.tabId ?? latestThreadTab(request.threadId, request.agentSessionId)?.tabId;
        const tab =
          recordings.find((candidate) => candidate.tabId === targetTabId) ??
          (!request.tabIdExplicit && recordings.length === 1 ? recordings[0] : undefined);
        if (!tab) {
          throw new ServerBrowserPage.ServerBrowserOperationError(
            "PreviewAutomationRecordingNotActiveError",
            "No recording is active for this thread.",
          );
        }
        // A stop cannot act twice (a retry finds no recording);
        // dropping a late one would leave capture running.
        return tab.control.agent(request.agentSessionId ?? "", () => stopRecording(tab));
      }
    }
    const tab = await requireTab(request);
    // Closing must unblock an action waiting on a dialog, without queueing behind it.
    if (request.operation === "close") {
      if (tab.control.agentId !== request.agentSessionId)
        throw new BrowserControlInterrupted(
          "Only the agent session that opened this tab can close it.",
          "agentMismatch",
        );
      // tempo: an idle person's tab is handed back; an active person keeps it.
      if (!tab.control.yieldToAgent()) throw humanControlError();
      void tab.control.close().catch(constVoid);
      await runPromise(manager.close({ threadId: tab.threadId, tabId: tab.tabId }));
      dropTab(tab, false);
      return {};
    }
    // Resolve dialogs outside the queue, with ownership checked, to unblock waiting clicks.
    if (request.operation === "dialog") {
      // tempo: as with any agent action, an idle person's tab is handed back first.
      if (!tab.control.yieldToAgent()) throw humanControlError();
      await resolveDialog(tab, input as PreviewAutomationDialogInput);
      return statusWithTitle(tab, request.agentSessionId);
    }
    const agentSessionId = request.agentSessionId!;

    // tempo: a read never takes a tab from a person, even an idle one; only an
    // action hands their tab back.
    if (
      READ_OPERATIONS.has(request.operation) &&
      (tab.control.controller !== null || !tab.control.agentMayAct(agentSessionId))
    ) {
      return tab.control.observe(async () => {
        if (tab.dialog)
          throw new BrowserControlInterrupted(
            "A browser dialog is pending. Read preview_status.",
            "dialogPending",
          );
        return executeTabOperation(tab, request);
      });
    }
    const operate = async () => {
      if (tab.dialog)
        throw new BrowserControlInterrupted(
          "A browser dialog is pending. Read preview_status and use preview_dialog first.",
          "dialogPending",
        );
      const generation = tab.control.generation;
      tab.agentOperating = !READ_OPERATIONS.has(request.operation);
      updateFileChooserInterception(tab);
      try {
        return await executeTabOperation(tab, request);
      } finally {
        tab.agentOperating = false;
        updateFileChooserInterception(tab);
        if (generation !== tab.control.generation) ServerBrowserPage.invalidateRefs(tab.page);
      }
    };
    return tab.control.agent(
      agentSessionId,
      READ_OPERATIONS.has(request.operation) ? operate : asAgent(tab, request.operation, operate),
      deadlineMs,
    );
  };

  const executeTabOperation = async (tab: ServerTab, request: PreviewAutomationRequest) => {
    const input = request.input;
    switch (request.operation) {
      case "navigate": {
        const navigateInput = input as PreviewAutomationNavigateInput;
        await recordAction(tab, "navigate", () =>
          navigate(
            tab,
            resolveNavigationUrl(navigateInput),
            navigateInput.readiness ?? "load",
            navigateInput.timeoutMs ?? request.timeoutMs,
          ),
        );
        return statusWithTitle(tab, request.agentSessionId);
      }
      case "resize": {
        const setting = resolvePreviewViewport(input as PreviewAutomationResizeInput);
        await runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return {
          tabId: tab.tabId,
          setting,
          viewport: tab.page.viewportSize() ?? UNATTACHED_FILL_VIEWPORT,
        };
      }
      case "setColorScheme": {
        const { colorScheme } = input as PreviewAutomationSetColorSchemeInput;
        const snapshot = await runPromise(
          manager.adjust({ threadId: tab.threadId, tabId: tab.tabId, colorScheme }),
        );
        await applyRendering(tab, snapshot);
        return { tabId: tab.tabId, colorScheme };
      }
      case "snapshot": {
        return withScreencastsPaused(tab, () =>
          ServerBrowserPage.snapshot({
            ...tab,
            renderScale: tab.desktop ? "display" : RENDER_SCALE,
          }),
        );
      }
      case "click": {
        const clickInput = input as PreviewAutomationClickInput;
        await recordAction(tab, "click", () =>
          ServerBrowserPage.click(tab.page, clickInput, pointerFor(tab)),
        );
        return undefined;
      }
      case "hover":
        return recordAction(tab, "hover", () =>
          ServerBrowserPage.hover(tab.page, input as PreviewAutomationHoverInput, pointerFor(tab)),
        );
      case "select":
        return recordAction(tab, "select", () =>
          ServerBrowserPage.select(tab.page, input as PreviewAutomationSelectInput),
        );
      case "drag":
        return recordAction(tab, "drag", () =>
          ServerBrowserPage.drag(tab.page, input as PreviewAutomationDragInput, pointerFor(tab)),
        );
      case "upload":
        return recordAction(tab, "upload", () =>
          uploadFiles(tab, input as PreviewAutomationUploadInput),
        );
      case "type":
        return recordAction(tab, "type", () =>
          ServerBrowserPage.type(tab.page, input as PreviewAutomationTypeInput),
        );
      case "press":
        return recordAction(tab, "press", () =>
          ServerBrowserPage.press(tab.page, input as PreviewAutomationPressInput),
        );
      case "scroll":
        return recordAction(tab, "scroll", () =>
          ServerBrowserPage.scroll(tab.page, input as PreviewAutomationScrollInput),
        );
      case "evaluate":
        return ServerBrowserPage.evaluate(
          tab.cdp,
          input as PreviewAutomationEvaluateInput,
          request.timeoutMs,
        );
      case "waitFor":
        return ServerBrowserPage.waitFor(tab.page, input as PreviewAutomationWaitForInput);
      case "recordingStart": {
        const recording = await startRecording(tab);
        return { tabId: tab.tabId, recording: true, startedAt: recording.startedAt };
      }
    }
  };

  const handleRequest = (connectionId: string, request: PreviewAutomationRequest) =>
    Effect.tryPromise({
      try: () =>
        runOperation(request, performance.now() + request.timeoutMs).finally(() =>
          markUsed(request),
        ),
      catch: ServerBrowserPage.toOperationError,
    }).pipe(
      Effect.match({
        onSuccess: (result) => ({ ok: true as const, result }),
        onFailure: (error) => ({
          ok: false as const,
          error: {
            _tag: error.tag,
            message: error.message,
            ...(error.detail === undefined ? {} : { detail: error.detail }),
          },
        }),
      }),
      Effect.flatMap((outcome) =>
        broker.respond({
          clientId: SERVER_HOST_CLIENT_ID,
          connectionId,
          requestId: request.requestId,
          ...outcome,
        }),
      ),
      Effect.ignore,
    );

  const mirrorManagerEvent = (event: PreviewEvent) =>
    Effect.promise(async () => {
      if (event.type === "opened" && event.snapshot.runtime === "server") {
        await ensureTab(event.snapshot).catch(constVoid);
        return;
      }
      const key = tabKey(event.threadId, event.tabId);
      const tab = tabs.get(key);
      if (event.type === "closed" && !tab && pendingTabs.has(key)) closedPendingTabs.add(key);
      if (!tab) return;
      if (event.type === "closed") {
        closedSessions.add(key);
        dropTab(tab, false);
        closedSessions.delete(key);
        return;
      }
      if (event.type === "resized") {
        await tab.control
          .system(async () => {
            if (
              !viewportSettingsEqual(event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT, tab.setting)
            ) {
              await applySetting(tab, event.snapshot.viewport ?? FILL_PREVIEW_VIEWPORT);
            }
            await applyRendering(tab, event.snapshot);
            const request = event.request;
            if (request?.clear === "cookies") await tab.cdp.send("Network.clearBrowserCookies");
            if (request?.clear === "cache") await tab.cdp.send("Network.clearBrowserCache");
            if (request?.hardReload) await tab.cdp.send("Page.reload", { ignoreCache: true });
          })
          .catch((cause: unknown) =>
            runFork(Effect.logWarning("server preview could not apply a tab setting", { cause })),
          );
      }
    });

  const releaseViewerInput = async (viewer: ViewerState, session: CDPSession) => {
    for (const { key, code } of viewer.pressedKeys.values()) {
      await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code }).catch(constVoid);
    }
    viewer.pressedKeys.clear();
    for (const [button, point] of viewer.pressedButtons) {
      await session
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button,
          ...point,
          buttons: 0,
          clickCount: 1,
        })
        .catch(constVoid);
    }
    viewer.pressedButtons.clear();
    viewer.requestedSize = null;
  };

  const dispatchViewerInput = async (
    tab: ServerTab,
    session: CDPSession,
    viewer: ViewerState,
    raw: unknown,
  ) => {
    const message = asRecord(raw);
    if (!message) return;
    viewer.inputAt = Date.now();
    const modifiers = modifiersOf(message);
    switch (message.type) {
      case "mouse": {
        const action = message.action;
        const type =
          action === "down" ? "mousePressed" : action === "up" ? "mouseReleased" : "mouseMoved";
        const button = ["none", "left", "middle", "right"].includes(String(message.button))
          ? (message.button as "none" | "left" | "middle" | "right")
          : "none";
        await session.send("Input.dispatchMouseEvent", {
          type,
          x: num(message.x),
          y: num(message.y),
          button,
          buttons: num(message.buttons),
          clickCount: num(message.clickCount, type === "mouseMoved" ? 0 : 1),
          modifiers,
        });
        if (button !== "none") {
          if (action === "down")
            viewer.pressedButtons.set(button, { x: num(message.x), y: num(message.y) });
          else if (action === "up") viewer.pressedButtons.delete(button);
        }
        return;
      }
      case "wheel":
        viewer.scrolledAt = Date.now();
        await session.send("Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: num(message.x),
          y: num(message.y),
          deltaX: num(message.deltaX),
          deltaY: num(message.deltaY),
          modifiers,
        });
        return;
      case "key": {
        const key = typeof message.key === "string" ? message.key : "";
        const code = typeof message.code === "string" ? message.code : "";
        const text = typeof message.text === "string" ? message.text : undefined;
        if (message.action === "up") {
          await session.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, modifiers });
          viewer.pressedKeys.delete(code || key);
          return;
        }
        const command = editingCommand(key, modifiers);
        const copying =
          !tab.desktop && (command?.commands[0] === "copy" || command?.commands[0] === "cut");

        if (copying) await takeCopiedText(tab);
        await session.send("Input.dispatchKeyEvent", {
          type: text ? "keyDown" : "rawKeyDown",
          key,
          code,
          modifiers,
          ...(text ? { text, unmodifiedText: text } : {}),
          ...command,
          windowsVirtualKeyCode: num(
            message.keyCode,
            key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
          ),
        });
        viewer.pressedKeys.set(code || key, { key, code });
        if (copying) {
          const copied = await takeCopiedText(tab);
          if (copied) viewer.push({ _tag: "clipboard", text: copied });
        }
        return;
      }
      case "text":
        if (typeof message.text === "string" && message.text.length > 0) {
          await session.send("Input.insertText", { text: message.text.slice(0, 10_000) });
        }
        return;
      case "resize": {
        const width = Math.min(Math.round(num(message.width)), 3840);
        const height = Math.min(Math.round(num(message.height)), 2160);
        if (width < 100 || height < 100) return;
        viewer.requestedSize = { width, height, order: ++viewerResizeOrder };
        if (tab.setting._tag !== "fill" || tab.desktop) return;
        const current = tab.page.viewportSize();
        if (current?.width === width && current.height === height) return;
        await tab.page.setViewportSize({ width, height });
        // tempo: Playwright's resize also drops the tab's zoom.
        await pinViewport(tab);
        broadcastViewport(tab);
        return;
      }
      case "viewport": {
        const setting = decodeViewportSetting(message.setting);
        await runPromise(
          manager.resize({ threadId: tab.threadId, tabId: tab.tabId, viewport: setting }),
        );
        await applySetting(tab, setting);
        return;
      }
      // A stalled navigation must not block a corrected URL or further viewer input.
      // tempo: asPerson, so a page a person loads can get its saved passkeys back.
      case "navigate":
        if (typeof message.url === "string") {
          const url = normalizePreviewUrl(message.url);
          tab.control.trackUntilHandoff(
            asPerson(tab, () => tab.page.goto(url, VIEWER_NAVIGATION_OPTIONS)),
          );
        }
        return;
      case "history":
        tab.control.trackUntilHandoff(
          asPerson(tab, () =>
            num(message.delta) < 0
              ? tab.page.goBack(VIEWER_NAVIGATION_OPTIONS)
              : tab.page.goForward(VIEWER_NAVIGATION_OPTIONS),
          ),
        );
        return;
      case "reload":
        // tempo: a hard reload returns before its page commits, so it never counts as asPerson.
        if (message.ignoreCache === true) {
          await session.send("Page.reload", { ignoreCache: true });
          return;
        }
        tab.control.trackUntilHandoff(
          asPerson(tab, () => tab.page.reload(VIEWER_NAVIGATION_OPTIONS)),
        );
        return;
      case "probe": {
        const x = num(message.x);
        const y = num(message.y);
        const result = await session.send("Runtime.evaluate", {
          expression: `(${EDITABLE_AT_POINT_SCRIPT})(${x}, ${y})`,
          returnByValue: true,
        });
        viewer.push({ _tag: "probe", x, y, editable: result.result.value === true });
        return;
      }
    }
  };

  const attachViewer: ServerBrowser["Service"]["attachViewer"] = Effect.fn(
    "ServerBrowser.attachViewer",
  )(function* (input) {
    const tab = yield* findTab(input.threadId, input.tabId);
    const output = yield* Queue.make<ServerBrowserViewerOutput>({
      capacity: VIEWER_OUTPUT_LIMIT,
      strategy: "dropping",
    });
    const session = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => tab.page.context().newCDPSession(tab.page),
        catch: (cause) => new ServerBrowserLaunchError({ cause }),
      }),
      (session) =>
        Effect.promise(() =>
          session
            .send("Page.stopScreencast")
            .catch(constVoid)
            .then(() => detachPageSession(tab, session)),
        ),
    );
    const quality = Math.min(100, Math.max(1, Math.round(input.quality)));
    // Chromium may drop the final frame during a burst; send a still when it settles.
    let framesInFlight = 0;
    let mayHaveDropped = false;
    let motion = false;
    const recentFrames: Array<number> = [];
    let screencastParams = Promise.resolve();
    let screencastScale = 1;
    // tempo: a viewer whose acks time its frames gets them sized to its link (StreamLink). A settled
    // page streams at the sharpest level so a lone repaint (a caret's blink) stays sharp; input or
    // a run of frames drops it to the link's level (`live`) until the page settles again.
    // `screencastLevel` is the level running, null before the link is measured.
    const link = new StreamLink();
    let screencastLevel: number | null = null;
    let live = false;
    // tempo: a restart emits one frame of the page as it is, even an idle one,
    // and it is always sent: it may already show the input that caused it.
    let restarting = false;
    // tempo: Chromium's screencast can go quiet after a restart or a size or
    // scale change; a frame that is due and does not come restarts it.
    let dueTimer: ReturnType<typeof setTimeout> | null = null;
    let dueRestarts = 0;
    // tempo: acks go evenly and no faster than the viewer's link takes frames;
    // each used to go 100 ms after its frame came, in bursts of three.
    let lastAckAt = 0;
    const nextAckAt = () => {
      lastAckAt = Math.max(Date.now(), lastAckAt + link.frameIntervalMs);
      return lastAckAt;
    };
    const startScreencast = (scale: number) => {
      screencastScale = scale;
      screencastLevel = link.measured ? (live ? link.level : STILL_LEVEL) : null;
      screencastParams = screencastParams.then(async () => {
        if (tab.capturing > 0) return;
        const settings =
          screencastLevel === null
            ? {
                scale: screencastScale,
                quality:
                  screencastScale < 1 ? Math.min(quality, SCREENCAST_MOTION_QUALITY) : quality,
              }
            : STREAM_LEVELS[screencastLevel]!;
        await session.send("Page.stopScreencast").catch(constVoid);
        restarting = true;
        await session
          .send("Page.startScreencast", {
            format: "jpeg",
            quality: settings.quality,
            maxWidth: Math.max(1, Math.round(input.maxWidth * settings.scale)),
            maxHeight: Math.max(1, Math.round(input.maxHeight * settings.scale)),
          })
          .catch(constVoid);
        expectFrame(FRAME_DUE_MS);
      });
      return screencastParams;
    };
    const expectFrame = (dueMs: number) => {
      if (dueTimer !== null) clearTimeout(dueTimer);
      dueTimer = setTimeout(() => {
        dueTimer = null;
        // Chromium sends nothing while it waits for acks, which is no stall.
        if (framesInFlight >= CHROMIUM_FRAMES_IN_FLIGHT) return expectFrame(dueMs);
        if (dueRestarts >= FRAME_DUE_RESTARTS) return;
        dueRestarts += 1;
        void startScreencast(screencastScale);
      }, dueMs);
    };
    // tempo: called ahead of a viewer's input too, so the frame showing its
    // effect comes small and fast.
    const goLive = () => {
      if (!link.measured || live || link.level === STILL_LEVEL) return;
      live = true;
      void startScreencast(1);
    };
    const viewer: ViewerState = {
      id: NodeCrypto.randomUUID(),
      canOperate: input.canOperate,
      sessionId: input.sessionId,
      pressedKeys: new Map(),
      pressedButtons: new Map(),
      push: (next) => {
        // Dropped frames must still release Chromium.
        if (Queue.offerUnsafe(output, next)) return;
        if (next._tag === "frame") runFork(next.ack);
        // State a stalled viewer cannot miss replaces its backlog. It runs
        // synchronously so an older replacement can never land after a newer one.
        else if (next._tag === "gone" || next._tag === "control" || next._tag === "fileChooser") {
          const dropped = Effect.runSyncExit(Queue.clear(output));
          if (dropped._tag === "Failure") return;
          Queue.offerUnsafe(output, next);

          const chooser = next._tag === "control" ? fileChooserMessage(tab) : null;
          if (chooser && tab.control.controller === viewer.id) Queue.offerUnsafe(output, chooser);
          for (const item of dropped.value) if (item._tag === "frame") runFork(item.ack);
        }
      },
      pause: () => {
        screencastParams = screencastParams.then(() =>
          session.send("Page.stopScreencast").then(constVoid, constVoid),
        );
        return screencastParams;
      },
      resume: () => startScreencast(screencastScale),
      // tempo: SessionControl calls this for whichever viewer loses the tab.
      releaseInput: () => releaseViewerInput(viewer, session),
      expectFrame,
      scrolledAt: 0,
      inputAt: 0,
      requestedSize: null,
    };
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        tab.viewers.add(viewer);
        reportLiveTabs();
      }),
      () =>
        Effect.promise(async () => {
          await tab.control.disconnect(viewer.id);
          tab.viewers.delete(viewer);
          broadcastControl(tab);
          reportLiveTabs();
        }),
    );
    // tempo: a person's own tab is theirs from the moment they open it, so it fits
    // their panel and sign-ins the page starts reach them. Agent tabs are
    // claimed by a person's first deliberate input instead.
    if (input.canOperate && tab.control.agentId === null && tab.control.controller === null)
      tab.control.claim(viewer.id);
    broadcastControl(tab);
    pushFileChooser(tab);
    const pushStill = async () => {
      const data = await withCaptureLock(tab, () =>
        ServerBrowserPage.captureViewport(session, { format: "jpeg", quality }),
      ).catch(() => null);
      // tempo: a still shows the pinned view, the tab's layout.
      const page = layoutSize(tab);
      if (data)
        viewer.push({
          _tag: "frame",
          data: Buffer.from(data, "base64"),
          ack: Effect.void,
          ...(page ? { page } : {}),
          level: STILL_LEVEL,
        });
    };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (settleTimer !== null) clearTimeout(settleTimer);
        if (dueTimer !== null) clearTimeout(dueTimer);
      }),
    );
    const settleLater = () => {
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        // tempo: a measured link's settled page streams sharp again, and the
        // restart's own frame is the sharp still, sized and acked like any
        // other. A captured still would repaint into a frame of its own and
        // keep the page from settling.
        if (link.measured) {
          if (!live && !mayHaveDropped) return;
          live = false;
          mayHaveDropped = false;
          recentFrames.length = 0;
          void startScreencast(1);
          return;
        }
        if (!motion && !mayHaveDropped) return;
        mayHaveDropped = false;
        if (motion) {
          motion = false;
          recentFrames.length = 0;
          void startScreencast(1);
        }
        void pushStill();
      }, SCREENCAST_SETTLE_MS);
    };
    let screencastStarted = false;
    session.on("Page.screencastFrame", (frame) => {
      screencastStarted = true;
      if (dueTimer !== null) clearTimeout(dueTimer);
      dueTimer = null;
      dueRestarts = 0;
      // tempo: a restart's frame shows the page as it is: no sign of a drop or of movement.
      const restarted = restarting;
      restarting = false;
      const level = screencastLevel ?? STILL_LEVEL;
      if (framesInFlight > 0 && !restarted) mayHaveDropped = true;
      framesInFlight += 1;
      const arrivedAt = Date.now();
      recentFrames.push(arrivedAt);
      while (recentFrames[0]! < arrivedAt - SCREENCAST_MOTION_WINDOW_MS) recentFrames.shift();
      // tempo: on a measured link a run of frames is movement, input or not.
      if (link.measured) {
        if (!live && !restarted && recentFrames.length >= MEASURED_MOTION_FRAMES) goLive();
        else if (live && link.level !== screencastLevel) void startScreencast(1);
      } else if (
        !motion &&
        recentFrames.length >= SCREENCAST_MOTION_FRAMES &&
        arrivedAt - viewer.scrolledAt < SCREENCAST_MOTION_WINDOW_MS
      ) {
        motion = true;
        void startScreencast(0.5);
      } else if (motion && arrivedAt - viewer.scrolledAt > SCREENCAST_SETTLE_MS) {
        motion = false;
        recentFrames.length = 0;
        void startScreencast(1);
      }
      settleLater();
      // tempo: the CSS size Chromium captured, which viewers map pointers through.
      // Any other size than the layout means the shared headless window re-laid
      // out the view, so it is pinned back. A pin that changes nothing emits no
      // frame, so this cannot feed itself.
      const page = {
        width: Math.round(frame.metadata.deviceWidth),
        height: Math.round(frame.metadata.deviceHeight),
      };
      const layout = layoutSize(tab);
      if (
        layout &&
        !tab.pinning &&
        (Math.abs(page.width - layout.width) > 1 || Math.abs(page.height - layout.height) > 1)
      )
        void pinViewport(tab);
      viewer.push({
        _tag: "frame",
        data: Buffer.from(frame.data, "base64"),
        page,
        level,
        ack: Effect.promise(() =>
          sleepUntil(nextAckAt()).then(() => {
            framesInFlight -= 1;
            return session
              .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
              .catch(constVoid);
          }),
        ),
      });
    });
    broadcastViewport(tab);
    // tempo: a view the shared window re-laid out shows the right size from the first frame.
    yield* Effect.promise(() => pinViewport(tab));
    yield* Effect.promise(() => startScreencast(1));
    // An idle page does not repaint for a new screencast, so the viewer
    // starts from a still unless a live frame beat it.
    if (!screencastStarted) yield* Effect.promise(pushStill);
    // tempo: a pointer move or wheel turn still queued behind slow page input
    // takes in the ones after it, so the page catches up with the pointer
    // instead of replaying its path. Any other input ends the merge, in order.
    let waiting: { message: Record<string, unknown> } | null = null;
    const merge = (message: Record<string, unknown>) => {
      if (waiting === null || waiting.message.type !== message.type) return false;
      waiting.message =
        message.type === "wheel"
          ? {
              ...message,
              deltaX: num(waiting.message.deltaX) + num(message.deltaX),
              deltaY: num(waiting.message.deltaY) + num(message.deltaY),
            }
          : message;
      return true;
    };
    return {
      output,
      link,
      input: (raw: unknown) =>
        Effect.promise(async () => {
          if (!viewer.canOperate) return;
          const message = asRecord(raw);
          if (!message) return;
          try {
            // tempo: deliberate input, takeControl included, claims the tab from
            // an agent or another viewer; passive input needs it already. The
            // claim runs before any await and a viewer's messages start in
            // order (ServerBrowserStream), so it lands before the next input.
            if (claimsBrowserControl(message) && tab.control.claim(viewer.id)) {
              pushFileChooser(tab);
            }
            const merges =
              message.type === "wheel" || (message.type === "mouse" && message.action === "move");
            if (merges && merge(message)) return;
            const slot = { message };
            waiting = merges ? slot : null;
            // tempo: the frame showing this input's effect comes at the link's level.
            if (POINTER_AND_KEY_INPUT.has(String(message.type))) goLive();
            if (message.type === "releaseControl") {
              await tab.control.release(viewer.id);
            } else if (
              message.type === "dialog" &&
              tab.control.controller === viewer.id &&
              typeof message.accept === "boolean"
            ) {
              await resolveDialog(tab, {
                accept: message.accept,
                ...(typeof message.promptText === "string"
                  ? { promptText: message.promptText }
                  : {}),
              });
            } else if (message.type !== "takeControl") {
              await tab.control
                .human(viewer.id, () => {
                  if (waiting === slot) waiting = null;
                  return dispatchViewerInput(tab, session, viewer, slot.message);
                })
                .finally(() => {
                  if (waiting === slot) waiting = null;
                });
            }
          } catch {
            broadcastControl(tab);
          }
        }),
    } satisfies ServerBrowserViewer;
  });

  yield* manager.events.pipe(Stream.runForEach(mirrorManagerEvent), Effect.forkScoped);
  if (
    !PreviewBrowserHost.sandboxDisabled(yield* HostProcess.Environment) &&
    (yield* PreviewBrowserHost.sandboxBlocked)
  ) {
    yield* Effect.logWarning(
      `This host blocks the sandbox ${TEMPO_APP_BASE_NAME}'s browser runs in, so browser tabs and HTML previews will not start. Run \`${setupCommand}\` once to allow it.`,
    );
  }

  yield* desktopChannel.detached.pipe(
    Stream.runForEach((key) =>
      Effect.sync(() => {
        const tab = tabs.get(tabKey(key.threadId, key.tabId));
        if (tab?.desktop) dropTab(tab, false);
      }),
    ),
    Effect.forkScoped,
  );
  // The desktop keeps the tabs an agent uses focused until its turn ends, not just per command.
  yield* Stream.fromSubscription(agentTurns).pipe(
    Stream.runForEach((change) => desktopChannel.turn(change.threadId, change.active)),
    Effect.forkScoped,
  );
  // Reconnect returned pages immediately so all clients keep receiving URL and title changes.
  yield* desktopChannel.attached.pipe(
    Stream.runForEach((key) =>
      Effect.gen(function* () {
        if (tabs.has(tabKey(key.threadId, key.tabId))) return;
        const { sessions } = yield* manager.list({ threadId: ThreadId.make(key.threadId) });
        const snapshot = sessions.find(
          (session) => session.tabId === key.tabId && session.runtime === "server",
        );
        if (snapshot) yield* Effect.promise(() => ensureTab(snapshot).catch(constVoid));
      }).pipe(Effect.ignore),
    ),
    Effect.forkScoped,
  );
  yield* Effect.sync(closeIdleAgentTabs).pipe(
    Effect.repeat(Schedule.spaced(IDLE_SWEEP_INTERVAL)),
    Effect.forkScoped,
  );
  const environmentId = yield* environment.getEnvironmentId;
  const hostSession = broker
    .connect(
      {
        clientId: SERVER_HOST_CLIENT_ID,
        environmentId,
        supportedOperations: [...PREVIEW_AUTOMATION_SERVER_OPERATIONS],
      },
      { preferred: true },
    )
    .pipe(
      Effect.flatMap((events) =>
        events.pipe(
          Stream.runForEach((event) => {
            if (event.type === "connected") {
              hostConnectionId = event.connectionId;
              return Effect.sync(reportLiveTabs);
            }
            return handleRequest(event.connectionId, event.request).pipe(
              Effect.forkScoped,
              Effect.asVoid,
            );
          }),
        ),
      ),
    );
  /**
   * tempo: a profile's extensions changed. Its browser relaunches with them and
   * its tabs reopen at their pages; viewers reconnect to the new tabs. Returns
   * once they have, so the next change never closes a browser under tabs
   * still reopening.
   */
  const restartProfile = async (profileId: string) => {
    // The old tabs keep working while a first extension's browser installs.
    if (tempoBrowser) await runPromise(tempoBrowser.profileLaunchReady(profileId));
    // A tab still opening may be opening in the browser about to close; once
    // open, it reopens with the rest. Nothing yields from here to the close.
    await Promise.allSettled(pendingTabs.values());
    // Dropped before their browser closes, which would otherwise end their sessions.
    // A tab in a profile's own browser is one its saved passkeys reach; a popup
    // of an incognito or throwaway tab is not, though it carries the profile id.
    const affected = [...tabs.values()]
      .filter(
        (tab) =>
          tab.passkeys !== null && (tab.profileId ?? DEFAULT_BROWSER_PROFILE_ID) === profileId,
      )
      .map(({ threadId, tabId, page, passkeys, control }) => {
        const key = tabKey(threadId, tabId);
        reopenAgentTouched.set(key, passkeys?.agentTouched() ?? control.agentId !== null);
        return { key, threadId, tabId, url: page.url() };
      });
    for (const { key } of affected) {
      const tab = tabs.get(key);
      restartingTabs.add(key);
      if (tab) dropTab(tab, false);
      restartingTabs.delete(key);
    }
    const restarted = contexts.restartProfile(profileId);
    const reopenings = affected.map((tab) => {
      const { key, url } = tab;
      const reopening = restarted
        .catch(constVoid)
        .then(() => runPromise(manager.list({ threadId: tab.threadId })))
        .then(async ({ sessions }) => {
          const snapshot = sessions.find((session) => session.tabId === tab.tabId);
          if (!snapshot) {
            throw new ServerBrowserTabNotFoundError({ threadId: tab.threadId, tabId: tab.tabId });
          }
          const reopened = await createTab(
            /^https?:/i.test(url)
              ? { ...snapshot, navStatus: { _tag: "Loading", url, title: "" } }
              : snapshot,
          );
          // An extension's page comes back too; it fails visibly if the extension is gone.
          if (url.startsWith("chrome-extension://")) {
            reopened.initialNavigation = reopened.page
              .goto(url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS })
              .then(constVoid);
            void reopened.initialNavigation.catch(constVoid);
          }
          return reopened;
        })
        .finally(() => {
          pendingTabs.delete(key);
          closedPendingTabs.delete(key);
          reopenAgentTouched.delete(key);
        });
      pendingTabs.set(key, reopening);
      return reopening.catch((cause: unknown) =>
        runFork(
          Effect.logWarning("Could not reopen a tab after its profile restarted.", { cause }),
        ),
      );
    });
    await Promise.all(reopenings);
    await restarted;
  };
  if (tempoBrowser) {
    yield* (yield* tempoBrowser.profileChanges).pipe(
      Stream.runForEach((profileId) =>
        Effect.tryPromise(() => restartProfile(profileId)).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not restart a browser profile.", { cause }),
          ),
        ),
      ),
      Effect.forkScoped,
    );
  }

  const openPage: ServerBrowser["Service"]["openPage"] = (input) =>
    Effect.tryPromise({
      try: async () => {
        if (input.profileId === INCOGNITO_BROWSER_PROFILE_ID) {
          throw new Error("Incognito tabs cannot open extension pages.");
        }
        const context = await contexts.contextFor(input.profileId);
        await prepareContext(context);
        const page = await context.newPage();
        claimedPages.add(page);
        const snapshot = await runPromise(
          manager.open({
            threadId: input.threadId,
            runtime: "server",
            profileId: input.profileId,
            beforePublish: (opened) =>
              adoptedPages.set(tabKey(opened.threadId, opened.tabId), {
                page,
                openerTabId: undefined,
                passkeys: { agentTouched: false },
              }),
          }),
        ).catch(async (cause: unknown) => {
          await page.close().catch(constVoid);
          throw cause;
        });
        const tab = await ensureTab(snapshot);
        tab.initialNavigation = tab.page
          .goto(input.url, { waitUntil: "commit", timeout: NAVIGATION_TIMEOUT_MS })
          .then(constVoid);
        void tab.initialNavigation.catch(constVoid);
        return { tabId: snapshot.tabId };
      },
      catch: (cause) => new ServerBrowserLaunchError({ cause }),
    });

  // The broker disconnects timed-out hosts, including slow first installs. Reconnect.
  yield* hostSession.pipe(
    Effect.exit,
    Effect.andThen(Effect.sleep(HOST_RECONNECT_DELAY)),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      await contexts.close();
    }),
  );

  const clearProfile = (profileId: string) =>
    Effect.tryPromise({
      try: () => contexts.clearProfile(profileId),
      catch: (cause) => new PreviewClearProfileError({ profileId, cause }),
    });

  return ServerBrowser.of({
    attachViewer,
    clearProfile,
    reportProfiles,
    openDownload,
    thumbnail,
    answerFileChooser,
    openPage,
  });
});

export const layer = Layer.effect(ServerBrowser, make);
