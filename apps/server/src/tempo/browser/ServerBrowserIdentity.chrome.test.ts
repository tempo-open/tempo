// @effect-diagnostics nodeBuiltinImport:off - Drives a real Chrome and its pages outside Effect.
/**
 * What sites see of the server browser in a real Chrome for Testing. Skipped
 * unless TEMPO_TEST_CHROME names a full (not headless shell) Chrome for Testing
 * executable, such as the one Tempo installs under `~/.tempo/tools/chrome`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { presentAsChrome, ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";

const chrome = process.env.TEMPO_TEST_CHROME;

const SITE = `<iframe src="https://frame.test/"></iframe>`;
const FRAME = `<script>window.firstUserAgent = navigator.userAgent; fetch("/data")</script>`;
const HINTS = `navigator.userAgentData.getHighEntropyValues(["platformVersion", "uaFullVersion", "fullVersionList"])`;

it.layer(NodeServices.layer)("server browser identity in Chrome for Testing", (it) => {
  it.effect.skipIf(chrome === undefined)(
    "gives sites a person's Chrome in every frame from its first request, never HeadlessChrome",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const host = {
          platform: yield* HostProcess.Platform,
          arch: yield* HostProcess.Architecture,
        };
        const contexts = new ServerBrowserContexts({
          profilesDir: yield* fs.makeTempDirectoryScoped({ prefix: "tempo-browser-identity-" }),
          executable: async () => chrome!,
          platform: host.platform,
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => contexts.close()));

        const { seen, sent, hints, notifications } = yield* Effect.promise(async () => {
          const context = await contexts.contextFor("work");
          const page = await context.newPage();
          await presentAsChrome(await context.newCDPSession(page), host);
          const sent = new Map<string, string>();
          await context.route("https://*.test/**", (route) => {
            const url = new URL(route.request().url());
            sent.set(url.href, route.request().headers()["user-agent"] ?? "");
            return route.fulfill({
              contentType: "text/html",
              body: url.host === "frame.test" ? FRAME : SITE,
            });
          });
          const frameRequest = page.waitForRequest("https://frame.test/data");
          await page.goto("https://site.test/");
          await frameRequest;
          const frame = page
            .frames()
            .find((candidate) => candidate.url() === "https://frame.test/");
          const seen = [
            await page.evaluate("navigator.userAgent"),
            await frame!.evaluate("window.firstUserAgent"),
            ...sent.values(),
          ];
          await page.evaluate(`navigator.clipboard.writeText("copied")`);
          return {
            seen,
            sent,
            hints: (await page.evaluate(HINTS)) as {
              readonly platformVersion: string;
              readonly uaFullVersion: string;
              readonly fullVersionList: ReadonlyArray<{
                readonly brand: string;
                readonly version: string;
              }>;
            },
            notifications: await page.evaluate("Notification.permission"),
          };
        });

        // The cross-site frame's own request, which its page's override never reached.
        expect(sent.has("https://frame.test/data")).toBe(true);
        for (const userAgent of seen) expect(userAgent).toMatch(/ Chrome\/\d+\.0\.0\.0 /);
        expect(hints.fullVersionList.find(({ brand }) => brand === "Google Chrome")?.version).toBe(
          hints.uaFullVersion,
        );
        expect(hints.platformVersion).toMatch(/^\d+\.\d+\.\d+$/);
        expect(notifications).toBe("default");
      }).pipe(Effect.scoped),
    { timeout: 60_000 },
  );
});
