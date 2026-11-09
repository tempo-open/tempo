import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as BrowserExtensions from "./BrowserExtensions.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import {
  CAPSOLVER_ID,
  CAPSOLVER_KEY_SECRET,
  CapsolverExtensionId,
  capsolverConfig,
} from "./capsolver.ts";
import * as TempoBrowser from "./TempoBrowser.ts";
import * as ExtensionBrowser from "./ExtensionBrowser.ts";
import { makeCrx3, makeZip, manifestJson } from "./testing/crxFixtures.ts";

const storeArchive = makeZip([
  {
    name: "manifest.json",
    data: manifestJson({
      manifest_version: 3,
      name: "Store Extension",
      version: "2.0.1",
      action: { default_popup: "popup.html" },
    }),
  },
  { name: "popup.html", data: "<p>popup</p>" },
  { name: "_metadata/verified_contents.json", data: "[]" },
]);
const store = makeCrx3(storeArchive);

/** Serves the fixture package for the Web Store's download URL; anything else is a 404. */
const webStore = (requests: Array<string>) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      requests.push(request.url);
      const known = request.url.includes(`id%3D${store.extensionId}%26uc`);
      return HttpClientResponse.fromWeb(
        request,
        new Response(known ? store.crx : null, { status: known ? 200 : 404 }),
      );
    }),
  );

const fakeChrome = ExtensionBrowser.ExtensionBrowser.of({
  executable: Effect.succeed("/opt/chrome-for-testing/chrome"),
  installed: Effect.succeedSome("/opt/chrome-for-testing/chrome"),
});

/**
 * The services over one state directory; building them again reads what the
 * last ones saved. Profiles get no default extensions unless a test names some,
 * and a test can stand the fixture extension in for CapSolver.
 */
const servicesFor = (
  baseDir: string,
  requests: Array<string>,
  defaults: ReadonlyArray<string> = [],
  capsolverId = CAPSOLVER_ID,
) =>
  TempoBrowser.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        BrowserExtensions.layer,
        BrowserPasskeys.layer,
        BrowserPasswords.layer,
        Layer.succeed(ExtensionBrowser.ExtensionBrowser, fakeChrome),
      ),
    ),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), baseDir)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, webStore(requests))),
    Layer.provide(Layer.succeed(BrowserExtensions.DefaultExtensionIds, defaults)),
    Layer.provide(Layer.succeed(CapsolverExtensionId, capsolverId)),
  );

const writeUnpacked = (folder: string, manifest: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(folder, { recursive: true });
    yield* fs.writeFileString(path.join(folder, "manifest.json"), manifestJson(manifest));
    yield* fs.writeFileString(path.join(folder, "options.html"), "<p>options</p>");
  });

it.layer(NodeServices.layer)("BrowserExtensions", (it) => {
  it.effect("installs a verified Web Store package under its id, with its Web Store key", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      const requests: Array<string> = [];
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const extensions = yield* BrowserExtensions.BrowserExtensions;
        const changes = yield* Queue.unbounded<string>();
        yield* (yield* extensions.changes).pipe(
          Stream.runForEach((profileId) => Queue.offer(changes, profileId)),
          Effect.forkScoped,
        );

        const listed = yield* extensions.add({
          profileId: "work",
          source: `https://chromewebstore.google.com/detail/store-extension/${store.extensionId}`,
        });
        expect(listed).toMatchObject([
          {
            id: store.extensionId,
            name: "Store Extension",
            version: "2.0.1",
            source: "webStore",
            enabled: true,
            popupPage: "popup.html",
          },
        ]);
        expect(yield* Queue.take(changes)).toBe("work");
        expect(requests[0]).toContain(`prodversion=${ExtensionBrowser.EXTENSION_BROWSER_VERSION}`);

        const root = path.join(
          config.stateDir,
          "server-browser",
          "extensions",
          store.extensionId,
          "2.0.1",
        );
        expect(yield* extensions.launchFolders("work")).toEqual([root]);
        const manifest = yield* fs.readFileString(path.join(root, "manifest.json"));
        expect(manifest).toContain(`"key":"${Buffer.from(store.publicKey).toString("base64")}"`);
        expect(yield* fs.exists(path.join(root, "_metadata"))).toBe(false);
        expect(
          yield* extensions.pageUrl({
            profileId: "work",
            extensionId: store.extensionId,
            page: "popup",
          }),
        ).toBe(`chrome-extension://${store.extensionId}/popup.html`);

        // Other profiles are untouched.
        expect(yield* extensions.list("personal")).toEqual([]);

        // The same version stays as installed: a running browser may have it loaded.
        yield* fs.writeFileString(path.join(root, "loaded-by-chrome"), "");
        const updates = yield* extensions.checkUpdates("work");
        expect(updates).toMatchObject({ updated: [], failed: [] });
        expect(yield* fs.exists(path.join(root, "loaded-by-chrome"))).toBe(true);
      }).pipe(Effect.provide(servicesFor(baseDir, requests)));
    }).pipe(Effect.scoped),
  );

  it.effect("readies CapSolver with the environment's key before each launch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      yield* Effect.gen(function* () {
        const browser = yield* TempoBrowser.TempoBrowser;
        const extensions = yield* BrowserExtensions.BrowserExtensions;
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const saveKey = (key: string) =>
          secrets.set(CAPSOLVER_KEY_SECRET, new TextEncoder().encode(key));
        yield* extensions.add({ profileId: "work", source: store.extensionId });
        const [root = ""] = yield* extensions.launchFolders("work");
        const settings = path.join(root, "assets", "config.js");
        // What CapSolver saved in the profile on its last page, which wins over its file.
        const userDataDir = path.join(baseDir, "profiles", "work");
        const storage = path.join(userDataDir, "Default", "Local Extension Settings");
        const saved = path.join(storage, store.extensionId);
        const otherSaved = path.join(storage, BrowserExtensions.UBLOCK_ORIGIN_LITE_ID);
        yield* fs.makeDirectory(saved, { recursive: true });
        yield* fs.makeDirectory(otherSaved, { recursive: true });

        // Without a key it still loads, and keeps a key pasted into its popup.
        yield* browser.profileLaunch("work", userDataDir);
        expect(yield* fs.readFileString(settings)).toBe(capsolverConfig(null));
        expect(yield* fs.exists(saved)).toBe(true);

        // A key saved while the server runs reaches the next launch, past what CapSolver saved.
        yield* saveKey("CAP-0123456789ABCDEF\n");
        yield* browser.profileLaunch("work", userDataDir);
        expect(yield* fs.readFileString(settings)).toBe(capsolverConfig("CAP-0123456789ABCDEF"));
        expect(yield* fs.exists(saved)).toBe(false);
        expect(yield* fs.exists(otherSaved)).toBe(true);

        // Readying a launch is not one: the profile's browser may still be running.
        yield* fs.makeDirectory(saved, { recursive: true });
        yield* browser.profileLaunchReady("work");
        expect(yield* fs.exists(saved)).toBe(true);

        // A malformed key never reaches the extension.
        yield* saveKey("CAP-1,useCapsolver:false");
        yield* browser.profileLaunch("work", userDataDir);
        expect(yield* fs.readFileString(settings)).toBe(capsolverConfig(null));
        expect(yield* fs.exists(saved)).toBe(true);
      }).pipe(Effect.provide(servicesFor(baseDir, [], [], store.extensionId)));
    }).pipe(Effect.scoped),
  );

  it.effect("refuses ids the Web Store does not serve and unknown sources", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      yield* Effect.gen(function* () {
        const extensions = yield* BrowserExtensions.BrowserExtensions;
        const missing = yield* Effect.flip(
          extensions.add({ profileId: "work", source: "a".repeat(32) }),
        );
        expect(missing.reason).toBe("download_failed");
        const junk = yield* Effect.flip(
          extensions.add({ profileId: "work", source: "https://example.com/extension" }),
        );
        expect(junk.reason).toBe("invalid_source");
        expect(yield* extensions.list("work")).toEqual([]);
      }).pipe(Effect.provide(servicesFor(baseDir, [])));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps unpacked extensions across restarts and launches only enabled ones", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      const folder = yield* fs
        .realPath(baseDir)
        .pipe(Effect.map((real) => path.join(real, "dev-extension")));
      yield* writeUnpacked(folder, {
        manifest_version: 3,
        name: "Dev Extension",
        version: "0.1",
        options_page: "options.html",
      });

      const id = yield* Effect.gen(function* () {
        const browser = yield* TempoBrowser.TempoBrowser;
        const profile = yield* browser.addExtension({ profileId: "work", source: folder });
        expect(profile.extensions).toMatchObject([
          { name: "Dev Extension", version: "0.1", source: "unpacked", folder, enabled: true },
        ]);
        const extensionId = profile.extensions[0]!.id;
        const launch = yield* browser.profileLaunch("work", path.join(baseDir, "work"));
        expect(launch).toEqual({
          executablePath: "/opt/chrome-for-testing/chrome",
          args: [`--disable-extensions-except=${folder}`, `--load-extension=${folder}`],
          ignoreDefaultArgs: ["--disable-extensions"],
        });
        // A profile without extensions keeps the headless shell.
        expect(yield* browser.profileLaunch("personal", path.join(baseDir, "personal"))).toEqual({
          args: [],
          ignoreDefaultArgs: [],
        });
        expect(
          yield* browser.extensionPageUrl({ profileId: "work", extensionId, page: "options" }),
        ).toBe(`chrome-extension://${extensionId}/options.html`);
        const noPopup = yield* Effect.flip(
          browser.extensionPageUrl({ profileId: "work", extensionId, page: "popup" }),
        );
        expect(noPopup.reason).toBe("no_page");
        return extensionId;
      }).pipe(Effect.provide(servicesFor(baseDir, [])));

      // A new server reads the saved state.
      yield* Effect.gen(function* () {
        const browser = yield* TempoBrowser.TempoBrowser;
        expect(
          (yield* browser.getProfile("work")).extensions.map((extension) => extension.id),
        ).toEqual([id]);
        const disabled = yield* browser.setExtensionEnabled({
          profileId: "work",
          extensionId: id,
          enabled: false,
        });
        expect(disabled.extensions[0]?.enabled).toBe(false);
        expect(yield* browser.profileLaunch("work", path.join(baseDir, "work"))).toEqual({
          args: [],
          ignoreDefaultArgs: [],
        });
        const removed = yield* browser.removeExtension({ profileId: "work", extensionId: id });
        expect(removed.extensions).toEqual([]);
        const gone = yield* Effect.flip(
          browser.removeExtension({ profileId: "work", extensionId: id }),
        );
        expect(gone.reason).toBe("not_found");
      }).pipe(Effect.provide(servicesFor(baseDir, [])));
    }).pipe(Effect.scoped),
  );

  it.effect("checks every extension even when one cannot be checked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      const real = yield* fs.realPath(baseDir);
      const growing = path.join(real, "growing");
      const moved = path.join(real, "moved");
      const manifest = (name: string, version: string) => ({
        manifest_version: 3,
        name,
        version,
      });
      yield* writeUnpacked(growing, manifest("Growing", "1"));
      yield* writeUnpacked(moved, manifest("Moved", "1"));
      yield* Effect.gen(function* () {
        const extensions = yield* BrowserExtensions.BrowserExtensions;
        const changes = yield* Queue.unbounded<string>();
        yield* (yield* extensions.changes).pipe(
          Stream.runForEach((profileId) => Queue.offer(changes, profileId)),
          Effect.forkScoped,
        );
        const [grown] = yield* extensions.add({ profileId: "work", source: growing });
        const added = yield* extensions.add({ profileId: "work", source: moved });
        yield* Queue.takeN(changes, 2);

        yield* writeUnpacked(growing, manifest("Growing", "2"));
        yield* fs.remove(moved, { recursive: true });
        const result = yield* extensions.checkUpdates("work");
        expect(result.updated).toEqual([grown!.id]);
        expect(result.failed).toEqual([{ extensionId: added[1]!.id, reason: "invalid_source" }]);
        expect(result.extensions.map((extension) => extension.version)).toEqual(["2", "1"]);
        // What did update still reaches the profile's tabs.
        expect(yield* Queue.take(changes)).toBe("work");
      }).pipe(Effect.provide(servicesFor(baseDir, [])));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "forgets a removed profile's extensions, passkeys and passwords, and keeps none for incognito",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const browser = yield* TempoBrowser.TempoBrowser;
          yield* browser.addExtension({ profileId: "work", source: store.extensionId });
          yield* browser.setPasskeySettings({ profileId: "work", agentsMayUse: true });
          yield* browser.setPasswordSettings({ profileId: "work", agentsMayUse: false });
          const installed = path.join(
            config.stateDir,
            "server-browser",
            "extensions",
            store.extensionId,
          );
          expect(yield* fs.exists(installed)).toBe(true);

          yield* browser.forgetProfile("work");
          const profile = yield* browser.getProfile("work");
          expect(profile.extensions).toEqual([]);
          expect(profile.passkeys.settings.agentsMayUse).toBe(false);
          expect(profile.passwords?.settings.agentsMayUse).toBe(true);
          expect(yield* fs.exists(installed)).toBe(false);

          for (const refused of [
            browser.getProfile("incognito"),
            browser.addExtension({ profileId: "incognito", source: store.extensionId }),
            browser.setPasskeySettings({ profileId: "incognito", agentsMayUse: true }),
            browser.setPasswordSettings({ profileId: "incognito", savePasswords: true }),
            browser.removePassword({
              profileId: "incognito",
              origin: "https://a.example",
              username: "",
            }),
          ]) {
            expect((yield* Effect.flip(refused)).reason).toBe("incognito");
          }
        }).pipe(Effect.provide(servicesFor(baseDir, [])));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "gives each profile a default extension once, and never again after a person drops it",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
        const requests: Array<string> = [];
        const statePath = yield* ServerConfig.ServerConfig.pipe(
          Effect.map((config) =>
            path.join(config.stateDir, "server-browser", "extensions", "profiles.json"),
          ),
          Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
        );

        // Before defaults existed, a person added the extension to "home" and turned it off.
        yield* Effect.gen(function* () {
          const extensions = yield* BrowserExtensions.BrowserExtensions;
          yield* extensions.add({ profileId: "home", source: store.extensionId });
          yield* extensions.setEnabled({
            profileId: "home",
            extensionId: store.extensionId,
            enabled: false,
          });
        }).pipe(Effect.provide(servicesFor(baseDir, requests)));
        const saved = JSON.parse(yield* fs.readFileString(statePath)) as Record<string, unknown>;
        delete saved.defaultsAdded;
        yield* fs.writeFileString(statePath, JSON.stringify(saved));

        yield* Effect.gen(function* () {
          const extensions = yield* BrowserExtensions.BrowserExtensions;
          const downloads = requests.length;
          // That profile already has it: it counts as given and stays off, with no download.
          yield* extensions.addDefaults("home");
          expect(yield* extensions.list("home")).toMatchObject([
            { id: store.extensionId, enabled: false },
          ]);
          expect(requests).toHaveLength(downloads);

          // A profile without it gets it from the Web Store, turned on, once.
          yield* extensions.addDefaults("work");
          expect(yield* extensions.list("work")).toMatchObject([
            { id: store.extensionId, source: "webStore", enabled: true },
          ]);
          yield* extensions.addDefaults("work");
          expect(requests).toHaveLength(downloads + 1);

          // Turned off, it stays off; removed, it stays removed.
          yield* extensions.setEnabled({
            profileId: "work",
            extensionId: store.extensionId,
            enabled: false,
          });
          yield* extensions.addDefaults("work");
          expect((yield* extensions.list("work"))[0]?.enabled).toBe(false);
          yield* extensions.remove({ profileId: "work", extensionId: store.extensionId });
          yield* extensions.addDefaults("work");
          expect(yield* extensions.list("work")).toEqual([]);
        }).pipe(Effect.provide(servicesFor(baseDir, requests, [store.extensionId])));

        // A new server remembers; a forgotten profile starts over.
        yield* Effect.gen(function* () {
          const extensions = yield* BrowserExtensions.BrowserExtensions;
          yield* extensions.addDefaults("work");
          expect(yield* extensions.list("work")).toEqual([]);
          yield* extensions.forget("work");
          yield* extensions.addDefaults("work");
          expect((yield* extensions.list("work")).map((extension) => extension.id)).toEqual([
            store.extensionId,
          ]);
        }).pipe(Effect.provide(servicesFor(baseDir, requests, [store.extensionId])));
      }).pipe(Effect.scoped),
  );

  it.effect("tries a default extension again after its download fails", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      const requests: Array<string> = [];
      // The Web Store serves no such extension.
      const missing = "a".repeat(32);
      yield* Effect.gen(function* () {
        const extensions = yield* BrowserExtensions.BrowserExtensions;
        expect((yield* Effect.flip(extensions.addDefaults("work"))).reason).toBe("download_failed");
        yield* Effect.flip(extensions.addDefaults("work"));
        expect(requests).toHaveLength(2);
        expect(yield* extensions.list("work")).toEqual([]);
      }).pipe(Effect.provide(servicesFor(baseDir, requests, [missing])));
    }).pipe(Effect.scoped),
  );

  it.effect("sets a damaged state file aside instead of overwriting it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-extensions-" });
      // Damaged before the service starts, as after a crash mid-write.
      const directory = yield* ServerConfig.ServerConfig.pipe(
        Effect.map((config) => path.join(config.stateDir, "server-browser", "extensions")),
        Effect.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
      );
      yield* fs.makeDirectory(directory, { recursive: true });
      yield* fs.writeFileString(path.join(directory, "profiles.json"), "{not json");
      yield* Effect.gen(function* () {
        const extensions = yield* BrowserExtensions.BrowserExtensions;
        // Two first requests at once, beside the startup sweep, set it aside only once.
        const lists = yield* Effect.all([extensions.list("work"), extensions.list("home")], {
          concurrency: "unbounded",
        });
        expect(lists).toEqual([[], []]);
        const kept = (yield* fs.readDirectory(directory)).filter((name) =>
          name.startsWith("profiles.json.bad-"),
        );
        expect(kept).toHaveLength(1);
        expect(yield* fs.readFileString(path.join(directory, kept[0]!))).toBe("{not json");
      }).pipe(Effect.provide(servicesFor(baseDir, [])));
    }).pipe(Effect.scoped),
  );
});
