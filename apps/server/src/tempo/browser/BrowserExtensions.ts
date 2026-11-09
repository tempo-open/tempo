/**
 * Each server browser profile's Chrome extensions, listed in `profiles.json`. Web Store CRX3s are
 * verified (`crx.ts`) and unpacked once per version under `server-browser/extensions/`, shared by
 * profiles; unpacked-folder extensions load in place. Unused versions are deleted only on removal
 * and at startup, never while a browser may still have them loaded from an update.
 */
import {
  type TempoBrowserExtension,
  TempoBrowserExtension as TempoBrowserExtensionSchema,
  type TempoBrowserExtensionPage,
  type TempoBrowserFailureReason,
  TempoBrowserProfileError,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import {
  CAPSOLVER_KEY_SECRET,
  CapsolverExtensionId,
  isCapsolverKey,
  resetCapsolverStorage,
  writeCapsolverConfig,
} from "./capsolver.ts";
import {
  crxDownloadUrl,
  extensionIdFromFolder,
  extensionIdFromPublicKey,
  parseCrx3,
  parseExtensionSource,
} from "./crx.ts";
import { EXTENSION_BROWSER_VERSION } from "./ExtensionBrowser.ts";
import {
  type ExtensionManifestInfo,
  extractExtensionArchive,
  readExtensionManifest,
  writeManifestKey,
} from "./extensionPackage.ts";

/** Chrome's own Web Store downloads stay far below this. */
const CRX_MAX_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT = "2 minutes";

/** uBlock Origin Lite. Classic uBlock Origin is Manifest V2, which Chrome no longer runs. */
export const UBLOCK_ORIGIN_LITE_ID = "ddkjiahejlhfcafbddmgiahcphecmpfh";

/**
 * The Web Store extensions every profile is given once. uBlock Origin Lite installs unmodified,
 * with its defaults: standard ad, tracker and malware lists in Optimal mode (which hides page
 * elements only on sites a list names), annoyance lists off. CapSolver is not among them; a
 * profile that adds it solves captchas with the environment's key (`capsolver.ts`).
 */
export const DefaultExtensionIds = Context.Reference<ReadonlyArray<string>>(
  "t3/tempo/browser/DefaultExtensionIds",
  { defaultValue: () => [UBLOCK_ORIGIN_LITE_ID] },
);

/** A profile's extension as stored: the public record plus the folder Chrome loads. */
const StoredExtension = Schema.Struct({
  ...TempoBrowserExtensionSchema.fields,
  root: Schema.String,
});
type StoredExtension = typeof StoredExtension.Type;

const ExtensionsState = Schema.Struct({
  version: Schema.Literal(1),
  profiles: Schema.Record(Schema.String, Schema.Array(StoredExtension)),
  /** The default extensions each profile has been given. Files from before defaults have none. */
  defaultsAdded: Schema.Record(Schema.String, Schema.Array(Schema.String)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed({})),
  ),
});
type ExtensionsState = typeof ExtensionsState.Type;

const EMPTY_STATE: ExtensionsState = { version: 1, profiles: {}, defaultsAdded: {} };
const decodeState = Schema.decodeUnknownEffect(Schema.fromJsonString(ExtensionsState));
const encodeState = Schema.encodeEffect(Schema.fromJsonString(ExtensionsState));

const toPublic = ({ root: _root, ...extension }: StoredExtension): TempoBrowserExtension =>
  extension;

const storage = (cause: unknown) => new TempoBrowserProfileError({ reason: "storage", cause });
const isProfileError = Schema.is(TempoBrowserProfileError);
const keepOrStorage = (cause: unknown) => (isProfileError(cause) ? cause : storage(cause));

type ProfileExtensions = Effect.Effect<
  ReadonlyArray<TempoBrowserExtension>,
  TempoBrowserProfileError
>;

export class BrowserExtensions extends Context.Service<
  BrowserExtensions,
  {
    readonly list: (profileId: string) => ProfileExtensions;
    /** Installs or updates one extension from a Web Store URL or id, or an unpacked folder. */
    readonly add: (input: {
      readonly profileId: string;
      readonly source: string;
    }) => ProfileExtensions;
    readonly setEnabled: (input: {
      readonly profileId: string;
      readonly extensionId: string;
      readonly enabled: boolean;
    }) => ProfileExtensions;
    readonly remove: (input: {
      readonly profileId: string;
      readonly extensionId: string;
    }) => ProfileExtensions;
    /**
     * Downloads each Web Store extension again and installs any new version;
     * unpacked ones reload from their folders. Returns the ids whose version
     * changed, and the ones that could not be checked; one failure does not
     * stop the others.
     */
    readonly checkUpdates: (profileId: string) => Effect.Effect<
      {
        readonly extensions: ReadonlyArray<TempoBrowserExtension>;
        readonly updated: ReadonlyArray<string>;
        readonly failed: ReadonlyArray<{
          readonly extensionId: string;
          readonly reason: TempoBrowserFailureReason;
        }>;
      },
      TempoBrowserProfileError
    >;
    /**
     * Gives a profile each default extension it has not had, from the Web
     * Store. One the profile has already had is never added again, even after
     * a person removed it. Publishes nothing: the caller launches or restarts
     * the profile with them.
     */
    readonly addDefaults: (profileId: string) => Effect.Effect<void, TempoBrowserProfileError>;
    /** Drops every extension of a profile that is going away, and which defaults it had. */
    readonly forget: (profileId: string) => Effect.Effect<void, TempoBrowserProfileError>;
    /**
     * The folders of a profile's enabled extensions, for its browser launch.
     * Given the folder that browser is about to start from, it also readies
     * what the extensions keep there (CapSolver's settings).
     */
    readonly launchFolders: (
      profileId: string,
      userDataDir?: string,
    ) => Effect.Effect<ReadonlyArray<string>, TempoBrowserProfileError>;
    /** An enabled extension's popup or options page, as a `chrome-extension://` URL. */
    readonly pageUrl: (input: {
      readonly profileId: string;
      readonly extensionId: string;
      readonly page: TempoBrowserExtensionPage;
    }) => Effect.Effect<string, TempoBrowserProfileError>;
    /** Subscribes now, then yields each profile whose loaded extensions change. */
    readonly changes: Effect.Effect<Stream.Stream<string>, never, Scope.Scope>;
  }
>()("t3/tempo/browser/BrowserExtensions") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const platform = yield* HostProcess.Platform;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const defaultIds = yield* DefaultExtensionIds;
  const capsolverId = yield* CapsolverExtensionId;
  const extensionsDir = path.join(config.stateDir, "server-browser", "extensions");
  const statePath = path.join(extensionsDir, "profiles.json");
  const lock = yield* Semaphore.make(1);
  const loading = yield* Semaphore.make(1);
  const configuring = yield* Semaphore.make(1);
  const published = yield* PubSub.unbounded<string>();
  let cached: ExtensionsState | null = null;

  const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
    );

  // A read that fails is not cached, so the next call tries again and no write
  // replaces a file that was only briefly unreadable.
  const readState = Effect.gen(function* () {
    if (cached !== null) return cached;
    const exists = yield* fs.exists(statePath).pipe(Effect.mapError(storage));
    if (!exists) {
      cached = EMPTY_STATE;
      return cached;
    }
    const text = yield* fs.readFileString(statePath).pipe(Effect.mapError(storage));
    const state = yield* decodeState(text).pipe(
      // A damaged file must not take every profile's browser down with it. It
      // is kept aside for a person to look at, and the state starts empty.
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const aside = `${statePath}.bad-${yield* Clock.currentTimeMillis}`;
          yield* fs.rename(statePath, aside).pipe(Effect.mapError(storage));
          yield* Effect.logWarning("tempo browser extensions state is damaged; starting empty", {
            cause,
            keptAt: aside,
          });
          return EMPTY_STATE;
        }),
      ),
    );
    cached = state;
    return state;
  });
  // One read at a time: the startup sweep and a first request would otherwise
  // both set the same damaged file aside, and the second rename would fail.
  const load = loading.withPermit(readState);

  const save = Effect.fn("BrowserExtensions.save")(function* (state: ExtensionsState) {
    yield* fs.makeDirectory(extensionsDir, { recursive: true });
    const temporary = `${statePath}.tmp`;
    yield* fs.writeFileString(temporary, yield* encodeState(state));
    yield* fs.rename(temporary, statePath);
    cached = state;
  }, Effect.mapError(storage));

  const profileOf = (state: ExtensionsState, profileId: string) => state.profiles[profileId] ?? [];

  const withProfile = (
    state: ExtensionsState,
    profileId: string,
    extensions: ReadonlyArray<StoredExtension>,
  ): ExtensionsState => {
    const profiles = { ...state.profiles };
    if (extensions.length === 0) delete profiles[profileId];
    else profiles[profileId] = extensions;
    return { ...state, profiles };
  };

  /** Removes installed versions no profile loads any more. */
  const collectGarbage = Effect.fn("BrowserExtensions.collectGarbage")(
    function* (state: ExtensionsState, extensionId: string) {
      const directory = path.join(extensionsDir, extensionId);
      const kept = new Set(
        Object.values(state.profiles)
          .flat()
          .filter((extension) => extension.id === extensionId && extension.source === "webStore")
          .map((extension) => extension.root),
      );
      const versions = yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []));
      for (const version of versions) {
        const root = path.join(directory, version);
        if (!kept.has(root)) yield* fs.remove(root, { recursive: true, force: true });
      }
      if (kept.size === 0) yield* fs.remove(directory, { recursive: true, force: true });
    },
    Effect.catch((cause) =>
      Effect.logWarning("Could not remove an unused extension version.", { cause }),
    ),
  );

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const download = Effect.fn("BrowserExtensions.download")(
    function* (extensionId: string) {
      const response = yield* http
        .execute(HttpClientRequest.get(crxDownloadUrl(extensionId, EXTENSION_BROWSER_VERSION)))
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const declared = Number(response.headers["content-length"] ?? "0");
      if (declared > CRX_MAX_BYTES) {
        return yield* new TempoBrowserProfileError({ reason: "too_large" });
      }
      const chunks: Array<Uint8Array> = [];
      let received = 0;
      yield* response.stream.pipe(
        Stream.runForEach((chunk) =>
          Effect.suspend(() => {
            received += chunk.byteLength;
            if (received > CRX_MAX_BYTES) {
              return Effect.fail(new TempoBrowserProfileError({ reason: "too_large" }));
            }
            chunks.push(chunk);
            return Effect.void;
          }),
        ),
      );
      return Buffer.concat(chunks);
    },
    Effect.timeout(DOWNLOAD_TIMEOUT),
    Effect.mapError((cause) =>
      isProfileError(cause)
        ? cause
        : new TempoBrowserProfileError({ reason: "download_failed", cause }),
    ),
  );

  /** Downloads, verifies, and unpacks one Web Store version; returns its folder and manifest. */
  const installFromWebStore = Effect.fn("BrowserExtensions.installFromWebStore")(function* (
    extensionId: string,
  ) {
    const crx = yield* download(extensionId);
    const parsed = parseCrx3(crx);
    if (typeof parsed === "string" || parsed.extensionId !== extensionId) {
      return yield* new TempoBrowserProfileError({ reason: "invalid_package" });
    }
    yield* fs.makeDirectory(extensionsDir, { recursive: true }).pipe(Effect.mapError(storage));
    return yield* Effect.gen(function* () {
      const staging = yield* fs
        .makeTempDirectoryScoped({ directory: extensionsDir, prefix: ".install-" })
        .pipe(Effect.mapError(storage));
      const archivePath = path.join(staging, "archive.zip");
      const unpacked = path.join(staging, "root");
      yield* fs
        .writeFile(archivePath, crx.subarray(parsed.archiveOffset))
        .pipe(Effect.mapError(storage));
      yield* provide(extractExtensionArchive(archivePath, unpacked));
      const { manifest, info } = yield* provide(readExtensionManifest(unpacked));
      yield* provide(writeManifestKey(unpacked, manifest, parsed.publicKey));
      const root = path.join(extensionsDir, extensionId, info.version);
      // A version already installed stays as it is: running browsers may have it loaded.
      if (yield* fs.exists(root).pipe(Effect.mapError(storage))) return { root, info };
      yield* Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(root), { recursive: true });
        yield* fs.remove(root, { recursive: true, force: true });
        yield* fs.rename(unpacked, root);
      }).pipe(Effect.mapError(storage));
      return { root, info };
    }).pipe(Effect.scoped);
  });

  const readUnpacked = Effect.fn("BrowserExtensions.readUnpacked")(function* (folder: string) {
    const root = yield* fs
      .realPath(folder)
      .pipe(Effect.mapError(() => new TempoBrowserProfileError({ reason: "invalid_source" })));
    const info = yield* fs.stat(root).pipe(Effect.orElseSucceed(() => null));
    // Chrome splits its extension list on commas.
    if (info?.type !== "Directory" || root.includes(",")) {
      return yield* new TempoBrowserProfileError({ reason: "invalid_source" });
    }
    const { info: manifest } = yield* provide(readExtensionManifest(root));
    const id =
      manifest.key === undefined
        ? extensionIdFromFolder(root, platform)
        : extensionIdFromPublicKey(Buffer.from(manifest.key, "base64"));
    return { id, root, info: manifest };
  });

  const record = (
    previous: StoredExtension | undefined,
    input: {
      readonly id: string;
      readonly root: string;
      readonly info: ExtensionManifestInfo;
      readonly source: StoredExtension["source"];
    },
    at: string,
  ): StoredExtension => {
    const { key: _key, ...info } = input.info;
    return {
      id: input.id,
      ...info,
      source: input.source,
      ...(input.source === "unpacked" ? { folder: input.root } : {}),
      enabled: previous?.enabled ?? true,
      installedAt: previous?.installedAt ?? at,
      updatedAt: at,
      root: input.root,
    };
  };

  const upsert = Effect.fn("BrowserExtensions.upsert")(function* (
    profileId: string,
    next: StoredExtension,
  ) {
    const state = yield* load;
    const current = profileOf(state, profileId);
    const replaced = current.some((extension) => extension.id === next.id)
      ? current.map((extension) => (extension.id === next.id ? next : extension))
      : [...current, next];
    const updated = withProfile(state, profileId, replaced);
    yield* save(updated);
    return updated;
  });

  const list: BrowserExtensions["Service"]["list"] = (profileId) =>
    load.pipe(Effect.map((state) => profileOf(state, profileId).map(toPublic)));

  const add: BrowserExtensions["Service"]["add"] = ({ profileId, source }) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const ref = parseExtensionSource(source);
          if (ref === null)
            return yield* new TempoBrowserProfileError({ reason: "invalid_source" });
          const installed =
            ref._tag === "webStore"
              ? {
                  id: ref.id,
                  source: "webStore" as const,
                  ...(yield* installFromWebStore(ref.id)),
                }
              : { source: "unpacked" as const, ...(yield* readUnpacked(ref.folder)) };
          const previous = profileOf(yield* load, profileId).find(
            (extension) => extension.id === installed.id,
          );
          const updated = yield* upsert(profileId, record(previous, installed, yield* now));
          yield* PubSub.publish(published, profileId);
          return profileOf(updated, profileId).map(toPublic);
        }),
      )
      .pipe(Effect.mapError(keepOrStorage), Effect.withSpan("BrowserExtensions.add"));

  const setEnabled: BrowserExtensions["Service"]["setEnabled"] = ({
    profileId,
    extensionId,
    enabled,
  }) =>
    lock.withPermit(
      Effect.gen(function* () {
        const state = yield* load;
        const current = profileOf(state, profileId);
        if (!current.some((extension) => extension.id === extensionId)) {
          return yield* new TempoBrowserProfileError({ reason: "not_found" });
        }
        const at = yield* now;
        const next = current.map((extension) =>
          extension.id === extensionId ? { ...extension, enabled, updatedAt: at } : extension,
        );
        yield* save(withProfile(state, profileId, next));
        yield* PubSub.publish(published, profileId);
        return next.map(toPublic);
      }),
    );

  const remove: BrowserExtensions["Service"]["remove"] = ({ profileId, extensionId }) =>
    lock.withPermit(
      Effect.gen(function* () {
        const state = yield* load;
        const current = profileOf(state, profileId);
        if (!current.some((extension) => extension.id === extensionId)) {
          return yield* new TempoBrowserProfileError({ reason: "not_found" });
        }
        const next = current.filter((extension) => extension.id !== extensionId);
        const updated = withProfile(state, profileId, next);
        yield* save(updated);
        yield* collectGarbage(updated, extensionId);
        yield* PubSub.publish(published, profileId);
        return next.map(toPublic);
      }),
    );

  /** Downloads a Web Store extension again, or reads an unpacked one from its folder. */
  const reinstall = Effect.fn("BrowserExtensions.reinstall")(function* (
    extension: StoredExtension,
  ) {
    if (extension.source === "webStore") {
      const installed = yield* installFromWebStore(extension.id);
      return { id: extension.id, source: "webStore" as const, ...installed };
    }
    const installed = yield* readUnpacked(extension.folder ?? extension.root);
    return { source: "unpacked" as const, ...installed };
  }, Effect.mapError(keepOrStorage));

  const checkUpdates: BrowserExtensions["Service"]["checkUpdates"] = (profileId) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const updated: Array<string> = [];
          const failed: Array<{ extensionId: string; reason: TempoBrowserFailureReason }> = [];
          let reload = false;
          yield* Effect.gen(function* () {
            for (const extension of profileOf(yield* load, profileId)) {
              const installed = yield* reinstall(extension).pipe(
                Effect.catch((error) =>
                  Effect.sync(() => {
                    failed.push({ extensionId: extension.id, reason: error.reason });
                    return null;
                  }),
                ),
              );
              // An unpacked folder whose manifest gained a key now loads under another id.
              if (installed === null || installed.id !== extension.id) continue;
              const changed = installed.info.version !== extension.version;
              if (changed) updated.push(extension.id);
              if (changed || extension.source === "unpacked") {
                yield* upsert(profileId, record(extension, installed, yield* now));
                reload = reload || extension.enabled;
              }
            }
          }).pipe(
            // Whatever did install reaches the profile's tabs, even if a later save failed.
            Effect.ensuring(
              Effect.suspend(() => (reload ? PubSub.publish(published, profileId) : Effect.void)),
            ),
          );
          return { extensions: profileOf(yield* load, profileId).map(toPublic), updated, failed };
        }),
      )
      .pipe(Effect.mapError(keepOrStorage), Effect.withSpan("BrowserExtensions.checkUpdates"));

  const missingDefaults = (state: ExtensionsState, profileId: string) => {
    const added = state.defaultsAdded[profileId] ?? [];
    return defaultIds.filter((id) => !added.includes(id));
  };

  const addDefaults: BrowserExtensions["Service"]["addDefaults"] = Effect.fn(
    "BrowserExtensions.addDefaults",
  )(function* (profileId: string) {
    // Every launch asks; a profile that has had them all answers without the lock.
    if (missingDefaults(yield* load, profileId).length === 0) return;
    yield* lock.withPermit(
      Effect.gen(function* () {
        for (const id of missingDefaults(yield* load, profileId)) {
          const state = yield* load;
          let extensions = profileOf(state, profileId);
          // One a person added first stays as they set it; it only counts as given.
          if (!extensions.some((extension) => extension.id === id)) {
            const installed = {
              id,
              source: "webStore" as const,
              ...(yield* installFromWebStore(id)),
            };
            extensions = [...extensions, record(undefined, installed, yield* now)];
          }
          yield* save({
            ...withProfile(state, profileId, extensions),
            defaultsAdded: {
              ...state.defaultsAdded,
              [profileId]: [...(state.defaultsAdded[profileId] ?? []), id],
            },
          });
        }
      }),
    );
  }, Effect.mapError(keepOrStorage));

  const forget: BrowserExtensions["Service"]["forget"] = (profileId) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          const state = yield* load;
          const current = profileOf(state, profileId);
          if (current.length === 0 && state.defaultsAdded[profileId] === undefined) return;
          const { [profileId]: _forgotten, ...defaultsAdded } = state.defaultsAdded;
          const updated = { ...withProfile(state, profileId, []), defaultsAdded };
          yield* save(updated);
          for (const extension of current) yield* collectGarbage(updated, extension.id);
          if (current.length > 0) yield* PubSub.publish(published, profileId);
        }),
      )
      .pipe(Effect.mapError(keepOrStorage));

  /** Deletes installed versions no profile uses; nothing has them loaded before a browser starts. */
  const sweep = lock.withPermit(
    Effect.gen(function* () {
      const state = yield* load;
      const ids = yield* fs.readDirectory(extensionsDir).pipe(Effect.orElseSucceed(() => []));
      for (const id of ids) {
        if (/^[a-p]{32}$/.test(id)) yield* collectGarbage(state, id);
      }
    }).pipe(
      Effect.catch((cause) => Effect.logWarning("Could not sweep unused extensions.", { cause })),
    ),
  );
  yield* Effect.forkScoped(sweep);

  /** The saved CapSolver key; one that is unreadable or malformed counts as none. */
  const capsolverKey = secrets.get(CAPSOLVER_KEY_SECRET).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed(null),
        onSome: (bytes) => {
          const key = new TextDecoder().decode(bytes).trim();
          return isCapsolverKey(key)
            ? Effect.succeed(key)
            : Effect.logWarning(
                "The saved CapSolver key is malformed; CapSolver runs without it.",
              ).pipe(Effect.as(null));
        },
      }),
    ),
    Effect.catch((error) =>
      Effect.logWarning("Could not read the CapSolver key.", { error: error._tag }).pipe(
        Effect.as(null),
      ),
    ),
  );

  /**
   * Writes CapSolver's settings into its installed folder, which every profile
   * shares. While there is a key, the copy CapSolver saved in the profile about
   * to start goes too, or that copy would keep the key it had before.
   */
  const configureCapsolver = (root: string, userDataDir: string | undefined) =>
    configuring
      .withPermit(
        Effect.gen(function* () {
          const key = yield* capsolverKey;
          yield* provide(writeCapsolverConfig(root, key));
          if (key !== null && userDataDir !== undefined) {
            yield* provide(resetCapsolverStorage(userDataDir, capsolverId));
          }
        }),
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Could not ready CapSolver's settings.", { cause }),
        ),
      );

  const launchFolders: BrowserExtensions["Service"]["launchFolders"] = Effect.fn(
    "BrowserExtensions.launchFolders",
  )(function* (profileId, userDataDir) {
    const enabled = profileOf(yield* load, profileId).filter((extension) => extension.enabled);
    // The key can change between launches; a folder someone develops in stays theirs.
    for (const extension of enabled) {
      if (extension.id === capsolverId && extension.source === "webStore") {
        yield* configureCapsolver(extension.root, userDataDir);
      }
    }
    return enabled.map((extension) => extension.root);
  });

  const pageUrl: BrowserExtensions["Service"]["pageUrl"] = Effect.fn("BrowserExtensions.pageUrl")(
    function* ({ profileId, extensionId, page }) {
      const extension = profileOf(yield* load, profileId).find(
        (candidate) => candidate.id === extensionId && candidate.enabled,
      );
      if (!extension) return yield* new TempoBrowserProfileError({ reason: "not_found" });
      const relative = page === "popup" ? extension.popupPage : extension.optionsPage;
      if (relative === undefined) return yield* new TempoBrowserProfileError({ reason: "no_page" });
      return `chrome-extension://${extension.id}/${relative}`;
    },
  );

  return BrowserExtensions.of({
    list,
    add,
    setEnabled,
    remove,
    checkUpdates,
    addDefaults,
    forget,
    launchFolders,
    pageUrl,
    changes: PubSub.subscribe(published).pipe(Effect.map(Stream.fromSubscription)),
  });
});

export const layer = Layer.effect(BrowserExtensions, make);
