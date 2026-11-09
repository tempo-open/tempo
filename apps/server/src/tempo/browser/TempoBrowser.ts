/**
 * Extensions, saved passkeys and saved passwords for server browser profiles. Each profile method
 * returns the whole profile and refuses incognito, which keeps none of it. ServerBrowser asks for
 * this service optionally, so upstream tests that build a bare one keep working. A launch never
 * waits for the extension Chrome build: the profile restarts with extensions once it is installed.
 */
import {
  INCOGNITO_BROWSER_PROFILE_ID,
  type TempoBrowserCheckUpdatesResult,
  type TempoBrowserExtensionPage,
  TempoBrowserProfileError,
  type TempoBrowserProfileState,
  type TempoBrowserSetPasskeySettingsInput,
  type TempoBrowserSetPasswordSettingsInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as BrowserExtensions from "./BrowserExtensions.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import * as ExtensionBrowser from "./ExtensionBrowser.ts";

/** What a profile's own browser launch adds to the server browser's defaults. */
export interface ProfileLaunch {
  /** A browser that can run extensions, when the profile has any enabled. */
  readonly executablePath?: string;
  readonly args: ReadonlyArray<string>;
  readonly ignoreDefaultArgs: ReadonlyArray<string>;
}

const NO_EXTENSIONS: ProfileLaunch = { args: [], ignoreDefaultArgs: [] };

/** How long a launch waits for a profile's missing default extensions before going without them. */
const DEFAULTS_WAIT = "20 seconds";

type ProfileResult = Effect.Effect<TempoBrowserProfileState, TempoBrowserProfileError>;

export class TempoBrowser extends Context.Service<
  TempoBrowser,
  {
    readonly getProfile: (profileId: string) => ProfileResult;
    readonly addExtension: (input: {
      readonly profileId: string;
      readonly source: string;
    }) => ProfileResult;
    readonly setExtensionEnabled: (input: {
      readonly profileId: string;
      readonly extensionId: string;
      readonly enabled: boolean;
    }) => ProfileResult;
    readonly removeExtension: (input: {
      readonly profileId: string;
      readonly extensionId: string;
    }) => ProfileResult;
    readonly checkExtensionUpdates: (
      profileId: string,
    ) => Effect.Effect<TempoBrowserCheckUpdatesResult, TempoBrowserProfileError>;
    readonly setPasskeySettings: (input: TempoBrowserSetPasskeySettingsInput) => ProfileResult;
    readonly removePasskey: (input: {
      readonly profileId: string;
      readonly credentialId: string;
    }) => ProfileResult;
    readonly setPasswordSettings: (input: TempoBrowserSetPasswordSettingsInput) => ProfileResult;
    readonly removePassword: (input: {
      readonly profileId: string;
      readonly origin: string;
      readonly username: string;
    }) => ProfileResult;
    /** Deletes a removed profile's extensions, saved passkeys and saved passwords. */
    readonly forgetProfile: (profileId: string) => Effect.Effect<void, TempoBrowserProfileError>;

    /**
     * Server browser hook: a persistent profile's launch from `userDataDir`,
     * after giving it the default extensions it has not had. Extensions need
     * the full Chrome build, which installs on first use; until it has, the
     * profile launches without them and `profileChanges` restarts it once it has.
     */
    readonly profileLaunch: (
      profileId: string,
      userDataDir: string,
    ) => Effect.Effect<ProfileLaunch>;
    /**
     * Server browser hook: waits until a profile can launch, through a first
     * install of the full Chrome build, so its tabs restart only once their new
     * browser is ready. Other launch failures surface when the tabs reopen.
     */
    readonly profileLaunchReady: (profileId: string) => Effect.Effect<void>;
    /**
     * Server browser hook: subscribes to profiles whose launch changes, including
     * ones that launched without their extensions once the full build is in;
     * their tabs restart.
     */
    readonly profileChanges: BrowserExtensions.BrowserExtensions["Service"]["changes"];
    /** Server browser hook: readies a new tab's passkeys. */
    readonly attachTab: BrowserPasskeys.BrowserPasskeys["Service"]["attach"];
    /** Server browser hook: saves and fills passwords in a new tab, the desktop app's too. */
    readonly attachPasswords: BrowserPasswords.BrowserPasswords["Service"]["attach"];
    /** Server browser hook: an enabled extension's page URL in a profile. */
    readonly extensionPageUrl: (input: {
      readonly profileId: string;
      readonly extensionId: string;
      readonly page: TempoBrowserExtensionPage;
    }) => Effect.Effect<string, TempoBrowserProfileError>;
  }
>()("t3/tempo/browser/TempoBrowser") {}

const make = Effect.gen(function* () {
  const extensions = yield* BrowserExtensions.BrowserExtensions;
  const passkeys = yield* BrowserPasskeys.BrowserPasskeys;
  const passwords = yield* BrowserPasswords.BrowserPasswords;
  const extensionBrowser = yield* ExtensionBrowser.ExtensionBrowser;
  const scope = yield* Effect.scope;

  const persistent = (profileId: string) =>
    profileId === INCOGNITO_BROWSER_PROFILE_ID
      ? Effect.fail(new TempoBrowserProfileError({ reason: "incognito" }))
      : Effect.void;
  /** Runs a profile change only for a profile that keeps data. */
  const forProfile =
    <I extends { readonly profileId: string }, A>(
      change: (input: I) => Effect.Effect<A, TempoBrowserProfileError>,
    ) =>
    (input: I) =>
      persistent(input.profileId).pipe(Effect.andThen(change(input)));

  /** Whether the full build is downloading, started here for a profile that needs it. */
  let installing = false;
  /** Chrome for Testing has no full build for this host; asking again changes nothing. */
  let unsupported = false;
  /** Profiles that launched without their extensions because the full build was not in yet. */
  const launchedWithout = new Set<string>();
  /** Those profiles once it is in, so the server browser restarts them with their extensions. */
  const browserReady = yield* PubSub.unbounded<string>();
  const prepareBrowser = Effect.suspend(() => {
    if (installing || unsupported) return Effect.void;
    installing = true;
    return extensionBrowser.executable.pipe(
      // The install outlasts each wait; follow it to the end.
      Effect.retry({ while: (error) => error._tag === "PreviewBrowserInstallingError" }),
      Effect.andThen(
        Effect.suspend(() => {
          const ready = [...launchedWithout];
          launchedWithout.clear();
          return PubSub.publishAll(browserReady, ready);
        }),
      ),
      Effect.catchTags({
        PreviewBrowserUnsupportedError: () =>
          Effect.sync(() => {
            unsupported = true;
          }),
      }),
      // Profiles keep running without extensions; the next launch or read tries again.
      Effect.tapError((cause) =>
        Effect.logWarning("Could not install the browser that runs extensions.", { cause }),
      ),
      Effect.ignore,
      Effect.ensuring(
        Effect.sync(() => {
          installing = false;
        }),
      ),
      Effect.forkIn(scope),
      Effect.asVoid,
    );
  });

  /**
   * The browser that runs extensions. A profile with an enabled extension
   * needs it, so reading one starts the download if it has not started, and
   * its tabs are not left waiting on a download nobody began.
   */
  const extensionBrowserState = Effect.fn("TempoBrowser.extensionBrowserState")(function* (
    profileExtensions: ReadonlyArray<{ readonly enabled: boolean }>,
  ) {
    if (Option.isSome(yield* extensionBrowser.installed)) return "ready" as const;
    if (profileExtensions.some((extension) => extension.enabled)) yield* prepareBrowser;
    return installing ? ("installing" as const) : ("notInstalled" as const);
  });

  const state = (profileId: string) =>
    Effect.all({
      extensions: extensions.list(profileId),
      passkeys: passkeys.get(profileId),
      passwords: passwords.get(profileId),
    }).pipe(
      Effect.flatMap((parts) =>
        extensionBrowserState(parts.extensions).pipe(
          Effect.map((extensionBrowser): TempoBrowserProfileState => ({
            profileId,
            ...parts,
            extensionBrowser,
          })),
        ),
      ),
    );

  const getProfile: TempoBrowser["Service"]["getProfile"] = (profileId) =>
    persistent(profileId).pipe(Effect.andThen(state(profileId)));

  const addExtension: TempoBrowser["Service"]["addExtension"] = forProfile((input) =>
    extensions.add(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const setExtensionEnabled: TempoBrowser["Service"]["setExtensionEnabled"] = forProfile((input) =>
    extensions.setEnabled(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const removeExtension: TempoBrowser["Service"]["removeExtension"] = forProfile((input) =>
    extensions.remove(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const checkExtensionUpdates: TempoBrowser["Service"]["checkExtensionUpdates"] = (profileId) =>
    persistent(profileId).pipe(
      Effect.andThen(extensions.checkUpdates(profileId)),
      Effect.flatMap(({ updated, failed }) =>
        state(profileId).pipe(Effect.map((profile) => ({ profile, updated, failed }))),
      ),
    );

  const setPasskeySettings: TempoBrowser["Service"]["setPasskeySettings"] = forProfile((input) =>
    passkeys.setSettings(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const removePasskey: TempoBrowser["Service"]["removePasskey"] = forProfile((input) =>
    passkeys.remove(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const setPasswordSettings: TempoBrowser["Service"]["setPasswordSettings"] = forProfile((input) =>
    passwords.setSettings(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const removePassword: TempoBrowser["Service"]["removePassword"] = forProfile((input) =>
    passwords.remove(input).pipe(Effect.andThen(state(input.profileId))),
  );

  const forgetProfile: TempoBrowser["Service"]["forgetProfile"] = (profileId) =>
    persistent(profileId).pipe(
      Effect.andThen(passkeys.forget(profileId)),
      Effect.andThen(passwords.forget(profileId)),
      Effect.andThen(extensions.forget(profileId)),
      Effect.withSpan("TempoBrowser.forgetProfile"),
    );

  /** A download that fails or runs long leaves the defaults to the profile's next launch. */
  const addDefaults = (profileId: string) =>
    extensions.addDefaults(profileId).pipe(
      Effect.timeout(DEFAULTS_WAIT),
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not add the profile's default extensions; launching without them.",
          { cause },
        ),
      ),
    );

  const profileLaunch: TempoBrowser["Service"]["profileLaunch"] = Effect.fn(
    "TempoBrowser.profileLaunch",
  )(function* (profileId, userDataDir) {
    yield* addDefaults(profileId);
    const folders = yield* extensions.launchFolders(profileId, userDataDir).pipe(
      Effect.catchTags({
        TempoBrowserProfileError: (cause) =>
          Effect.logWarning("Could not read the profile's extensions; launching without them.", {
            cause,
          }).pipe(Effect.as([] as ReadonlyArray<string>)),
      }),
    );
    launchedWithout.delete(profileId);
    if (folders.length === 0) return NO_EXTENSIONS;
    const executablePath = yield* extensionBrowser.installed;
    if (Option.isNone(executablePath)) {
      // Its tabs open now, and restart with the extensions once the build is in.
      launchedWithout.add(profileId);
      yield* prepareBrowser;
      return NO_EXTENSIONS;
    }
    const list = folders.join(",");
    return {
      executablePath: executablePath.value,
      args: [`--disable-extensions-except=${list}`, `--load-extension=${list}`],
      // Playwright turns extensions off by default.
      ignoreDefaultArgs: ["--disable-extensions"],
    };
  });

  const profileLaunchReady: TempoBrowser["Service"]["profileLaunchReady"] = Effect.fn(
    "TempoBrowser.profileLaunchReady",
  )(
    function* (profileId) {
      // The caller restarts the profile next, so the install need not.
      launchedWithout.delete(profileId);
      if ((yield* extensions.launchFolders(profileId)).length === 0) return;
      yield* extensionBrowser.executable.pipe(
        Effect.retry({ while: (error) => error._tag === "PreviewBrowserInstallingError" }),
      );
    },
    (effect) => Effect.ignore(effect),
  );

  return TempoBrowser.of({
    getProfile,
    addExtension,
    setExtensionEnabled,
    removeExtension,
    checkExtensionUpdates,
    setPasskeySettings,
    removePasskey,
    setPasswordSettings,
    removePassword,
    forgetProfile,
    profileLaunch,
    profileLaunchReady,
    profileChanges: Effect.zipWith(
      extensions.changes,
      PubSub.subscribe(browserReady),
      (changed, ready) => Stream.merge(changed, Stream.fromSubscription(ready)),
    ),
    attachTab: passkeys.attach,
    attachPasswords: passwords.attach,
    extensionPageUrl: forProfile(extensions.pageUrl),
  });
});

export const layer = Layer.effect(TempoBrowser, make);
