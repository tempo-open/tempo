import { expect, it } from "@effect/vitest";
import {
  TEMPO_DEFAULT_PASSKEY_SETTINGS,
  TEMPO_DEFAULT_PASSWORD_SETTINGS,
  TempoBrowserProfileError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { PreviewBrowserInstallingError } from "../../preview/PreviewBrowser.ts";
import * as BrowserExtensions from "./BrowserExtensions.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import * as TempoBrowser from "./TempoBrowser.ts";
import * as ExtensionBrowser from "./ExtensionBrowser.ts";

const unused = Effect.die("unused in these tests");

const NO_EXTENSIONS = { args: [], ignoreDefaultArgs: [] };

const noPasswords = Layer.succeed(
  BrowserPasswords.BrowserPasswords,
  BrowserPasswords.BrowserPasswords.of({
    get: () => Effect.succeed({ settings: TEMPO_DEFAULT_PASSWORD_SETTINGS, saved: [] }),
    setSettings: () => unused,
    remove: () => unused,
    forget: () => unused,
    attach: () => unused,
  }),
);

/** TempoBrowser over stand-ins, built in the test's scope, where its downloads run. */
const browserWith = (
  extensions: Partial<BrowserExtensions.BrowserExtensions["Service"]>,
  extensionBrowser: ExtensionBrowser.ExtensionBrowser["Service"],
) =>
  Layer.build(
    TempoBrowser.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(
            BrowserExtensions.BrowserExtensions,
            BrowserExtensions.BrowserExtensions.of({
              list: () => unused,
              add: () => unused,
              setEnabled: () => unused,
              remove: () => unused,
              checkUpdates: () => unused,
              addDefaults: () => Effect.void,
              forget: () => unused,
              launchFolders: () => unused,
              pageUrl: () => unused,
              changes: Effect.succeed(Stream.empty),
              ...extensions,
            }),
          ),
          Layer.succeed(
            BrowserPasskeys.BrowserPasskeys,
            BrowserPasskeys.BrowserPasskeys.of({
              get: () => unused,
              setSettings: () => unused,
              remove: () => unused,
              forget: () => unused,
              attach: () => unused,
            }),
          ),
          noPasswords,
          Layer.succeed(ExtensionBrowser.ExtensionBrowser, extensionBrowser),
        ),
      ),
    ),
  ).pipe(Effect.map((context) => Context.get(context, TempoBrowser.TempoBrowser)));

/** A full build that installs when `finished` completes. */
const installingBrowser = (finished: Deferred.Deferred<void>) => {
  let installed = Option.none<string>();
  return ExtensionBrowser.ExtensionBrowser.of({
    executable: Deferred.await(finished).pipe(
      Effect.map(() => {
        installed = Option.some("/chrome");
        return "/chrome";
      }),
    ),
    installed: Effect.sync(() => installed),
  });
};

/** Collects the profiles the server browser would restart. */
const restartsOf = (browser: TempoBrowser.TempoBrowser["Service"]) =>
  Effect.gen(function* () {
    const restarts = yield* Queue.unbounded<string>();
    yield* (yield* browser.profileChanges).pipe(
      Stream.runForEach((profileId) => Queue.offer(restarts, profileId)),
      Effect.forkScoped,
    );
    return restarts;
  });

it.effect("downloads the browser that runs extensions once a profile needs it, and says so", () =>
  Effect.gen(function* () {
    const waiting = yield* Deferred.make<void>();
    const finished = yield* Deferred.make<void>();
    const done = yield* Deferred.make<void>();
    let enabled = false;
    let installed = Option.none<string>();
    let installs = 0;
    const extensions = BrowserExtensions.BrowserExtensions.of({
      list: () =>
        Effect.sync(() => [
          {
            id: "abcdefghijklmnopabcdefghijklmnop",
            name: "Marker",
            version: "1.0",
            source: "webStore" as const,
            enabled,
            installedAt: "2026-10-13T00:00:00.000Z",
            updatedAt: "2026-10-13T00:00:00.000Z",
          },
        ]),
      add: () => unused,
      setEnabled: () => unused,
      remove: () => unused,
      checkUpdates: () => unused,
      addDefaults: () => unused,
      forget: () => unused,
      launchFolders: () => unused,
      pageUrl: () => unused,
      changes: Effect.succeed(Stream.empty),
    });
    const passkeys = BrowserPasskeys.BrowserPasskeys.of({
      get: () =>
        Effect.succeed({
          settings: TEMPO_DEFAULT_PASSKEY_SETTINGS,
          saved: [],
          availableProviders: ["saved"],
        }),
      setSettings: () => unused,
      remove: () => unused,
      forget: () => unused,
      attach: () => unused,
    });
    // The first wait on the download runs out, as a long one does; the next sees it end.
    const browser = ExtensionBrowser.ExtensionBrowser.of({
      executable: Effect.suspend(() => {
        installs += 1;
        if (installs === 1) {
          return Effect.fail(
            new PreviewBrowserInstallingError({
              downloadedBytes: 1,
              totalBytes: 2,
              unpacking: false,
            }),
          );
        }
        return Deferred.succeed(waiting, undefined).pipe(
          Effect.andThen(Deferred.await(finished)),
          Effect.map(() => {
            installed = Option.some("/chrome");
            return "/chrome";
          }),
          Effect.ensuring(Deferred.succeed(done, undefined)),
        );
      }),
      installed: Effect.sync(() => installed),
    });
    // Built for the whole test: the download runs in the service's scope.
    const context = yield* Layer.build(
      TempoBrowser.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(BrowserExtensions.BrowserExtensions, extensions),
            Layer.succeed(BrowserPasskeys.BrowserPasskeys, passkeys),
            noPasswords,
            Layer.succeed(ExtensionBrowser.ExtensionBrowser, browser),
          ),
        ),
      ),
    );
    const service = Context.get(context, TempoBrowser.TempoBrowser);
    const extensionBrowser = service
      .getProfile("work")
      .pipe(Effect.map((profile) => profile.extensionBrowser));

    // No enabled extension, no download.
    expect(yield* extensionBrowser).toBe("notInstalled");
    expect(installs).toBe(0);

    // A profile that runs one starts it, and later reads join it.
    enabled = true;
    expect(yield* extensionBrowser).toBe("installing");
    yield* Deferred.await(waiting);
    expect(yield* extensionBrowser).toBe("installing");
    expect(installs).toBe(2);

    yield* Deferred.succeed(finished, undefined);
    yield* Deferred.await(done);
    expect(yield* extensionBrowser).toBe("ready");
    expect(installs).toBe(2);

    // Incognito keeps no extensions to run.
    const incognito = yield* Effect.flip(service.getProfile("incognito"));
    expect(incognito.reason).toBe("incognito");
  }).pipe(Effect.scoped),
);

it.effect(
  "launches a profile without extensions while the full build installs, then restarts it",
  () =>
    Effect.gen(function* () {
      const finished = yield* Deferred.make<void>();
      const asked: Array<string> = [];
      const browser = yield* browserWith(
        {
          // The Web Store is out of reach; the launch goes ahead without the defaults.
          addDefaults: (profileId) =>
            Effect.sync(() => asked.push(profileId)).pipe(
              Effect.andThen(
                Effect.fail(new TempoBrowserProfileError({ reason: "download_failed" })),
              ),
            ),
          launchFolders: () => Effect.succeed(["/extensions/marker"]),
        },
        installingBrowser(finished),
      );
      const restarts = yield* restartsOf(browser);

      expect(yield* browser.profileLaunch("work", "/profiles/work")).toEqual(NO_EXTENSIONS);
      expect(asked).toEqual(["work"]);

      yield* Deferred.succeed(finished, undefined);
      expect(yield* Queue.take(restarts)).toBe("work");
      expect(yield* browser.profileLaunch("work", "/profiles/work")).toEqual({
        executablePath: "/chrome",
        args: [
          "--disable-extensions-except=/extensions/marker",
          "--load-extension=/extensions/marker",
        ],
        ignoreDefaultArgs: ["--disable-extensions"],
      });
    }).pipe(Effect.scoped),
);

it.effect("does not restart a profile again whose restart already waits for the full build", () =>
  Effect.gen(function* () {
    const finished = yield* Deferred.make<void>();
    const browser = yield* browserWith(
      { launchFolders: () => Effect.succeed(["/extensions/marker"]) },
      installingBrowser(finished),
    );
    const restarts = yield* restartsOf(browser);
    expect(yield* browser.profileLaunch("work", "/profiles/work")).toEqual(NO_EXTENSIONS);
    expect(yield* browser.profileLaunch("home", "/profiles/home")).toEqual(NO_EXTENSIONS);

    // An extension change in "work" restarts it once the build is in.
    const ready = yield* browser
      .profileLaunchReady("work")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* Deferred.succeed(finished, undefined);
    yield* Fiber.join(ready);

    // The build's arrival restarts only "home".
    expect(yield* Queue.take(restarts)).toBe("home");
    expect(yield* Queue.size(restarts)).toBe(0);
  }).pipe(Effect.scoped),
);

it.effect("waits on a profile's default extensions only so long before launching", () =>
  Effect.gen(function* () {
    const browser = yield* browserWith(
      { addDefaults: () => Effect.never, launchFolders: () => Effect.succeed([]) },
      ExtensionBrowser.ExtensionBrowser.of({ executable: unused, installed: Effect.succeedNone }),
    );
    const launch = yield* browser
      .profileLaunch("work", "/profiles/work")
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust(Duration.seconds(20));
    expect(yield* Fiber.join(launch)).toEqual(NO_EXTENSIONS);
  }).pipe(Effect.scoped),
);
