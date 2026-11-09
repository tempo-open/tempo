// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Drives a real Chrome and a local page outside Effect.
/**
 * Runs extensions and saved passkeys in a real Chrome for Testing. Skipped
 * unless TEMPO_TEST_CHROME names a full (not headless shell) Chrome for Testing
 * executable, for example Playwright's
 * `~/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as NodeHttp from "node:http";
import type { Page } from "playwright-core";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";
import { manifestJson } from "./testing/crxFixtures.ts";

const chrome = process.env.TEMPO_TEST_CHROME;

const CREATE = `navigator.credentials.create({ publicKey: {
  rp: { name: "Tempo", id: "localhost" },
  user: { id: new Uint8Array([1, 2, 3]), name: "ada@example.com", displayName: "Ada" },
  challenge: new Uint8Array(32),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
} }).then((credential) => credential.id)`;
const GET = `navigator.credentials.get({ publicKey: {
  challenge: new Uint8Array(32), rpId: "localhost", timeout: 5000,
} }).then((credential) => "signed in " + credential.id, (error) => error.name)`;

it.layer(NodeServices.layer)("Tempo browser in Chrome for Testing", (it) => {
  it.effect.skipIf(chrome === undefined)(
    "loads a profile's extension and keeps its passkeys from agents",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-browser-chrome-" });
        const extension = path.join(yield* fs.realPath(baseDir), "extension");
        yield* fs.makeDirectory(extension);
        yield* fs.writeFileString(
          path.join(extension, "manifest.json"),
          manifestJson({
            manifest_version: 3,
            name: "Marker",
            version: "1.0",
            content_scripts: [{ matches: ["http://*/*"], js: ["content.js"] }],
          }),
        );
        yield* fs.writeFileString(
          path.join(extension, "content.js"),
          `document.documentElement.dataset.tempo = "loaded";`,
        );
        const server = yield* Effect.acquireRelease(
          Effect.promise(
            () =>
              new Promise<NodeHttp.Server>((resolve) => {
                const listening = NodeHttp.createServer((_request, response) => {
                  response.setHeader("content-type", "text/html");
                  response.end("<p>sign in</p>");
                }).listen(0, "127.0.0.1", () => resolve(listening));
              }),
          ),
          (listening) => Effect.sync(() => listening.close()),
        );
        const address = server.address();
        const origin = `http://localhost:${typeof address === "object" && address ? address.port : 0}/`;
        let launches = 0;
        const contexts = new ServerBrowserContexts({
          profilesDir: path.join(baseDir, "profiles"),
          executable: async () => chrome!,
          profileLaunch: async () => {
            launches += 1;
            return {
              args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
              ignoreDefaultArgs: ["--disable-extensions"],
            };
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => contexts.close()));

        const passkeys = yield* BrowserPasskeys.BrowserPasskeys.pipe(
          Effect.provide(
            BrowserPasskeys.layer.pipe(
              Layer.provide(ServerSecretStore.layer),
              Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
            ),
          ),
        );
        const openTab = (byAgent: boolean) =>
          Effect.gen(function* () {
            const context = yield* Effect.promise(() => contexts.contextFor("work"));
            const page = yield* Effect.promise(() => context.newPage());
            const cdp = yield* Effect.promise(() => context.newCDPSession(page));
            const session = yield* passkeys.attach({
              profileId: "work",
              cdp,
              agentTouched: byAgent,
              linkedTabsTouched: () => false,
            });
            yield* Effect.promise(() => page.goto(origin));
            return { page, session };
          });

        // The profile's extension runs in its tabs.
        const person = yield* openTab(false);
        yield* Effect.promise(() =>
          person.page.waitForFunction(`document.documentElement.dataset.tempo === "loaded"`),
        );

        // A person creates a passkey; it is saved.
        const created = yield* Effect.promise(() => person.page.evaluate(CREATE));
        yield* Effect.promise(() => person.session.idle());
        const saved = (yield* passkeys.get("work")).saved;
        expect(saved).toMatchObject([{ rpId: "localhost", userName: "ada@example.com" }]);

        // A new tab signs in with it.
        const second = yield* openTab(false);
        expect(yield* Effect.promise(() => second.page.evaluate(GET))).toBe(`signed in ${created}`);

        // Registering the account again replaces its passkey, and every tab keeps working.
        // WebAuthn needs the page in front.
        yield* Effect.promise(() => person.page.bringToFront());
        const replaced = yield* Effect.promise(() => person.page.evaluate(CREATE));
        yield* Effect.promise(() => person.session.idle());
        yield* Effect.promise(() => second.session.idle());
        expect((yield* passkeys.get("work")).saved.map((passkey) => passkey.credentialId)).toEqual([
          expect.any(String),
        ]);
        const third = yield* openTab(false);
        expect(yield* Effect.promise(() => third.page.evaluate(GET))).toBe(`signed in ${replaced}`);
        yield* Effect.promise(() => second.page.bringToFront());
        expect(yield* Effect.promise(() => second.page.evaluate(GET))).toBe(
          `signed in ${replaced}`,
        );

        // A tab an agent opened cannot, even after its own script reloads it...
        const agent = yield* openTab(true);
        expect(yield* Effect.promise(() => agent.page.evaluate(GET))).toBe("NotAllowedError");
        yield* Effect.promise(() =>
          Promise.all([
            agent.page.waitForEvent("load"),
            agent.page.evaluate(`setTimeout(() => location.reload(), 0)`),
          ]),
        );
        yield* Effect.promise(() => agent.session.idle());
        expect(yield* Effect.promise(() => agent.page.evaluate(GET))).toBe("NotAllowedError");
        // ...until a person loads a new page in it from the browser's controls.
        yield* Effect.promise(() => agent.session.personNavigation(() => agent.page.reload()));
        yield* Effect.promise(() => agent.session.idle());
        expect(yield* Effect.promise(() => agent.page.evaluate(GET))).toBe(`signed in ${replaced}`);

        // A viewer that leaves ends its own DevTools session on the page, and
        // Chrome drops the page's virtual authenticator with it. The agent's
        // next action still runs, in a page that cannot sign in...
        const viewerLeaves = (page: Page) =>
          Effect.promise(async () => (await page.context().newCDPSession(page)).detach());
        yield* viewerLeaves(agent.page);
        yield* Effect.promise(() => agent.page.bringToFront());
        expect(
          yield* Effect.promise(() => agent.session.agentAction(() => agent.page.evaluate(GET))),
        ).toBe("NotAllowedError");
        // ...and a person's tab has its passkeys back once the server says a session left.
        yield* viewerLeaves(second.page);
        second.session.sessionDetached();
        yield* Effect.promise(() => second.session.idle());
        yield* Effect.promise(() => second.page.bringToFront());
        expect(yield* Effect.promise(() => second.page.evaluate(GET))).toBe(
          `signed in ${replaced}`,
        );

        // Restarting the profile relaunches it with its launch settings.
        yield* Effect.promise(() => contexts.restartProfile("work"));
        const relaunched = yield* openTab(false);
        expect(launches).toBe(2);
        expect(yield* Effect.promise(() => relaunched.page.evaluate(GET))).toBe(
          `signed in ${replaced}`,
        );
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );
});
