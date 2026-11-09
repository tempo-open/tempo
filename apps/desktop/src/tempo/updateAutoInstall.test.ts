import { assert, describe, it } from "@effect/vitest";
import { type ClientSettings, DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as ElectronUpdater from "../electron/ElectronUpdater.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopUpdates from "../updates/DesktopUpdates.ts";
import {
  createInitialDesktopUpdateState,
  reduceDesktopUpdateStateOnDownloadComplete,
} from "../updates/updateMachine.ts";
import {
  flushCallbacks,
  makeHarness,
  type UpdatesHarnessOptions,
} from "../updates/updatesTestHarness.ts";
import * as TempoUpdateAutoInstall from "./updateAutoInstall.ts";

const AWAY_SECONDS = Duration.toSeconds(TempoUpdateAutoInstall.AWAY_AFTER);
const { CHECK_INTERVAL } = TempoUpdateAutoInstall;

/** What the policy reads about the person and this Mac; each test changes it as it goes. */
interface Moment {
  enabled: boolean;
  idleSeconds: number;
  localTurns: number | null;
}

function layerFor(start: Partial<Moment> = {}, options: UpdatesHarnessOptions = {}) {
  const moment: Moment = { enabled: true, idleSeconds: AWAY_SECONDS, localTurns: 0, ...start };
  const harness = makeHarness({
    // electron-updater ends every check with an event; this feed has nothing newer.
    checkForUpdates: Effect.sync(() => harness.emit("update-not-available")),
    ...options,
  });
  const layerAutoInstall = Layer.succeed(
    TempoUpdateAutoInstall.TempoUpdateAutoInstall,
    TempoUpdateAutoInstall.TempoUpdateAutoInstall.of({
      enabled: Effect.sync(() => moment.enabled),
      idleSeconds: Effect.sync(() => moment.idleSeconds),
      localTurns: Effect.sync(() => moment.localTurns),
      reportLocalTurns: () => Effect.void,
    }),
  );
  return {
    harness,
    moment,
    layer: Layer.merge(TestClock.layer(), harness.layer.pipe(Layer.provide(layerAutoInstall))),
  };
}

const configured = Effect.gen(function* () {
  const updates = yield* DesktopUpdates.DesktopUpdates;
  yield* updates.configure;
  return updates;
});

describe("DesktopUpdates installing by itself", () => {
  it.effect("installs a downloaded update once the person is away and nothing runs", () =>
    Effect.gen(function* () {
      const installed = yield* Deferred.make<void>();
      const { harness, layer } = layerFor(
        {},
        { quitAndInstall: Deferred.succeed(installed, undefined).pipe(Effect.asVoid) },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* configured;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          // The first check after the download leaves Squirrel.Mac time to take it.
          yield* TestClock.adjust(CHECK_INTERVAL);
          assert.equal(harness.quitAndInstalls(), 0);
          yield* TestClock.adjust(CHECK_INTERVAL);
          yield* Deferred.await(installed);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("waits while an agent turn runs here, or while no window can tell", () =>
    Effect.gen(function* () {
      const installed = yield* Deferred.make<void>();
      const { harness, moment, layer } = layerFor(
        { localTurns: 1 },
        { quitAndInstall: Deferred.succeed(installed, undefined).pipe(Effect.asVoid) },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* configured;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* TestClock.adjust(Duration.minutes(5));
          assert.equal(harness.quitAndInstalls(), 0);
          moment.localTurns = null;
          yield* TestClock.adjust(Duration.minutes(5));
          assert.equal(harness.quitAndInstalls(), 0);

          moment.localTurns = 0;
          yield* TestClock.adjust(CHECK_INTERVAL);
          yield* Deferred.await(installed);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("waits while someone uses the Mac", () =>
    Effect.gen(function* () {
      const installed = yield* Deferred.make<void>();
      const { harness, moment, layer } = layerFor(
        { idleSeconds: AWAY_SECONDS - 1 },
        { quitAndInstall: Deferred.succeed(installed, undefined).pipe(Effect.asVoid) },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* configured;
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* TestClock.adjust(Duration.minutes(5));
          assert.equal(harness.quitAndInstalls(), 0);

          moment.idleSeconds = AWAY_SECONDS;
          yield* TestClock.adjust(CHECK_INTERVAL);
          yield* Deferred.await(installed);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("quitting installs an update downloaded while the setting is on", () =>
    Effect.gen(function* () {
      const quitInstallsAtDownload: Array<boolean> = [];
      const downloadStarted = yield* Deferred.make<void>();
      const { harness, layer } = layerFor(
        {},
        {
          downloadUpdate: Effect.suspend(() => {
            quitInstallsAtDownload.push(harness.autoInstallOnAppQuit());
            return Deferred.succeed(downloadStarted, undefined).pipe(Effect.asVoid);
          }),
        },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* configured;
          harness.emit("update-available", { version: "1.2.4" });
          yield* Deferred.await(downloadStarted);

          // electron-updater reads this as the download lands and hands the update to
          // Squirrel.Mac, which installs it when the app exits.
          assert.deepEqual(quitInstallsAtDownload, [true]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("never installs by itself while the setting is off, not even on quit", () =>
    Effect.gen(function* () {
      const quitInstallsAtDownload: Array<boolean> = [];
      const downloadStarted = yield* Deferred.make<void>();
      const installed = yield* Deferred.make<void>();
      const { harness, moment, layer } = layerFor(
        { enabled: false },
        {
          downloadUpdate: Effect.suspend(() => {
            quitInstallsAtDownload.push(harness.autoInstallOnAppQuit());
            return Deferred.succeed(downloadStarted, undefined).pipe(Effect.asVoid);
          }),
          quitAndInstall: Deferred.succeed(installed, undefined).pipe(Effect.asVoid),
        },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* configured;
          harness.emit("update-available", { version: "1.2.4" });
          yield* Deferred.await(downloadStarted);
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* TestClock.adjust(Duration.minutes(30));
          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(quitInstallsAtDownload, [false]);

          // Turning it back on lets the waiting update install at the next check.
          moment.enabled = true;
          yield* TestClock.adjust(CHECK_INTERVAL);
          yield* Deferred.await(installed);
          assert.equal(harness.quitAndInstalls(), 1);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("tries each version once: a failed install waits for the restart button", () => {
    const { harness, layer } = layerFor(
      {},
      {
        quitAndInstall: Effect.fail(
          new ElectronUpdater.ElectronUpdaterQuitAndInstallError({
            channel: "latest",
            isSilent: true,
            isForceRunAfter: true,
            cause: new Error("Squirrel refused the update"),
          }),
        ),
      },
    );

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* configured;
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;

        yield* TestClock.adjust(CHECK_INTERVAL);
        yield* TestClock.adjust(CHECK_INTERVAL);
        assert.equal(harness.quitAndInstalls(), 1);
        assert.equal((yield* updates.getState).errorContext, "install");

        // The checks every few minutes clear the failure from the state; it still waits.
        yield* TestClock.adjust(Duration.minutes(10));
        assert.equal(harness.quitAndInstalls(), 1);
        assert.isTrue((yield* updates.install).accepted);
        assert.equal(harness.quitAndInstalls(), 2);
      }),
    ).pipe(Effect.provide(layer));
  });

  it.effect("never starts a second install of the same version", () => {
    let installs = 0;
    // A failure Squirrel.Mac reports late can be cleared by a check before the next look.
    const downloaded = reduceDesktopUpdateStateOnDownloadComplete(
      createInitialDesktopUpdateState(
        "1.2.3",
        { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
        "latest",
      ),
      "1.2.4",
    );
    const ready = TempoUpdateAutoInstall.TempoUpdateAutoInstall.of({
      enabled: Effect.succeed(true),
      idleSeconds: Effect.succeed(AWAY_SECONDS),
      localTurns: Effect.succeed(0),
      reportLocalTurns: () => Effect.void,
    });

    return Effect.scoped(
      Effect.gen(function* () {
        yield* TempoUpdateAutoInstall.installWhenAway(ready, {
          state: Effect.succeed(downloaded),
          install: () =>
            Effect.sync(() => {
              installs += 1;
              return { accepted: true };
            }),
        }).pipe(Effect.forkScoped);

        yield* TestClock.adjust(Duration.minutes(30));
        assert.equal(installs, 1);
      }),
    ).pipe(Effect.provide(TestClock.layer()));
  });

  it.effect("leaves a version that did not apply before to the restart button", () =>
    Effect.gen(function* () {
      const quitInstallsAtDownload: Array<boolean> = [];
      const downloadStarted = yield* Deferred.make<void>();
      const { harness, layer } = layerFor(
        {},
        {
          installRecord: JSON.stringify({ fromVersion: "1.2.3", targetVersion: "1.2.4" }),
          downloadUpdate: Effect.suspend(() => {
            quitInstallsAtDownload.push(harness.autoInstallOnAppQuit());
            return Deferred.succeed(downloadStarted, undefined).pipe(Effect.asVoid);
          }),
        },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* configured;
          assert.equal((yield* updates.getState).notAppliedVersion, "1.2.4");
          harness.emit("update-available", { version: "1.2.4" });
          yield* Deferred.await(downloadStarted);
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;

          yield* TestClock.adjust(Duration.minutes(10));
          assert.equal(harness.quitAndInstalls(), 0);
          assert.deepEqual(quitInstallsAtDownload, [false]);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );

  it.effect("lets a restart hand the update over again after Squirrel.Mac failed to take it", () =>
    Effect.gen(function* () {
      const downloadStarted = yield* Deferred.make<void>();
      const { harness, layer } = layerFor(
        {},
        { downloadUpdate: Deferred.succeed(downloadStarted, undefined).pipe(Effect.asVoid) },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const updates = yield* configured;
          harness.emit("update-available", { version: "1.2.4" });
          yield* Deferred.await(downloadStarted);
          harness.emit("update-downloaded", { version: "1.2.4" });
          yield* flushCallbacks;
          assert.isTrue(harness.autoInstallOnAppQuit());

          // Squirrel.Mac reports its failure after the download itself has finished.
          harness.emit("error", new Error("Code signature did not pass validation"));
          yield* flushCallbacks;

          // quitAndInstall hands an update to Squirrel.Mac again only while this is off.
          assert.isFalse(harness.autoInstallOnAppQuit());
          assert.isTrue((yield* updates.install).accepted);
        }),
      ).pipe(Effect.provide(layer));
    }),
  );
});

describe("TempoUpdateAutoInstall", () => {
  const layerPower = Layer.succeed(
    ElectronPowerMonitor.ElectronPowerMonitor,
    ElectronPowerMonitor.ElectronPowerMonitor.of({
      isOnBatteryPower: Effect.succeed(false),
      getSystemIdleTime: Effect.succeed(0),
      getSystemIdleState: () => Effect.succeed("active"),
      getCurrentThermalState: Effect.succeed("nominal"),
      onSimpleEvent: () => Effect.void,
      onThermalStateChange: () => Effect.void,
      onSpeedLimitChange: () => Effect.void,
    }),
  );
  const layerService = (
    settings: Option.Option<ClientSettings>,
    openWindows: ReadonlySet<number> = new Set(),
  ) =>
    Layer.effect(
      TempoUpdateAutoInstall.TempoUpdateAutoInstall,
      TempoUpdateAutoInstall.make((windowId) => openWindows.has(windowId)),
    ).pipe(Layer.provide(Layer.merge(DesktopClientSettings.layerTest(settings), layerPower)));
  const enabledWith = (settings: Option.Option<ClientSettings>) =>
    TempoUpdateAutoInstall.TempoUpdateAutoInstall.use((autoInstall) => autoInstall.enabled).pipe(
      Effect.provide(layerService(settings)),
    );

  it.effect("knows the turns once an open window can tell", () => {
    const openWindows = new Set([1, 2]);
    return Effect.gen(function* () {
      const autoInstall = yield* TempoUpdateAutoInstall.TempoUpdateAutoInstall;
      assert.isNull(yield* autoInstall.localTurns);

      yield* autoInstall.reportLocalTurns(1, null);
      assert.isNull(yield* autoInstall.localTurns);
      yield* autoInstall.reportLocalTurns(2, 0);
      assert.equal(yield* autoInstall.localTurns, 0);
      yield* autoInstall.reportLocalTurns(1, 3);
      assert.equal(yield* autoInstall.localTurns, 3);

      // A closed window no longer speaks for the environments.
      openWindows.delete(1);
      assert.equal(yield* autoInstall.localTurns, 0);
      openWindows.delete(2);
      assert.isNull(yield* autoInstall.localTurns);
    }).pipe(Effect.provide(layerService(Option.none(), openWindows)));
  });

  it.effect("is on until this device turns it off", () =>
    Effect.gen(function* () {
      assert.isTrue(yield* enabledWith(Option.none()));
      assert.isTrue(yield* enabledWith(Option.some(DEFAULT_CLIENT_SETTINGS)));
      assert.isFalse(
        yield* enabledWith(
          Option.some({ ...DEFAULT_CLIENT_SETTINGS, autoInstallDesktopUpdates: false }),
        ),
      );
    }),
  );
});
