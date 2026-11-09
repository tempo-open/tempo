// @effect-diagnostics nodeBuiltinImport:off -- PATH lookup checks executables synchronously at the launcher boundary.
// @effect-diagnostics globalDate:off -- The host core keeps wall-clock grant times outside Effect.

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";

import {
  DesktopLaptopToolsConfig,
  LaptopToolDescriptor,
  type DesktopLaptopToolsCancelInput,
  type DesktopLaptopToolsHandleInput,
  type DesktopLaptopToolsRunChangedInput,
  type DesktopLaptopToolsState,
  type DesktopLaptopToolsStopInput,
  type LaptopToolsOutcome,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopAssets from "../../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import { macPasskeyBackend } from "../../preview/PasskeyBackendMac.ts";
import * as PreviewPasskeys from "../../preview/Passkeys.ts";
import {
  LaptopPasskeys,
  laptopPasskeyStatus,
  type PasskeyPrompt,
} from "../passkeys/LaptopPasskeys.ts";
import { LAPTOP_TOOLS_STATE_CHANNEL } from "./channels.ts";
import { DEFAULT_LAPTOP_TOOLS_CONFIG, laptopToolDisplayText } from "./laptopToolConfig.ts";
import type { LaptopToolConsentDecision, LaptopToolConsentRequest } from "./laptopToolGrants.ts";
import { LaptopToolsHost, type LaptopToolCatalog } from "./LaptopToolsHost.ts";

export class DesktopLaptopToolsConfigWriteError extends Schema.TaggedError<DesktopLaptopToolsConfigWriteError>()(
  "DesktopLaptopToolsConfigWriteError",
  { path: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save laptop tool settings to ${this.path}.`;
  }
}

/**
 * tempo laptop tools on this desktop: the MCP servers it offers remote agents,
 * the person's consent to each, and the requests the renderer forwards from
 * connected environments.
 */
export class DesktopLaptopTools extends Context.Service<
  DesktopLaptopTools,
  {
    readonly getState: Effect.Effect<DesktopLaptopToolsState>;
    readonly setConfig: (
      config: DesktopLaptopToolsConfig,
    ) => Effect.Effect<DesktopLaptopToolsState, DesktopLaptopToolsConfigWriteError>;
    readonly handleRequest: (
      input: DesktopLaptopToolsHandleInput,
    ) => Effect.Effect<LaptopToolsOutcome>;
    readonly cancelRequest: (input: DesktopLaptopToolsCancelInput) => Effect.Effect<void>;
    readonly stop: (input: DesktopLaptopToolsStopInput) => Effect.Effect<void>;
    readonly runChanged: (input: DesktopLaptopToolsRunChangedInput) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/tempo/laptopTools/DesktopLaptopTools") {}

const ConfigJson = fromLenientJson(DesktopLaptopToolsConfig);
const decodeConfig = Schema.decodeEffect(ConfigJson);
const encodeConfig = Schema.encodeEffect(ConfigJson);

const CatalogJson = fromLenientJson(
  Schema.Record(
    Schema.String,
    Schema.Struct({
      launchKey: Schema.String,
      tools: Schema.Array(LaptopToolDescriptor),
      error: Schema.optionalKey(Schema.String),
    }),
  ),
);
const decodeCatalog = Schema.decodeEffect(CatalogJson);
const encodeCatalog = Schema.encodeEffect(CatalogJson);

const SERVER_PURPOSE: Readonly<Record<string, string>> = {
  "computer-use": "It can see your screen and use your mouse and keyboard.",
  "laptop-browser": "It can browse with this laptop's browser, including its logins and localhost.",
};

const isExecutableFile = (candidate: string): boolean => {
  try {
    if (!NodeFS.statSync(candidate).isFile()) return false;
    NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const hostLabel = (): string => {
  const name = NodeOS.hostname()
    .replace(/\.local$/u, "")
    .trim();
  return name.length > 0 ? name : "This laptop";
};

/** Makes `window` able to carry a sheet without taking focus from the app in front. */
const prepareOwner = (window: Electron.BrowserWindow) => {
  if (window.isMinimized()) window.restore();
  else if (!window.isVisible()) window.showInactive();
};

/**
 * Asks whether a thread may use a tool, as a sheet on the app window: a parentless macOS box would
 * block the main process and could not close when `signal` aborts. It takes no focus; the Dock
 * bounces and a notification opens the window. The agent-settable thread title only appears
 * below the app's own words, and Deny is the default so a stray Enter allows nothing.
 */
async function promptForConsent(
  owner: Electron.BrowserWindow | undefined,
  request: LaptopToolConsentRequest,
  signal: AbortSignal,
): Promise<LaptopToolConsentDecision> {
  if (signal.aborted || owner === undefined || owner.isDestroyed()) return "dismissed";
  prepareOwner(owner);
  const environment = laptopToolDisplayText(request.environmentLabel);
  const bounce = Electron.app.dock?.bounce("critical");
  const notification = Electron.Notification.isSupported()
    ? new Electron.Notification({
        title: "Laptop tool request",
        body: `An agent on ${environment} wants to use ${request.serverName}. Open ${TEMPO_APP_BASE_NAME} to answer.`,
      })
    : null;
  notification?.on("click", () => {
    if (owner.isDestroyed()) return;
    owner.show();
    owner.focus();
  });
  notification?.show();
  const purpose = SERVER_PURPOSE[request.serverId] ?? "It runs on this laptop.";
  try {
    const { response } = await Electron.dialog.showMessageBox(owner, {
      type: "warning",
      title: "Laptop tool request",
      message: `An agent on ${environment} wants to use ${request.serverName} on this laptop.`,
      detail: [
        `Thread: “${laptopToolDisplayText(request.threadTitle)}”`,
        purpose,
        "Allowing covers this thread until its run ends or it goes unused for 30 minutes. Deny, or leaving this unanswered, refuses it for the rest of the run. Stop it any time from the laptop tools menu bar item.",
      ].join("\n\n"),
      buttons: ["Deny", "Allow for this thread"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal,
    });
    if (signal.aborted) return "dismissed";
    return response === 1 ? "allow" : "deny";
  } finally {
    notification?.close();
    if (bounce !== undefined) Electron.app.dock?.cancelBounce(bounce);
  }
}

/**
 * Asks before a passkey ceremony the person did not start on this Mac: an
 * agent's, or one from a page nobody is driving; and before the first one an
 * environment says the person started for a site. The system sheet that
 * follows names only the site, so this says which thread and machine ask.
 */
async function promptForPasskey(
  owner: Electron.BrowserWindow | undefined,
  prompt: PasskeyPrompt,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || owner === undefined || owner.isDestroyed()) return false;
  prepareOwner(owner);
  const bounce = Electron.app.dock?.bounce("critical");
  const who =
    prompt.requester === "agent"
      ? "An agent"
      : prompt.requester === "person"
        ? "A browser tab you are driving"
        : "A browser tab nobody is driving";
  try {
    const { response } = await Electron.dialog.showMessageBox(owner, {
      type: "warning",
      title: "Passkey request",
      message: `${who} on ${laptopToolDisplayText(prompt.environmentLabel)} wants to ${
        prompt.ceremony === "create" ? "create a passkey for" : "sign in to"
      } ${laptopToolDisplayText(prompt.rpId, 80)} with this Mac's passkeys.`,
      detail: [
        `Thread: “${laptopToolDisplayText(prompt.threadTitle)}”`,
        prompt.requester === "person"
          ? `This is the first passkey request for this site from that machine. Deny it if you did not just start this sign-in. Continue opens the passkey sheet, and later requests for this site from that machine go straight to it until ${TEMPO_APP_BASE_NAME} quits. Deny, or leaving this unanswered, refuses it, and this site does not ask again for a minute.`
          : "Continue opens the passkey sheet for this one request. Deny, or leaving this unanswered, refuses it, and this thread does not ask again for a minute.",
      ].join("\n\n"),
      buttons: ["Deny", "Continue"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
      signal,
    });
    return !signal.aborted && response === 1;
  } finally {
    if (bounce !== undefined) Electron.app.dock?.cancelBounce(bounce);
  }
}

const broadcast = (state: DesktopLaptopToolsState) => {
  for (const window of Electron.BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(LAPTOP_TOOLS_STATE_CHANNEL, state);
  }
};

/**
 * The in-use indicator outside the app window: computer use drives other
 * apps, so the window is usually behind them. While any thread may use this
 * laptop, a menu bar (tray) item lists the grants with Stop, and on macOS the
 * Dock menu offers Stop too.
 */
function makeInUseIndicator(options: {
  readonly platform: NodeJS.Platform;
  readonly iconPath: Option.Option<string>;
  readonly stop: (key?: string) => void;
  readonly show: () => void;
}) {
  let tray: Electron.Tray | null = null;
  let dockMenuSet = false;

  const trayImage = (): Electron.NativeImage => {
    if (options.platform === "darwin") {
      // createFromNamedImage renders a 30 pt symbol and keeps its pixels as points, so on a
      // Retina screen the icon is 60 pt tall and the menu bar clips it to a grey box. Render
      // it large, then declare the pixel density that makes it 14 pt tall on any screen.
      const symbol = Electron.nativeImage.createFromNamedImage("laptopcomputer", { pointSize: 64 });
      const image = Electron.nativeImage.createFromBuffer(symbol.toPNG(), {
        scaleFactor: symbol.getSize().height / 14,
      });
      image.setTemplateImage(true);
      return image;
    }
    return Option.match(options.iconPath, {
      onNone: () => Electron.nativeImage.createEmpty(),
      onSome: (path) => Electron.nativeImage.createFromPath(path).resize({ width: 16, height: 16 }),
    });
  };

  const update = (state: DesktopLaptopToolsState) => {
    const grants = state.grants;
    if (grants.length === 0) {
      tray?.destroy();
      tray = null;
      if (dockMenuSet) {
        Electron.app.dock?.setMenu(Electron.Menu.buildFromTemplate([]));
        dockMenuSet = false;
      }
      return;
    }
    const busy = grants.some((grant) => grant.inFlight > 0);
    const menu = Electron.Menu.buildFromTemplate([
      { label: busy ? "Laptop tools in use" : "Laptop tools allowed", enabled: false },
      ...grants.map((grant): Electron.MenuItemConstructorOptions => ({
        label: `Stop ${grant.serverName} for “${laptopToolDisplayText(grant.threadTitle, 48)}” on ${laptopToolDisplayText(grant.environmentLabel, 32)}${grant.inFlight > 0 ? " (in use)" : ""}`,
        click: () => options.stop(grant.key),
      })),
      { type: "separator" },
      { label: "Stop all laptop tools", click: () => options.stop() },
      { label: `Show ${TEMPO_APP_BASE_NAME}`, click: options.show },
    ]);
    if (tray === null) {
      const image = trayImage();
      tray = new Electron.Tray(image);
      // Without an icon the title alone marks the menu bar item.
      if (options.platform === "darwin" && image.isEmpty()) tray.setTitle("Laptop tools");
    }
    tray.setToolTip(busy ? "Laptop tools in use" : "Laptop tools allowed");
    tray.setContextMenu(menu);
    if (Electron.app.dock !== undefined) {
      Electron.app.dock.setMenu(
        Electron.Menu.buildFromTemplate([
          { label: "Stop all laptop tools", click: () => options.stop() },
        ]),
      );
      dockMenuSet = true;
    }
  };

  const dispose = () => {
    tray?.destroy();
    tray = null;
  };

  return { update, dispose };
}

export const layer = Layer.effect(
  DesktopLaptopTools,
  Effect.gen(function* () {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const electronWindow = yield* ElectronWindow.ElectronWindow;
    const previewPasskeys = yield* PreviewPasskeys.PreviewPasskeys;
    const assets = yield* DesktopAssets.DesktopAssets;
    const iconPaths = yield* assets.iconPaths;
    const configPath = path.join(environment.stateDir, "tempo-laptop-tools.json");
    const catalogPath = path.join(environment.stateDir, "tempo-laptop-tools-catalog.json");
    const browserProfileDir = path.join(environment.stateDir, "tempo-laptop-browser-profile");

    const saved = yield* fileSystem.readFileString(configPath).pipe(
      Effect.flatMap((raw) => decodeConfig(raw)),
      Effect.orElseSucceed(() => DEFAULT_LAPTOP_TOOLS_CONFIG),
    );
    const savedCatalog = yield* fileSystem.readFileString(catalogPath).pipe(
      Effect.flatMap((raw) => decodeCatalog(raw)),
      Effect.orElseSucceed((): LaptopToolCatalog => ({})),
    );
    let writeSequence = 0;
    const writeAtomically = Effect.fn("desktop.tempo.laptopTools.writeAtomically")(function* (
      target: string,
      contents: string,
    ) {
      writeSequence += 1;
      const tempPath = `${target}.${process.pid}.${writeSequence}.tmp`;
      yield* fileSystem.makeDirectory(environment.stateDir, { recursive: true });
      yield* fileSystem.writeFileString(tempPath, `${contents}\n`);
      yield* fileSystem.rename(tempPath, target);
    });
    const writeConfig = (config: DesktopLaptopToolsConfig) =>
      encodeConfig(config).pipe(
        Effect.flatMap((encoded) => writeAtomically(configPath, encoded)),
        Effect.mapError(
          (cause) => new DesktopLaptopToolsConfigWriteError({ path: configPath, cause }),
        ),
      );
    const writeCatalog = (catalog: LaptopToolCatalog) =>
      encodeCatalog(catalog).pipe(
        Effect.flatMap((encoded) => writeAtomically(catalogPath, encoded)),
        Effect.ignore,
      );

    const runPromise = Effect.runPromiseWith(yield* Effect.context<never>());
    const ownerWindow = () =>
      runPromise(electronWindow.currentMainOrFirst).then(Option.getOrUndefined);
    const isConfigWriteError = Schema.is(DesktopLaptopToolsConfigWriteError);
    const stateChanged = yield* Queue.sliding<void>(1);
    let indicator: ReturnType<typeof makeInUseIndicator> | null = null;
    // tempo passkeys: server tabs' ceremonies, run with the in-app browser's passkey backend.
    let lastHostState: DesktopLaptopToolsState | null = null;
    const passkeys: LaptopPasskeys = new LaptopPasskeys({
      status: laptopPasskeyStatus({
        platform: environment.platform,
        systemVersion: process.getSystemVersion?.() ?? "0",
        entitled: previewPasskeys.bridgeEnabled,
      }),
      // The root module reports a native layer that failed to load as an unsuccessful answer.
      probe: () =>
        import("electron-webauthn")
          .then((webauthn) => webauthn.getListPasskeyAuthorizationStatus())
          .then((answer) => answer.success),
      enabled: () => (lastHostState?.config ?? saved).answerPasskeys !== false,
      backend: macPasskeyBackend,
      sheetWindow: async (request) => {
        const owner = await ownerWindow();
        if (owner === undefined || owner.isDestroyed()) return undefined;
        prepareOwner(owner);
        // The person driving the tab is already here; anyone else needs a nudge.
        if (request.requester !== "person" && !owner.isFocused()) {
          Electron.app.dock?.bounce("informational");
        }
        return owner.getNativeWindowHandle();
      },
      confirm: (prompt, signal) =>
        ownerWindow().then((owner) => promptForPasskey(owner, prompt, signal)),
      onChange: () => broadcast(withPasskeys(lastHostState ?? host.state())),
    });
    const withPasskeys = (state: DesktopLaptopToolsState): DesktopLaptopToolsState => ({
      ...state,
      passkeys: passkeys.state(),
    });
    const host = new LaptopToolsHost(
      {
        hostLabel: hostLabel(),
        clientVersion: environment.appVersion,
        platform: environment.platform,
        browserProfileDir,
        env: () => process.env,
        isExecutableFile,
        prompt: (request, signal) =>
          ownerWindow().then((owner) => promptForConsent(owner, request, signal)),
        now: () => Date.now(),
        onState: (state) => {
          lastHostState = state;
          broadcast(withPasskeys(state));
          indicator?.update(state);
          Queue.offerUnsafe(stateChanged, undefined);
        },
        saveConfig: (config) => runPromise(writeConfig(config)),
        catalog: savedCatalog,
        saveCatalog: (catalog) => runPromise(writeCatalog(catalog)),
      },
      saved,
    );
    indicator = makeInUseIndicator({
      platform: environment.platform,
      iconPath: environment.platform === "win32" ? iconPaths.ico : iconPaths.png,
      stop: (key) => host.stop(key),
      show: () => {
        void ownerWindow().then((window) => {
          if (window === undefined || window.isDestroyed()) return;
          window.show();
          window.focus();
        });
      },
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        host.dispose();
        indicator?.dispose();
      }),
    );
    // The sweep runs every minute only while a grant or a running server could
    // expire, so laptop tools nobody is using never wake the app. Every grant and
    // server start reports a state change, which brings it back.
    yield* Effect.gen(function* () {
      while (true) {
        while (!host.expiring()) yield* Queue.take(stateChanged);
        yield* Effect.sleep("1 minute");
        host.sweep();
      }
    }).pipe(Effect.forkScoped);

    return DesktopLaptopTools.of({
      getState: Effect.sync(() => withPasskeys(host.state())),
      setConfig: Effect.fn("DesktopLaptopTools.setConfig")(function (config) {
        return Effect.tryPromise({
          try: () => host.setConfig(config).then(withPasskeys),
          catch: (cause) =>
            isConfigWriteError(cause)
              ? cause
              : new DesktopLaptopToolsConfigWriteError({ path: configPath, cause }),
        });
      }),
      handleRequest: Effect.fn("DesktopLaptopTools.handleRequest")(function (input) {
        const request = input.request;
        return Effect.promise(() =>
          request._tag === "passkey"
            ? passkeys.handle({ ...input, request })
            : host.handleRequest(input),
        );
      }),
      cancelRequest: Effect.fn("DesktopLaptopTools.cancelRequest")(function (input) {
        return Effect.sync(() => {
          host.cancelRequest(input.environmentId, input.requestId);
          passkeys.cancel(input.environmentId, input.requestId);
        });
      }),
      stop: Effect.fn("DesktopLaptopTools.stop")(function (input) {
        return Effect.sync(() => host.stop(input.key));
      }),
      runChanged: Effect.fn("DesktopLaptopTools.runChanged")(function (input) {
        return Effect.sync(() =>
          host.runChanged(input.environmentId, input.threadId, input.activeRunId),
        );
      }),
    });
  }),
);
