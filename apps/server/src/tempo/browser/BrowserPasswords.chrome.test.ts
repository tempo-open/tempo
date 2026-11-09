// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Drives a real Chrome outside Effect.
/**
 * Saves and fills passwords in a real Chrome, on pages shaped like the sign-in
 * forms sites use. Skipped unless TEMPO_TEST_CHROME names a Chrome for Testing
 * (or headless shell) executable, for example Playwright's
 * `~/Library/Caches/ms-playwright/chromium-<rev>/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { CDPSession, Frame, Page, Route } from "playwright-core";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import { ServerBrowserContexts } from "../../preview/ServerBrowserContexts.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import { PASSWORD_BINDING } from "./passwordForms.ts";

const chrome = process.env.TEMPO_TEST_CHROME;

const SITE = "https://tempo.example";
/** Another site with the same form. */
const OTHER = "https://other.example";
/** Another origin on the same site, so Chrome keeps its frames in the page's process. */
const LOGIN_SITE = "https://login.tempo.example";

/**
 * `seen` records the events a script-driven form reacts to. The `react` entries
 * follow React's value tracking: it hears a change only when the field's value
 * differs from the last one set through the field's own `value` setter.
 */
const LOGIN = `<form><input type="email" name="email"><input type="password" name="pw"><button>Sign in</button></form>
<script>
  window.seen = [];
  for (const input of document.querySelectorAll("input")) {
    const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
    let tracked = "";
    Object.defineProperty(input, "value", {
      get() { return native.get.call(this); },
      set(value) { tracked = String(value); native.set.call(this, value); },
    });
    input.addEventListener("input", () => {
      if (input.value !== tracked) seen.push("react " + input.name);
      tracked = input.value;
    });
    input.addEventListener("change", () => seen.push("change " + input.name));
  }
  document.forms[0].addEventListener("submit", (event) => event.preventDefault());
</script>`;

const PAGES: Readonly<Record<string, string>> = {
  "/login": LOGIN,
  // A single-page app's form with no <form>, added after the page loads.
  "/spa": `<div id="app"></div><script>setTimeout(() => {
    document.getElementById("app").innerHTML = '<div><input autocomplete="username" name="user"><input type="password" name="pw"><button type="button" id="go">Go</button></div>';
  }, 50);</script>`,
  // Username first: the password step has no username field.
  "/step1": `<form action="/step2"><input type="email" name="identifier"><button>Next</button></form>`,
  "/step2": `<form><input type="password" name="pw"><button>Sign in</button></form>
<script>document.forms[0].addEventListener("submit", (event) => event.preventDefault());</script>`,
  "/signup": `<form><input type="email" name="email"><input type="password" name="p1" autocomplete="new-password"><input type="password" name="p2" autocomplete="new-password"><button>Create</button></form>
<script>document.forms[0].addEventListener("submit", (event) => event.preventDefault());</script>`,
  "/framed": `<p>widget below</p><iframe src="${LOGIN_SITE}/login"></iframe>`,
};

const serve = (route: Route) =>
  route.fulfill({
    contentType: "text/html",
    body: PAGES[new URL(route.request().url()).pathname] ?? "<p>nothing here</p>",
  });

/** Resolves on the page script's next message of this kind. */
const nextMessage = (cdp: CDPSession, kind: "submit" | "fill") =>
  new Promise<void>((resolve) => {
    const listener = (event: { name: string; payload: string }) => {
      if (event.name !== PASSWORD_BINDING || !event.payload.includes(`"kind":"${kind}"`)) return;
      cdp.off("Runtime.bindingCalled", listener);
      resolve();
    };
    cdp.on("Runtime.bindingCalled", listener);
  });

const values = (frame: Page | Frame) =>
  frame.$$eval("input", (inputs) =>
    inputs.map((input) => (input as unknown as { readonly value: string }).value),
  );

// Live: which saved sign-in fills is the one used last, by the wall clock Chrome runs on.
it.live.skipIf(chrome === undefined)(
  "saves the sign-ins pages submit and fills them back on the same origin only",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-passwords-chrome-" });
      const contexts = new ServerBrowserContexts({
        profilesDir: path.join(baseDir, "profiles"),
        executable: async () => chrome!,
      });
      yield* Effect.addFinalizer(() => Effect.promise(() => contexts.close()));

      yield* Effect.gen(function* () {
        const passwords = yield* BrowserPasswords.BrowserPasswords;
        const accounts = passwords
          .get("work")
          .pipe(
            Effect.map((view) => view.saved.map((saved) => `${saved.username} ${saved.origin}`)),
          );

        /**
         * A tab of the profile, served by routing. A page with a login form asks
         * for a fill as it loads, and that request has been answered.
         */
        const openTab = (url: string, { agentTouched = false, loginForm = true } = {}) =>
          Effect.gen(function* () {
            const { page, cdp } = yield* Effect.promise(async () => {
              const context = await contexts.contextFor("work");
              const page = await context.newPage();
              await page.route("**/*", serve);
              return { page, cdp: await context.newCDPSession(page) };
            });
            const session = yield* passwords.attach({
              profileId: "work",
              cdp,
              agentTouched: () => agentTouched,
            });
            yield* Effect.promise(async () => {
              const asked = loginForm ? nextMessage(cdp, "fill") : Promise.resolve();
              await page.goto(url);
              await asked;
              await session.idle();
            });
            return { page, cdp, session };
          });
        const submit = (
          tab: { readonly cdp: CDPSession; readonly session: BrowserPasswords.PasswordTab },
          act: () => Promise<void>,
        ) =>
          Effect.promise(async () => {
            const sent = nextMessage(tab.cdp, "submit");
            await act();
            await sent;
            await tab.session.idle();
          });
        const reload = (tab: {
          readonly page: Page;
          readonly cdp: CDPSession;
          readonly session: BrowserPasswords.PasswordTab;
        }) =>
          Effect.promise(async () => {
            const asked = nextMessage(tab.cdp, "fill");
            await tab.page.reload();
            await asked;
            await tab.session.idle();
          });

        // A person signs in; the page script never shows the page its binding.
        const person = yield* openTab(`${SITE}/login`);
        expect(yield* Effect.promise(() => values(person.page))).toEqual(["", ""]);
        yield* submit(person, async () => {
          await person.page.fill("input[name=email]", "ada@example.com");
          await person.page.fill("input[name=pw]", "hunter2");
          await person.page.click("button");
        });
        expect(yield* accounts).toEqual([`ada@example.com ${SITE}`]);
        expect(
          yield* Effect.promise(() => person.page.evaluate(`typeof ${PASSWORD_BINDING}`)),
        ).toBe("undefined");

        // The next visit is filled as typing would, and the page's script hears it.
        yield* reload(person);
        expect(yield* Effect.promise(() => values(person.page))).toEqual([
          "ada@example.com",
          "hunter2",
        ]);
        expect(yield* Effect.promise(() => person.page.evaluate("seen"))).toEqual([
          "react email",
          "change email",
          "react pw",
          "change pw",
        ]);

        // The same form on another site gets nothing.
        const other = yield* openTab(`${OTHER}/login`);
        expect(yield* Effect.promise(() => values(other.page))).toEqual(["", ""]);

        // A form an app adds later is filled too, and its button saves another account.
        const spa = yield* openTab(`${SITE}/spa`);
        expect(yield* Effect.promise(() => values(spa.page))).toEqual([
          "ada@example.com",
          "hunter2",
        ]);
        yield* submit(spa, async () => {
          await spa.page.fill("input[name=user]", "grace@example.com");
          await spa.page.fill("input[name=pw]", "cobol");
          await spa.page.click("#go");
        });

        // Username first: Enter on the first step names the account the next step saves.
        const steps = yield* openTab(`${SITE}/step1`, { loginForm: false });
        yield* submit(steps, async () => {
          await steps.page.fill("input[name=identifier]", "lin@example.com");
          await steps.page.press("input[name=identifier]", "Enter");
        });
        yield* Effect.promise(() => steps.page.waitForURL(`${SITE}/step2**`));
        yield* submit(steps, async () => {
          await steps.page.fill("input[name=pw]", "l0velace");
          await steps.page.click("button");
        });
        yield* reload(steps);
        expect(yield* Effect.promise(() => values(steps.page))).toEqual(["l0velace"]);

        // A sign-up form is left empty, and saves the new password it sets.
        const signup = yield* openTab(`${SITE}/signup`);
        expect(yield* Effect.promise(() => values(signup.page))).toEqual(["", "", ""]);
        yield* submit(signup, async () => {
          await signup.page.fill("input[name=email]", "new@example.com");
          await signup.page.fill("input[name=p1]", "s3cret");
          await signup.page.fill("input[name=p2]", "s3cret");
          await signup.page.click("button");
        });
        expect(yield* accounts).toEqual([
          `ada@example.com ${SITE}`,
          `grace@example.com ${SITE}`,
          `lin@example.com ${SITE}`,
          `new@example.com ${SITE}`,
        ]);

        // A frame from another origin gets none of the page's passwords, only its own.
        const framed = yield* openTab(`${SITE}/framed`);
        const frame = framed.page
          .frames()
          .find((candidate) => candidate.url().startsWith(LOGIN_SITE))!;
        expect(yield* Effect.promise(() => values(frame))).toEqual(["", ""]);
        yield* submit(framed, async () => {
          await frame.fill("input[name=email]", "ada@example.com");
          await frame.fill("input[name=pw]", "frame-pw");
          await frame.click("button");
        });
        expect((yield* accounts).filter((account) => account.endsWith(LOGIN_SITE))).toEqual([
          `ada@example.com ${LOGIN_SITE}`,
        ]);
        yield* reload(framed);
        const reloaded = framed.page
          .frames()
          .find((candidate) => candidate.url().startsWith(LOGIN_SITE))!;
        expect(yield* Effect.promise(() => values(reloaded))).toEqual([
          "ada@example.com",
          "frame-pw",
        ]);

        // Agents get passwords by default. Kept out, their pages get none, and a
        // person's page is emptied before an agent acts in it.
        const agent = yield* openTab(`${SITE}/login`, { agentTouched: true });
        expect(yield* Effect.promise(() => values(agent.page))).toEqual([
          "new@example.com",
          "s3cret",
        ]);
        yield* passwords.setSettings({ profileId: "work", agentsMayUse: false });
        const keptOut = yield* openTab(`${SITE}/login`, { agentTouched: true });
        expect(yield* Effect.promise(() => values(keptOut.page))).toEqual(["", ""]);
        yield* Effect.promise(() => person.session.beforeAgentAction());
        expect(yield* Effect.promise(() => values(person.page))).toEqual(["", ""]);
      }).pipe(
        Effect.provide(
          BrowserPasswords.layer.pipe(
            Layer.provideMerge(ServerSecretStore.layer),
            Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  { timeout: 120_000 },
);
