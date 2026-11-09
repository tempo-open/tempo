import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as Electron from "electron";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as TempoChannels from "./channels.ts";

/**
 * tempo: with Settings → About → Install updates automatically on, a downloaded update installs when
 * the app quits, or the app restarts into it once this Mac has had no input for `AWAY_AFTER` and
 * no agent turn runs on the environments it hosts. The renderer counts those turns
 * (apps/web/src/tempo/DesktopUpdateAutoInstall.tsx); with no window to tell, it waits for a quit.
 */

/** No input anywhere on this Mac for this long means the person is away. */
export const AWAY_AFTER = Duration.minutes(10);
/** How often a downloaded update looks for its moment. */
export const CHECK_INTERVAL = Duration.minutes(1);

export class TempoUpdateAutoInstall extends Context.Service<
  TempoUpdateAutoInstall,
  {
    /** The device's own choice; on unless the person turned it off. */
    readonly enabled: Effect.Effect<boolean>;
    /** Seconds since the last keyboard, mouse or trackpad input on this Mac. */
    readonly idleSeconds: Effect.Effect<number>;
    /** Agent turns running on the environments this app hosts, or null when no window knows. */
    readonly localTurns: Effect.Effect<number | null>;
    readonly reportLocalTurns: (windowId: number, turns: number | null) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/tempo/updateAutoInstall/TempoUpdateAutoInstall") {}

/** `windowIsOpen` drops the report of a window that has since closed. */
export const make = Effect.fn("desktop.tempo.updateAutoInstall.make")(function* (
  windowIsOpen: (windowId: number) => boolean,
) {
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  const reports = yield* Ref.make<ReadonlyMap<number, number | null>>(new Map());

  return TempoUpdateAutoInstall.of({
    enabled: clientSettings.get.pipe(
      Effect.map(Option.match({ onNone: () => true, onSome: (s) => s.autoInstallDesktopUpdates })),
      // Settings shows the defaults for an unreadable file too.
      Effect.orElseSucceed(() => true),
    ),
    idleSeconds: powerMonitor.getSystemIdleTime,
    // Every window counts the same environments, so one window that can tell is enough.
    localTurns: Ref.get(reports).pipe(
      Effect.map((all) => {
        let turns: number | null = null;
        for (const [windowId, reported] of all) {
          if (reported !== null && windowIsOpen(windowId)) turns = Math.max(turns ?? 0, reported);
        }
        return turns;
      }),
    ),
    reportLocalTurns: Effect.fn("desktop.tempo.updateAutoInstall.reportLocalTurns")(function* (
      windowId: number,
      turns: number | null,
    ) {
      yield* Ref.update(reports, (all) =>
        new Map([...all].filter(([id]) => id !== windowId && windowIsOpen(id))).set(
          windowId,
          turns,
        ),
      );
    }),
  });
});

export const layer = Layer.effect(
  TempoUpdateAutoInstall,
  make((windowId) => Electron.webContents.fromId(windowId)?.isDestroyed() === false),
);

/**
 * Whether quitting should install the update `state` is about to download. A version that
 * already failed to apply here installs only from the restart button.
 */
export const installsOnQuit = (
  autoInstall: TempoUpdateAutoInstall["Service"],
  state: DesktopUpdateState,
): Effect.Effect<boolean> =>
  autoInstall.enabled.pipe(
    Effect.map((enabled) => enabled && state.availableVersion !== state.notAppliedVersion),
  );

/**
 * Restarts into a downloaded update once the person is away and nothing runs here. A version
 * waits one check after it downloads, so Squirrel.Mac has finished taking it, and is tried
 * once: one that failed to install, or failed to apply before, waits for the restart button.
 */
export const installWhenAway = Effect.fnUntraced(
  // Runs as long as the app does; the install it starts traces itself.
  function* (
    autoInstall: TempoUpdateAutoInstall["Service"],
    updates: {
      readonly state: Effect.Effect<DesktopUpdateState>;
      readonly install: (version: string) => Effect.Effect<{ readonly accepted: boolean }>;
    },
  ) {
    let seen: string | null = null;
    let settled: string | null = null;
    while (true) {
      yield* Effect.sleep(CHECK_INTERVAL);
      const state = yield* updates.state;
      if (state.errorContext === "install") settled = state.downloadedVersion;
      const version =
        state.downloadedVersion === state.notAppliedVersion ? null : state.downloadedVersion;
      const waited = version === seen;
      seen = version;
      if (version === null || !waited || version === settled) continue;
      if (
        !(yield* autoInstall.enabled) ||
        (yield* autoInstall.idleSeconds) < Duration.toSeconds(AWAY_AFTER) ||
        (yield* autoInstall.localTurns) !== 0
      ) {
        continue;
      }
      if ((yield* updates.install(version)).accepted) settled = version;
    }
  },
);

export const reportLocalTurns = DesktopIpc.makeIpcMethod({
  channel: TempoChannels.TEMPO_REPORT_LOCAL_TURNS_CHANNEL,
  payload: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.tempo.reportLocalTurns")(function* (turns, event) {
    if (event === undefined) return;
    const autoInstall = yield* TempoUpdateAutoInstall;
    yield* autoInstall.reportLocalTurns(event.sender.id, turns);
  }),
});
