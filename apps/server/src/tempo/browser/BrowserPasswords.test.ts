import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as BrowserPasswords from "./BrowserPasswords.ts";
import { type FormField, PASSWORD_BINDING, PASSWORD_WORLD } from "./passwordForms.ts";

const field = (overrides: Partial<FormField>): FormField => ({
  type: "text",
  autocomplete: "",
  name: "",
  visible: true,
  editable: true,
  value: "",
  ...overrides,
  filled: overrides.filled ?? (overrides.value ?? "") !== "",
});
const email = (value = "") => field({ type: "email", name: "email", value });
const password = (value = "") => field({ type: "password", name: "password", value });

const GITHUB = "https://github.com";

/**
 * Stands in for one tab: the browser reports its documents' execution
 * contexts, the page script calls the binding, and the server's fills and
 * clears land in `evaluated`.
 */
class FakeTab {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  agentTouched = false;
  /** What the server ran in the page, by context. */
  readonly evaluated: Array<{ readonly contextId: number; readonly expression: string }> = [];
  private nextFill = 0;

  readonly cdp = {
    send: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      if (method === "Runtime.evaluate") {
        this.evaluated.push({
          contextId: params.contextId as number,
          expression: params.expression as string,
        });
      }
      return method === "Page.addScriptToEvaluateOnNewDocument" ? { identifier: "1" } : {};
    },
    on: (event: string, listener: (payload: unknown) => void) => {
      const set = this.listeners.get(event) ?? new Set();
      set.add(listener);
      this.listeners.set(event, set);
      return this.cdp;
    },
    off: (event: string, listener: (payload: unknown) => void) => {
      this.listeners.get(event)?.delete(listener);
      return this.cdp;
    },
  };

  target(profileId: string): BrowserPasswords.PasswordTabTarget {
    return {
      profileId,
      // The fake answers only what the tab sends.
      cdp: this.cdp as unknown as BrowserPasswords.PasswordTabTarget["cdp"],
      agentTouched: () => this.agentTouched,
    };
  }

  private emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  /** A document's execution context, with its origin as the browser reports it. */
  open(contextId: number, origin: string, name = PASSWORD_WORLD) {
    this.emit("Runtime.executionContextCreated", { context: { id: contextId, origin, name } });
  }

  close(contextId: number) {
    this.emit("Runtime.executionContextDestroyed", { executionContextId: contextId });
  }

  private call(contextId: number, message: unknown) {
    this.emit("Runtime.bindingCalled", {
      name: PASSWORD_BINDING,
      executionContextId: contextId,
      payload: JSON.stringify(message),
    });
  }

  submit(contextId: number, fields: ReadonlyArray<FormField>) {
    this.call(contextId, { kind: "submit", fields });
  }

  /** A login form appeared; returns what the server filled in it, by field. */
  async fill(
    session: BrowserPasswords.PasswordTab,
    contextId: number,
    fields: ReadonlyArray<FormField>,
  ) {
    const before = this.evaluated.length;
    this.call(contextId, { kind: "fill", id: ++this.nextFill, fields });
    await session.idle();
    const run = this.evaluated.slice(before).find((entry) => entry.contextId === contextId);
    if (run === undefined) return [];
    const values: ReadonlyArray<{ index: number; value: string }> = JSON.parse(
      run.expression.slice(run.expression.indexOf("["), run.expression.lastIndexOf("]") + 1),
    );
    return values.map(({ value }) => value);
  }
}

const passwordsFor = (baseDir: string) =>
  BrowserPasswords.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const withPasswords = <A, E>(
  body: (
    passwords: BrowserPasswords.BrowserPasswords["Service"],
  ) => Effect.Effect<A, E, ServerSecretStore.ServerSecretStore>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-passwords-" });
    return yield* BrowserPasswords.BrowserPasswords.pipe(
      Effect.flatMap(body),
      Effect.provide(passwordsFor(baseDir)),
    );
  }).pipe(Effect.scoped);

const accounts = (passwords: BrowserPasswords.BrowserPasswords["Service"], profileId: string) =>
  passwords
    .get(profileId)
    .pipe(Effect.map((view) => view.saved.map((saved) => `${saved.username}@${saved.origin}`)));

it.layer(NodeServices.layer)("BrowserPasswords", (it) => {
  it.effect("saves each sign-in a page submits, one password per site and username", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-passwords-" });
      yield* Effect.gen(function* () {
        const passwords = yield* BrowserPasswords.BrowserPasswords;
        const tab = new FakeTab();
        const session = yield* passwords.attach(tab.target("work"));
        tab.open(1, GITHUB);
        tab.submit(1, [email("ada@example.com"), password("hunter2")]);
        yield* Effect.promise(() => session.idle());
        const view = yield* passwords.get("work");
        expect(view.saved).toEqual([
          {
            origin: GITHUB,
            username: "ada@example.com",
            createdAt: expect.any(String),
            lastUsedAt: expect.any(String),
          },
        ]);
        expect(JSON.stringify(view)).not.toContain("hunter2");

        // Signing in again with a new password replaces the old one; another account adds one.
        tab.submit(1, [email("ada@example.com"), password("hunter3")]);
        tab.submit(1, [email("grace@example.com"), password("cobol")]);
        yield* Effect.promise(() => session.idle());
        expect(yield* accounts(passwords, "work")).toEqual([
          `ada@example.com@${GITHUB}`,
          `grace@example.com@${GITHUB}`,
        ]);
        // Another profile has none of it.
        expect((yield* passwords.get("personal")).saved).toEqual([]);
      }).pipe(Effect.provide(passwordsFor(baseDir)));

      // A restarted server fills with what was saved last.
      yield* Effect.gen(function* () {
        const passwords = yield* BrowserPasswords.BrowserPasswords;
        const tab = new FakeTab();
        const session = yield* passwords.attach(tab.target("work"));
        tab.open(1, GITHUB);
        expect(
          yield* Effect.promise(() => tab.fill(session, 1, [email("ada@example.com"), password()])),
        ).toEqual(["hunter3"]);
      }).pipe(Effect.provide(passwordsFor(baseDir)));
    }).pipe(Effect.scoped),
  );

  it.effect("fills a page only with what its own origin saved, the account used last first", () =>
    withPasswords((passwords) =>
      Effect.gen(function* () {
        const login = [email(), password()];
        const tab = new FakeTab();
        const session = yield* passwords.attach(tab.target("work"));
        tab.open(1, GITHUB);
        tab.submit(1, [email("ada@example.com"), password("hunter2")]);
        yield* Effect.promise(() => session.idle());
        yield* TestClock.adjust(Duration.minutes(1));
        tab.submit(1, [email("grace@example.com"), password("cobol")]);
        yield* Effect.promise(() => session.idle());
        // A tab that never signed in there gets the account used last.
        const other = new FakeTab();
        const otherSession = yield* passwords.attach(other.target("work"));
        other.open(1, GITHUB);
        expect(yield* Effect.promise(() => other.fill(otherSession, 1, login))).toEqual([
          "grace@example.com",
          "cobol",
        ]);
        // Signing in again makes an account the latest, but a tab whose own last
        // sign-in there was another account keeps to that one.
        yield* TestClock.adjust(Duration.minutes(1));
        other.submit(1, [email("ada@example.com"), password("hunter2")]);
        yield* Effect.promise(() => otherSession.idle());
        expect(yield* Effect.promise(() => other.fill(otherSession, 1, login))).toEqual([
          "ada@example.com",
          "hunter2",
        ]);
        expect(yield* Effect.promise(() => tab.fill(session, 1, login))).toEqual([
          "grace@example.com",
          "cobol",
        ]);

        // A frame keeps to its own origin's, whatever the page around it is.
        tab.open(2, "https://gist.github.com");
        expect(yield* Effect.promise(() => tab.fill(session, 2, login))).toEqual([]);
        // The browser's word on the origin is the only one: an opaque origin (a
        // sandboxed page reads its site in location.origin) saves and fills nothing.
        tab.open(3, "://");
        tab.submit(3, [email("mallory@example.com"), password("stolen")]);
        expect(yield* Effect.promise(() => tab.fill(session, 3, login))).toEqual([]);
        // Nor do contexts outside the isolated world, or one whose document is gone.
        tab.open(4, GITHUB, "");
        expect(yield* Effect.promise(() => tab.fill(session, 4, login))).toEqual([]);
        tab.close(1);
        expect(yield* Effect.promise(() => tab.fill(session, 1, login))).toEqual([]);
        expect(yield* accounts(passwords, "work")).toEqual([
          `ada@example.com@${GITHUB}`,
          `grace@example.com@${GITHUB}`,
        ]);
      }),
    ),
  );

  it.effect("saves a password step under the username the step before it submitted", () =>
    withPasswords((passwords) =>
      Effect.gen(function* () {
        const accountsSite = "https://accounts.example.com";
        const tab = new FakeTab();
        const session = yield* passwords.attach(tab.target("work"));
        tab.open(1, accountsSite);
        tab.submit(1, [email("ada@example.com")]);
        // The password step is a new document on the same site.
        tab.close(1);
        tab.open(2, accountsSite);
        tab.submit(2, [password("hunter2")]);
        yield* Effect.promise(() => session.idle());
        expect(yield* accounts(passwords, "work")).toEqual([`ada@example.com@${accountsSite}`]);

        // A site's prompt to confirm the password, in a tab that never signed in there,
        // updates the one account rather than saving one without a username.
        const other = new FakeTab();
        const otherSession = yield* passwords.attach(other.target("work"));
        other.open(1, accountsSite);
        other.submit(1, [password("hunter3")]);
        yield* Effect.promise(() => otherSession.idle());
        expect(yield* accounts(passwords, "work")).toEqual([`ada@example.com@${accountsSite}`]);
        expect(yield* Effect.promise(() => other.fill(otherSession, 1, [password()]))).toEqual([
          "hunter3",
        ]);
      }),
    ),
  );

  it.effect("saves nothing new while saving is off, and keeps filling what it has", () =>
    withPasswords((passwords) =>
      Effect.gen(function* () {
        const tab = new FakeTab();
        const session = yield* passwords.attach(tab.target("work"));
        tab.open(1, GITHUB);
        tab.submit(1, [email("ada@example.com"), password("hunter2")]);
        yield* Effect.promise(() => session.idle());
        const off = yield* passwords.setSettings({ profileId: "work", savePasswords: false });
        expect(off.settings).toEqual({ savePasswords: false, agentsMayUse: true });
        tab.submit(1, [email("grace@example.com"), password("cobol")]);
        yield* Effect.promise(() => session.idle());
        expect(yield* accounts(passwords, "work")).toEqual([`ada@example.com@${GITHUB}`]);
        expect(yield* Effect.promise(() => tab.fill(session, 1, [email(), password()]))).toEqual([
          "ada@example.com",
          "hunter2",
        ]);
      }),
    ),
  );

  it.effect("fills for agents by default, and keeps passwords from their pages when told to", () =>
    withPasswords((passwords) =>
      Effect.gen(function* () {
        const login = [email(), password()];
        const person = new FakeTab();
        const personSession = yield* passwords.attach(person.target("work"));
        person.open(1, GITHUB);
        person.submit(1, [email("ada@example.com"), password("hunter2")]);
        yield* Effect.promise(() => personSession.idle());
        expect((yield* passwords.get("work")).settings.agentsMayUse).toBe(true);

        // An agent's page gets the profile's passwords, and keeps them while it acts.
        const agent = new FakeTab();
        agent.agentTouched = true;
        const agentSession = yield* passwords.attach(agent.target("work"));
        agent.open(1, GITHUB);
        expect(yield* Effect.promise(() => agent.fill(agentSession, 1, login))).toEqual([
          "ada@example.com",
          "hunter2",
        ]);
        yield* Effect.promise(() => agentSession.beforeAgentAction());
        expect(agent.evaluated).toHaveLength(1);

        // With agents kept out, an agent's page gets nothing...
        yield* passwords.setSettings({ profileId: "work", agentsMayUse: false });
        agent.open(2, GITHUB);
        expect(yield* Effect.promise(() => agent.fill(agentSession, 2, login))).toEqual([]);
        // ...and what a person's page was given is emptied before an agent acts there.
        expect(yield* Effect.promise(() => person.fill(personSession, 1, login))).toEqual([
          "ada@example.com",
          "hunter2",
        ]);
        person.agentTouched = true;
        const filled = person.evaluated.length;
        yield* Effect.promise(() => personSession.beforeAgentAction());
        expect(person.evaluated.slice(filled).map((entry) => entry.contextId)).toEqual([1]);
        // The page stays the agent's, so nothing is filled again and nothing is left to empty.
        expect(yield* Effect.promise(() => person.fill(personSession, 1, login))).toEqual([]);
        yield* Effect.promise(() => personSession.beforeAgentAction());
        expect(person.evaluated).toHaveLength(filled + 1);
        // Saving what an agent submits is fine.
        agent.submit(2, [email("bot@example.com"), password("b0t")]);
        yield* Effect.promise(() => agentSession.idle());
        expect(yield* accounts(passwords, "work")).toEqual([
          `ada@example.com@${GITHUB}`,
          `bot@example.com@${GITHUB}`,
        ]);
      }),
    ),
  );

  it.effect("removes one saved password, and forgets them all with the profile", () =>
    withPasswords((passwords) =>
      Effect.gen(function* () {
        const tab = new FakeTab();
        const session = yield* passwords.attach(tab.target("work"));
        tab.open(1, GITHUB);
        tab.submit(1, [email("ada@example.com"), password("hunter2")]);
        yield* Effect.promise(() => session.idle());
        tab.submit(1, [email("grace@example.com"), password("cobol")]);
        yield* Effect.promise(() => session.idle());

        const after = yield* passwords.remove({
          profileId: "work",
          origin: GITHUB,
          username: "ada@example.com",
        });
        expect(after.saved.map((saved) => saved.username)).toEqual(["grace@example.com"]);
        const missing = yield* Effect.flip(
          passwords.remove({ profileId: "work", origin: GITHUB, username: "ada@example.com" }),
        );
        expect(missing.reason).toBe("not_found");
        expect(
          yield* Effect.promise(() => tab.fill(session, 1, [email("ada@example.com"), password()])),
        ).toEqual([]);

        yield* passwords.setSettings({ profileId: "work", agentsMayUse: false });
        yield* passwords.forget("work");
        expect(yield* passwords.get("work")).toEqual({
          settings: { savePasswords: true, agentsMayUse: true },
          saved: [],
        });
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        expect(Option.isNone(yield* secrets.get(BrowserPasswords.passwordSecretName("work")))).toBe(
          true,
        );
        session.detach();
      }),
    ),
  );
});
