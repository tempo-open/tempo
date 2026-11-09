// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Drives a real Chrome and a local page outside Effect.
/**
 * Runs iCloud Keychain passkeys of a server tab in a real Chrome, with a
 * stand-in for the person's Mac. Skipped unless TEMPO_TEST_CHROME names a Chrome
 * for Testing (or headless shell) executable, for example Playwright's
 * `~/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  LaptopToolHostId,
  type LaptopPasskeyResult,
  type LaptopToolsStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import * as NodeHttp from "node:http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { installPdfDocumentNavigation } from "../../preview/PdfDocumentNavigation.ts";
import { ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";
import * as ServerBrowserPage from "../../preview/ServerBrowserPage.ts";
import * as LaptopToolHosts from "../laptopTools/LaptopToolHosts.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";

const chrome = process.env.TEMPO_TEST_CHROME;

const create = (rpId: string) => `navigator.credentials.create({ publicKey: {
  rp: { name: "Tempo", id: ${JSON.stringify(rpId)} },
  user: { id: new Uint8Array([1, 2, 3]), name: "ada@example.com", displayName: "Ada" },
  challenge: new Uint8Array([7, 7, 7]),
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  authenticatorSelection: { residentKey: "required", userVerification: "required" },
} }).then((credential) => ({
  id: credential.id,
  isCredential: credential instanceof PublicKeyCredential,
  transports: credential.response.getTransports(),
  algorithm: credential.response.getPublicKeyAlgorithm(),
  json: credential.toJSON(),
}), (error) => error.name)`;
const get = (rpId: string) => `navigator.credentials.get({ publicKey: {
  challenge: new Uint8Array(32), rpId: ${JSON.stringify(rpId)}, timeout: 5000,
} }).then((credential) => "signed in " + credential.id, (error) => error.name)`;

/** A site the person's Mac may answer for: https, off the environment's machine. Served by routing. */
const SITE = "https://tempo.example";
/** Another site, which `${SITE}/framed` embeds. */
const FRAME_SITE = "https://widgets.example";

const fromMac = {
  credentialId: "AQID",
  clientDataJSON: "eyJ0eXBlIjoid2ViYXV0aG4uY3JlYXRlIn0",
  attestationObject: "o2NmbXRkbm9uZQ",
  authData: "SZYN5Y",
  publicKey: "MFkw",
  publicKeyAlgorithm: -7,
  transports: ["internal", "hybrid"],
  extensions: {},
};

it.layer(NodeServices.layer)("iCloud Keychain passkeys in Chrome", (it) => {
  it.effect.skipIf(chrome === undefined)(
    "sends a person's ceremony to their Mac and falls back to saved passkeys",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-icloud-chrome-" });
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
        const port = typeof address === "object" && address ? address.port : 0;
        const contexts = new ServerBrowserContexts({
          profilesDir: path.join(baseDir, "profiles"),
          executable: async () => chrome!,
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => contexts.close()));

        yield* Effect.gen(function* () {
          const passkeys = yield* BrowserPasskeys.BrowserPasskeys;
          const hosts = yield* LaptopToolHosts.LaptopToolHosts;
          yield* passkeys.setSettings({ profileId: "work", provider: "icloud-keychain" });

          // The person's Mac: answers while `mac.available`, else says it cannot.
          const mac = { available: true, requests: [] as LaptopToolsStreamEvent[] };
          const connected = yield* Deferred.make<void>();
          const stream = yield* hosts.connect(
            {
              hostId: LaptopToolHostId.make("macbook"),
              hostLabel: "MacBook",
              servers: [],
              accepts: ["passkey"],
            },
            "session-me",
          );
          yield* Stream.runForEach(stream, (event) =>
            Effect.gen(function* () {
              if (event.type === "connected") yield* Deferred.succeed(connected, undefined);
              if (event.type !== "request") return;
              mac.requests.push(event);
              const result: LaptopPasskeyResult = mac.available
                ? { _tag: "created", data: fromMac }
                : { _tag: "unavailable", status: "awaiting-entitlement" };
              yield* hosts.respond(
                {
                  hostId: LaptopToolHostId.make("macbook"),
                  connectionId: event.connectionId,
                  requestId: event.requestId,
                  outcome: { _tag: "passkey", result },
                },
                "session-me",
              );
            }),
          ).pipe(Effect.forkScoped);
          yield* Deferred.await(connected);

          const openTab = (byAgent: boolean, url = `${SITE}/`) =>
            Effect.gen(function* () {
              const context = yield* Effect.promise(() => contexts.contextFor("work"));
              const page = yield* Effect.promise(() => context.newPage());
              // The site is served here, so the tab gets a real https origin without DNS or TLS.
              // `/sandboxed` is content the site isolates in an opaque origin, and `/framed`
              // embeds another site, which Chrome renders in its own process.
              yield* Effect.promise(() =>
                page.route(`${SITE}/**`, (route) =>
                  route.fulfill({
                    contentType: "text/html",
                    body: route.request().url().endsWith("/framed")
                      ? `<input type="password" value="hunter22"><iframe src="${FRAME_SITE}/"></iframe>`
                      : "<p>sign in</p>",
                    headers: route.request().url().endsWith("/sandboxed")
                      ? { "content-security-policy": "sandbox allow-scripts" }
                      : {},
                  }),
                ),
              );
              yield* Effect.promise(() =>
                page.route(`${FRAME_SITE}/**`, (route) =>
                  route.fulfill({ contentType: "text/html", body: "<p>widget</p>" }),
                ),
              );
              const cdp = yield* Effect.promise(() => context.newCDPSession(page));
              // The server catches PDF navigations on the same session first (createTab).
              yield* Effect.promise(() => installPdfDocumentNavigation(cdp));
              const session = yield* passkeys.attach({
                profileId: "work",
                cdp,
                agentTouched: byAgent,
                // An agent's tab stays locked: nobody navigates it from the browser's controls.
                linkedTabsTouched: () => false,
                threadId: ThreadId.make("thread-chrome"),
                controllerSessionId: () => (byAgent ? null : "session-me"),
              });
              yield* Effect.promise(() => page.goto(url));
              return { page, cdp, session };
            });

          // The Mac answers; the page gets a credential it can use like a native one.
          const person = yield* openTab(false);
          expect(
            yield* Effect.promise(() => person.page.evaluate(create("tempo.example"))),
          ).toEqual({
            id: "AQID",
            isCredential: true,
            transports: ["internal", "hybrid"],
            algorithm: -7,
            json: expect.objectContaining({
              id: "AQID",
              rawId: "AQID",
              type: "public-key",
              response: expect.objectContaining({ attestationObject: fromMac.attestationObject }),
            }),
          });
          const [first] = mac.requests;
          expect(first?.type === "request" ? first.request : null).toMatchObject({
            _tag: "passkey",
            ceremony: "create",
            origin: SITE,
            rpId: "tempo.example",
            requester: "person",
            publicKey: {
              challenge: { $b64u: "BwcH" },
              user: { id: { $b64u: "AQID" }, name: "ada@example.com" },
            },
          });
          // Nothing the Mac made is kept on the environment.
          expect((yield* passkeys.get("work")).saved).toEqual([]);

          // A Mac that cannot answer hands the request to the saved passkeys.
          mac.available = false;
          yield* Effect.promise(() => person.page.bringToFront());
          const saved = yield* Effect.promise(() => person.page.evaluate(create("tempo.example")));
          yield* Effect.promise(() => person.session.idle());
          expect(saved).toMatchObject({ isCredential: true });
          expect((yield* passkeys.get("work")).saved).toMatchObject([
            { rpId: "tempo.example", userName: "ada@example.com" },
          ]);
          const savedId = (saved as { readonly id: string }).id;
          expect(yield* Effect.promise(() => person.page.evaluate(get("tempo.example")))).toBe(
            `signed in ${savedId}`,
          );

          // An agent's snapshot of a person's tab reads password fields in every frame,
          // opening DevTools sessions on frames in other processes. The tab keeps both
          // its saved passkeys and the way to the Mac.
          const framed = yield* openTab(false, `${SITE}/framed`);
          const snapshot = yield* Effect.promise(() =>
            ServerBrowserPage.snapshot({
              page: framed.page,
              cdp: framed.cdp,
              renderScale: 1,
              consoleEntries: [],
              networkEntries: [],
              actionTimeline: [],
            }),
          );
          expect(snapshot.accessibilityTree).not.toContain("hunter22");
          expect(yield* Effect.promise(() => framed.page.evaluate(get("tempo.example")))).toBe(
            `signed in ${savedId}`,
          );
          mac.available = true;
          expect(
            yield* Effect.promise(() => framed.page.evaluate(create("tempo.example"))),
          ).toMatchObject({ id: "AQID", isCredential: true });

          // A page on the environment's own localhost keeps to saved passkeys; no Mac is asked.
          const asked = mac.requests.length;
          const local = yield* openTab(false, `http://localhost:${port}/`);
          const localSaved = yield* Effect.promise(() => local.page.evaluate(create("localhost")));
          yield* Effect.promise(() => local.session.idle());
          expect(localSaved).toMatchObject({ isCredential: true });
          expect(mac.requests).toHaveLength(asked);

          // Content the site sandboxes into an opaque origin still reads the site in
          // `location.origin`, but cannot sign in as it; no Mac is asked.
          const sandboxed = yield* openTab(false, `${SITE}/sandboxed`);
          expect(
            yield* Effect.promise(() =>
              sandboxed.page.evaluate("[location.origin, self.origin, isSecureContext]"),
            ),
          ).toEqual([SITE, "null", true]);
          expect(yield* Effect.promise(() => sandboxed.page.evaluate(get("tempo.example")))).toBe(
            "NotAllowedError",
          );
          expect(mac.requests).toHaveLength(asked);

          // A page an agent opened gets nothing, and the Mac is never asked.
          const agent = yield* openTab(true);
          expect(yield* Effect.promise(() => agent.page.evaluate(get("tempo.example")))).toBe(
            "NotAllowedError",
          );
          expect(mac.requests).toHaveLength(asked);

          // Agents allowed: the agent's sign-in goes to the Mac, which asks the person first,
          // and the saved passkeys stay locked for its page, so a frame it makes gets nothing.
          yield* passkeys.setSettings({ profileId: "work", agentsMayUse: true });
          yield* Effect.promise(() => agent.session.idle());
          expect(yield* Effect.promise(() => agent.page.evaluate(get("tempo.example")))).toBe(
            "signed in AQID",
          );
          const toAgent = mac.requests.at(-1);
          expect(toAgent?.type === "request" ? toAgent.request : null).toMatchObject({
            requester: "agent",
          });
          const inFrame = `new Promise((resolve) => {
            const frame = document.createElement("iframe");
            frame.onload = () => frame.contentWindow.navigator.credentials.get({ publicKey: {
              challenge: new Uint8Array(32), rpId: "tempo.example", timeout: 5000,
            } }).then((credential) => resolve("signed in " + credential.id), (error) => resolve(error.name));
            document.body.append(frame);
          })`;
          expect(yield* Effect.promise(() => agent.page.evaluate(inFrame))).toBe("NotAllowedError");
          expect(mac.requests).toHaveLength(asked + 1);
        }).pipe(
          Effect.provide(
            BrowserPasskeys.layer.pipe(
              Layer.provideMerge(LaptopToolHosts.layer),
              Layer.provideMerge(ServerSecretStore.layer),
              Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
            ),
          ),
        );
      }).pipe(Effect.scoped),
    { timeout: 120_000 },
  );
});
