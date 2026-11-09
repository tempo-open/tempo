import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import type {
  BrowserAuthenticatorSession,
  BrowserAuthenticatorTarget,
} from "./BrowserAuthenticator.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";

interface Credential {
  readonly credentialId: string;
  readonly isResidentCredential: boolean;
  readonly rpId: string;
  readonly privateKey: string;
  readonly userHandle: string;
  readonly signCount: number;
  readonly userName: string;
  readonly userDisplayName: string;
}

const credential = (
  signCount: number,
  credentialId = "Y3JlZA==",
  userHandle = "dXNlcg==",
): Credential => ({
  credentialId,
  isResidentCredential: true,
  rpId: "github.com",
  privateKey: "cHJpdmF0ZQ==",
  userHandle,
  signCount,
  userName: "octocat",
  userDisplayName: "The Octocat",
});

/**
 * One tab and the virtual authenticator Chrome keeps for it, as Chrome 153 behaves: a ceremony
 * needs presence when it starts, removing or clearing credentials reports each one deleted, a site
 * keeps one passkey per account, a page has one internal authenticator at most, and any DevTools
 * session leaving the page drops its authenticators.
 */
class FakeTab {
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** Whether a tab linked to this one by `window.opener` holds an agent's page. */
  linkedTouched = false;
  /** Credential ids Chrome refuses to add. */
  readonly refused = new Set<string>();
  /** Times presence went off while the tab could sign in: a ceremony then would hang. */
  presenceDropped = 0;
  /** Fails the next commands of this name, as a closing tab would. */
  failing: string | null = null;
  /** After each command, whether a page here could sign in with a passkey. */
  readonly signable: Array<boolean> = [];
  /** Whether the page's virtual authenticator environment is on (`WebAuthn.enable`). */
  private enabled = false;
  private added = 0;
  private authenticator: {
    readonly id: string;
    presence: boolean;
    verified: boolean;
    readonly credentials: Map<string, Credential>;
  } | null = null;

  private readonly agentTouched: boolean;

  constructor(agentTouched = false) {
    this.agentTouched = agentTouched;
  }

  readonly cdp = {
    send: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      try {
        if (method === this.failing) throw new Error("Target closed");
        return method.startsWith("WebAuthn.") ? this.webAuthn(method, params) : {};
      } finally {
        this.signable.push(this.canSign);
      }
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

  private webAuthn(method: string, params: Record<string, unknown>): unknown {
    // Chrome's own answers, as Playwright reports them.
    const refuse = (message: string): never => {
      throw new Error(`cdpSession.send: Protocol error (${method}): ${message}`);
    };
    if (method === "WebAuthn.enable") {
      this.enabled = true;
      return {};
    }
    if (!this.enabled)
      return refuse("The Virtual Authenticator Environment has not been enabled for this session");
    if (method === "WebAuthn.addVirtualAuthenticator") {
      if (this.authenticator)
        return refuse("Chrome only supports one internal authenticator per environment");
      const options = params.options as {
        automaticPresenceSimulation: boolean;
        isUserVerified: boolean;
      };
      this.added += 1;
      this.authenticator = {
        id: `auth-${this.added}`,
        presence: options.automaticPresenceSimulation,
        verified: options.isUserVerified,
        credentials: new Map(),
      };
      return { authenticatorId: this.authenticator.id };
    }
    const authenticator = this.authenticator;
    if (!authenticator || params.authenticatorId !== authenticator.id)
      return refuse("Could not find a Virtual Authenticator matching the ID");
    switch (method) {
      case "WebAuthn.removeVirtualAuthenticator":
        this.authenticator = null;
        return {};
      case "WebAuthn.setAutomaticPresenceSimulation":
        if (authenticator.presence && !params.enabled && authenticator.credentials.size > 0)
          this.presenceDropped += 1;
        authenticator.presence = params.enabled as boolean;
        return {};
      case "WebAuthn.setUserVerified":
        authenticator.verified = params.isUserVerified as boolean;
        return {};
      case "WebAuthn.addCredential": {
        const added = params.credential as Credential;
        const clash = [...authenticator.credentials.values()].some(
          (held) =>
            held.credentialId === added.credentialId ||
            (held.rpId === added.rpId && held.userHandle === added.userHandle),
        );
        if (clash || this.refused.has(added.credentialId))
          throw new Error(
            "Cannot create a duplicate credential for the same (RP ID, user ID) pair",
          );
        authenticator.credentials.set(added.credentialId, added);
        return {};
      }
      case "WebAuthn.removeCredential":
        this.remove(params.credentialId as string);
        return {};
      case "WebAuthn.clearCredentials":
        for (const credentialId of authenticator.credentials.keys()) this.remove(credentialId);
        return {};
      case "WebAuthn.getCredentials":
        return { credentials: [...authenticator.credentials.values()] };
      default:
        return {};
    }
  }

  /**
   * Another DevTools session on the page detached, such as a viewer's. Chrome
   * then disables the page's virtual authenticator environment, taking every
   * authenticator and credential with it.
   */
  leaveSession() {
    this.enabled = false;
    this.authenticator = null;
  }

  /** Whether a page here could sign in with one of the tab's passkeys. */
  get canSign() {
    return (
      this.authenticator !== null &&
      this.authenticator.presence &&
      this.authenticator.credentials.size > 0
    );
  }

  /** The tab's authenticator, or null when it has none. */
  get authenticatorId() {
    return this.authenticator?.id ?? null;
  }

  target(profileId: string): BrowserAuthenticatorTarget {
    return {
      profileId,
      // The fake answers only what the authenticator sends.
      cdp: this.cdp as unknown as BrowserAuthenticatorTarget["cdp"],
      agentTouched: this.agentTouched,
      linkedTabsTouched: () => this.linkedTouched,
    };
  }

  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  private remove(credentialId: string) {
    const authenticator = this.authenticator;
    if (authenticator?.credentials.delete(credentialId))
      this.emit("WebAuthn.credentialDeleted", { authenticatorId: authenticator.id, credentialId });
  }

  /** Whether a page here can sign in now. */
  get unlocked() {
    return (
      this.authenticator !== null && this.authenticator.presence && this.authenticator.verified
    );
  }

  /** The passkeys the tab holds, as `id#signCount`. */
  held() {
    return [...(this.authenticator?.credentials.values() ?? [])].map(
      (held) => `${held.credentialId}#${held.signCount}`,
    );
  }

  /** The page registers a passkey. Like Chrome, a second one for an account replaces the first. */
  create(created: Credential) {
    const authenticator = this.authenticator;
    if (!authenticator?.presence) return false;
    for (const held of authenticator.credentials.values()) {
      if (held.rpId === created.rpId && held.userHandle === created.userHandle)
        this.remove(held.credentialId);
    }
    authenticator.credentials.set(created.credentialId, created);
    this.emit("WebAuthn.credentialAdded", {
      authenticatorId: authenticator.id,
      credential: created,
    });
    return true;
  }

  /** The page signs in with a passkey it holds, moving its count forward. */
  signIn(credentialId: string) {
    const authenticator = this.authenticator;
    const held = authenticator?.presence ? authenticator.credentials.get(credentialId) : undefined;
    if (!held || !authenticator) return false;
    const used = { ...held, signCount: held.signCount + 1 };
    authenticator.credentials.set(credentialId, used);
    this.emit("WebAuthn.credentialAsserted", {
      authenticatorId: authenticator.id,
      credential: used,
    });
    return true;
  }

  /** The site says it no longer knows a passkey (`PublicKeyCredential.signalUnknownCredential`). */
  signalUnknown(credentialId: string) {
    this.remove(credentialId);
  }

  /** The main frame committed a new document. */
  navigate(type: "Navigation" | "BackForwardCacheRestore" = "Navigation") {
    this.emit("Page.frameNavigated", { frame: { id: "main" }, type });
  }
}

const passkeysFor = (baseDir: string) =>
  BrowserPasskeys.layer.pipe(
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const savedIds = (passkeys: BrowserPasskeys.BrowserPasskeys["Service"], profileId: string) =>
  passkeys.get(profileId).pipe(Effect.map((view) => view.saved.map((saved) => saved.credentialId)));

/** Waits for every tab's saves and refreshes to settle. */
const settle = (...sessions: ReadonlyArray<BrowserAuthenticatorSession>) =>
  Effect.promise(async () => {
    // A save in one tab refreshes the others, so settle twice.
    for (let round = 0; round < 2; round++) {
      for (const session of sessions) await session.idle();
    }
  });

const withPasskeys = <A, E>(
  body: (
    passkeys: BrowserPasskeys.BrowserPasskeys["Service"],
  ) => Effect.Effect<A, E, ServerSecretStore.ServerSecretStore>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-passkeys-" });
    return yield* BrowserPasskeys.BrowserPasskeys.pipe(
      Effect.flatMap(body),
      Effect.provide(passkeysFor(baseDir)),
    );
  }).pipe(Effect.scoped);

it.layer(NodeServices.layer)("BrowserPasskeys", (it) => {
  it.effect("saves passkeys a person creates and gives them to the profile's other tabs", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-passkeys-" });
      yield* Effect.gen(function* () {
        const passkeys = yield* BrowserPasskeys.BrowserPasskeys;
        const first = new FakeTab();
        const firstSession = yield* passkeys.attach(first.target("work"));
        expect(first.unlocked).toBe(true);

        expect(first.create(credential(0))).toBe(true);
        yield* settle(firstSession);
        const view = yield* passkeys.get("work");
        expect(view.saved).toEqual([
          {
            credentialId: "Y3JlZA==",
            rpId: "github.com",
            userName: "octocat",
            userDisplayName: "The Octocat",
            createdAt: expect.any(String),
            lastUsedAt: null,
          },
        ]);
        expect(JSON.stringify(view)).not.toContain("cHJpdmF0ZQ==");
        expect(first.held()).toEqual(["Y3JlZA==#0"]);

        // A tab opened later gets the saved passkey.
        const second = new FakeTab();
        const secondSession = yield* passkeys.attach(second.target("work"));
        expect(second.held()).toEqual(["Y3JlZA==#0"]);

        // Signing in from the second tab moves the count forward everywhere,
        // without ever leaving the first tab unable to sign in.
        expect(second.signIn("Y3JlZA==")).toBe(true);
        yield* settle(firstSession, secondSession);
        expect(first.held()).toEqual(["Y3JlZA==#1"]);
        expect(first.presenceDropped).toBe(0);
        expect(yield* savedIds(passkeys, "work")).toEqual(["Y3JlZA=="]);
        expect((yield* passkeys.get("work")).saved[0]?.lastUsedAt).not.toBeNull();
        // A stale count from a lagging tab never moves it back.
        first.emit("WebAuthn.credentialAsserted", {
          authenticatorId: "auth-1",
          credential: credential(0),
        });
        yield* settle(firstSession, secondSession);
        expect(second.held()).toEqual(["Y3JlZA==#1"]);

        // Another profile sees none of it.
        expect((yield* passkeys.get("personal")).saved).toEqual([]);
      }).pipe(Effect.provide(passkeysFor(baseDir)));

      // A restarted server reads the same passkeys, private key included.
      yield* Effect.gen(function* () {
        const passkeys = yield* BrowserPasskeys.BrowserPasskeys;
        const tab = new FakeTab();
        const added: Array<Record<string, unknown>> = [];
        const send = tab.cdp.send;
        tab.cdp.send = async (method, params = {}) => {
          if (method === "WebAuthn.addCredential") added.push(params);
          return send(method, params);
        };
        yield* passkeys.attach(tab.target("work"));
        expect(added).toEqual([{ authenticatorId: "auth-1", credential: credential(1) }]);
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        const stored = yield* secrets.get(BrowserPasskeys.passkeySecretName("work"));
        expect(Option.isSome(stored)).toBe(true);
      }).pipe(Effect.provide(passkeysFor(baseDir)));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps passkeys from pages an agent touched until a person loads a new one", () =>
    withPasskeys((passkeys) =>
      Effect.gen(function* () {
        // A tab a person opened keeps its passkeys while nobody watches it,
        // so a sign-in as it loads works.
        const person = new FakeTab();
        const personSession = yield* passkeys.attach(person.target("work"));
        expect(person.unlocked).toBe(true);
        person.create(credential(0));
        yield* settle(personSession);

        // An agent's tab: no credentials, no presence, so sign-in fails.
        const agent = new FakeTab(true);
        const agentSession = yield* passkeys.attach(agent.target("work"));
        expect(agent.unlocked).toBe(false);
        expect(agent.held()).toEqual([]);
        expect(agent.create(credential(0, "YWdlbnQ="))).toBe(false);
        // Nothing an agent's tab reports is saved.
        agent.emit("WebAuthn.credentialAdded", {
          authenticatorId: "auth-1",
          credential: credential(0, "YWdlbnQ=", "YWdlbnQ="),
        });
        yield* settle(agentSession);
        expect(yield* savedIds(passkeys, "work")).toEqual(["Y3JlZA=="]);

        // A page the agent's script loads by itself stays locked: it could be
        // one that signs in as it loads.
        agent.navigate();
        yield* settle(agentSession);
        expect(agent.unlocked).toBe(false);
        // A person's navigation that loads no new page opens no window for one.
        yield* Effect.promise(() => agentSession.personNavigation(async () => {}));
        agent.navigate();
        yield* settle(agentSession);
        expect(agent.unlocked).toBe(false);
        // Nor while a tab linked to it still holds an agent's page.
        agent.linkedTouched = true;
        yield* Effect.promise(() => agentSession.personNavigation(async () => agent.navigate()));
        yield* settle(agentSession);
        expect(agent.unlocked).toBe(false);
        // A page the person loads from the browser's controls is theirs.
        agent.linkedTouched = false;
        yield* Effect.promise(() => agentSession.personNavigation(async () => agent.navigate()));
        yield* settle(agentSession);
        expect(agent.unlocked).toBe(true);
        expect(agentSession.agentTouched()).toBe(false);
        expect(agent.held()).toEqual(["Y3JlZA==#0"]);

        // An agent acting in the person's tab locks it before the action runs.
        let lockedDuringAction = false;
        yield* Effect.promise(() =>
          personSession.agentAction(async () => {
            lockedDuringAction = !person.unlocked && person.held().length === 0;
          }),
        );
        expect(lockedDuringAction).toBe(true);
        expect(personSession.agentTouched()).toBe(true);
        // A page its script loads, or one restored from history, stays locked;
        // so does one a person loads while the agent's action still runs.
        person.navigate();
        person.navigate("BackForwardCacheRestore");
        yield* Effect.promise(() =>
          personSession.agentAction(() =>
            personSession.personNavigation(async () => person.navigate()),
          ),
        );
        yield* settle(personSession);
        expect(person.unlocked).toBe(false);
        yield* Effect.promise(() => personSession.personNavigation(async () => person.navigate()));
        yield* settle(personSession);
        expect(person.unlocked).toBe(true);
        expect(person.held()).toEqual(["Y3JlZA==#0"]);
        // Going back to a page from before then locks it again.
        person.navigate("BackForwardCacheRestore");
        yield* settle(personSession);
        expect(person.unlocked).toBe(false);

        // Allowing agents unlocks open agent tabs at once.
        const other = new FakeTab(true);
        const otherSession = yield* passkeys.attach(other.target("work"));
        expect(other.unlocked).toBe(false);
        const allowed = yield* passkeys.setSettings({ profileId: "work", agentsMayUse: true });
        expect(allowed.settings).toEqual({
          savePasskeys: true,
          agentsMayUse: true,
          provider: "saved",
        });
        yield* settle(otherSession);
        expect(other.unlocked).toBe(true);
        expect(other.held()).toEqual(["Y3JlZA==#0"]);

        // Turning saving off removes the authenticator.
        yield* passkeys.setSettings({ profileId: "work", savePasskeys: false });
        yield* settle(otherSession);
        expect(other.unlocked).toBe(false);
        expect(other.held()).toEqual([]);
      }),
    ),
  );

  it.effect("runs an agent's action in a tab it cannot lock, which then holds no passkeys", () =>
    withPasskeys((passkeys) =>
      Effect.gen(function* () {
        const tab = new FakeTab();
        const session = yield* passkeys.attach(tab.target("work"));
        tab.create(credential(0));
        yield* settle(session);
        expect(tab.canSign).toBe(true);

        // Chrome refuses the lock, on a new authenticator too.
        tab.failing = "WebAuthn.setAutomaticPresenceSimulation";
        let during: unknown = null;
        yield* Effect.promise(() =>
          session.agentAction(async () => {
            during = { authenticator: tab.authenticatorId, canSign: tab.canSign };
          }),
        );
        expect(during).toEqual({ authenticator: null, canSign: false });

        // Once Chrome answers again, the next action sets up a locked authenticator...
        tab.failing = null;
        yield* Effect.promise(() => session.agentAction(async () => {}));
        expect(tab.authenticatorId).not.toBeNull();
        expect(tab.unlocked).toBe(false);
        expect(tab.held()).toEqual([]);
        // ...and a page the person loads gets the passkeys back.
        yield* Effect.promise(() => session.personNavigation(async () => tab.navigate()));
        yield* settle(session);
        expect(tab.unlocked).toBe(true);
        expect(tab.held()).toEqual(["Y3JlZA==#0"]);
      }),
    ),
  );

  it.effect("sets a tab up again after Chrome drops its authenticator", () =>
    withPasskeys((passkeys) =>
      Effect.gen(function* () {
        const person = new FakeTab();
        const personSession = yield* passkeys.attach(person.target("work"));
        person.create(credential(0));
        yield* settle(personSession);

        /** Runs an agent action; reports whether the tab was locked while it ran. */
        const actLocked = (tab: FakeTab, session: BrowserAuthenticatorSession) =>
          Effect.promise(async () => {
            const mark = tab.signable.length;
            let locked = false;
            await session.agentAction(async () => {
              locked = tab.authenticatorId !== null && !tab.unlocked && tab.held().length === 0;
            });
            // Nothing on the way to the lock, a new authenticator included, could sign.
            return locked && !tab.signable.slice(mark).includes(true);
          });

        // As reported: a viewer of an agent's tab leaves, and Chrome drops the
        // page's authenticator with the viewer's DevTools session. Each later
        // action still runs, in a tab locked first.
        const agent = new FakeTab(true);
        const agentSession = yield* passkeys.attach(agent.target("work"));
        agent.leaveSession();
        expect(yield* actLocked(agent, agentSession)).toBe(true);
        expect(yield* actLocked(agent, agentSession)).toBe(true);
        agent.leaveSession();
        expect(yield* actLocked(agent, agentSession)).toBe(true);
        // Nothing the locked page reports is saved.
        agent.emit("WebAuthn.credentialAdded", {
          authenticatorId: agent.authenticatorId,
          credential: credential(0, "YWdlbnQ=", "YWdlbnQ="),
        });
        yield* settle(agentSession);
        expect(yield* savedIds(passkeys, "work")).toEqual(["Y3JlZA=="]);

        // A person takes the tab over, and the page they load gets the passkeys,
        // though a viewer left before they did.
        agent.leaveSession();
        yield* Effect.promise(() => agentSession.personNavigation(async () => agent.navigate()));
        yield* settle(agentSession);
        expect(agent.unlocked).toBe(true);
        expect(agent.signIn("Y3JlZA==")).toBe(true);
        yield* settle(agentSession, personSession);
        expect(person.held()).toEqual(["Y3JlZA==#1"]);
        // They hand it back, another viewer leaves, and the agent's action finds it locked.
        agent.leaveSession();
        expect(yield* actLocked(agent, agentSession)).toBe(true);

        // A tab only a person used gets its passkeys back once the server says
        // a session left, with no agent action or navigation to set it up.
        person.leaveSession();
        expect(person.canSign).toBe(false);
        personSession.sessionDetached();
        yield* settle(personSession);
        expect(person.unlocked).toBe(true);
        expect(person.held()).toEqual(["Y3JlZA==#1"]);
        // What the person creates there is saved again.
        expect(person.create(credential(0, "bmV3", "bmV3"))).toBe(true);
        yield* settle(personSession);
        expect(yield* savedIds(passkeys, "work")).toEqual(["Y3JlZA==", "bmV3"]);
        // A session that left without taking the authenticator changes nothing.
        const kept = person.authenticatorId;
        personSession.sessionDetached();
        yield* settle(personSession);
        expect(person.authenticatorId).toBe(kept);
        expect(person.presenceDropped).toBe(0);
      }),
    ),
  );

  it.effect("keeps one passkey per site and account, as Chrome does", () =>
    withPasskeys((passkeys) =>
      Effect.gen(function* () {
        const tab = new FakeTab();
        const session = yield* passkeys.attach(tab.target("work"));
        const other = new FakeTab();
        const otherSession = yield* passkeys.attach(other.target("work"));
        tab.create(credential(0, "b2xk"));
        tab.create(credential(0, "b3RoZXI=", "b3RoZXI="));
        yield* settle(session, otherSession);
        // The site registers the account again: Chrome replaces the old credential.
        tab.create(credential(0, "bmV3"));
        yield* settle(session, otherSession);
        expect(yield* savedIds(passkeys, "work")).toEqual(["b3RoZXI=", "bmV3"]);
        expect(other.held().toSorted()).toEqual(["b3RoZXI=#0", "bmV3#0"]);
        expect(other.unlocked).toBe(true);

        // Without the deletion event, the store and the other tabs follow all the same.
        tab.emit("WebAuthn.credentialAdded", {
          authenticatorId: "auth-1",
          credential: credential(0, "bmV3ZXI="),
        });
        yield* settle(session, otherSession);
        expect(yield* savedIds(passkeys, "work")).toEqual(["b3RoZXI=", "bmV3ZXI="]);
        expect(other.held().toSorted()).toEqual(["b3RoZXI=#0", "bmV3ZXI=#0"]);
        expect(tab.held().toSorted()).toEqual(["b3RoZXI=#0", "bmV3ZXI=#0"]);

        // A passkey Chrome refuses costs a new tab none of the others.
        const next = new FakeTab();
        next.refused.add("bmV3ZXI=");
        const nextSession = yield* passkeys.attach(next.target("work"));
        expect(next.held()).toEqual(["b3RoZXI=#0"]);
        expect(next.unlocked).toBe(true);

        // A site renaming the account updates the saved name.
        tab.emit("WebAuthn.credentialUpdated", {
          authenticatorId: "auth-1",
          credential: { ...credential(0, "bmV3ZXI="), userName: "monalisa" },
        });
        yield* settle(session, otherSession, nextSession);
        const names = (yield* passkeys.get("work")).saved.map((saved) => saved.userName);
        expect(names).toEqual(["octocat", "monalisa"]);

        // A site that no longer knows a passkey removes it everywhere.
        tab.signalUnknown("b3RoZXI=");
        yield* settle(session, otherSession, nextSession);
        expect(yield* savedIds(passkeys, "work")).toEqual(["bmV3ZXI="]);
        expect(other.held()).toEqual(["bmV3ZXI=#0"]);
      }),
    ),
  );

  it.effect("deletes a passkey from the store and from open tabs", () =>
    withPasskeys((passkeys) =>
      Effect.gen(function* () {
        const tab = new FakeTab();
        const session = yield* passkeys.attach(tab.target("work"));
        tab.create(credential(0));
        yield* settle(session);

        const after = yield* passkeys.remove({ profileId: "work", credentialId: "Y3JlZA==" });
        expect(after.saved).toEqual([]);
        yield* settle(session);
        expect(tab.held()).toEqual([]);
        expect(tab.unlocked).toBe(true);
        // A tab that still signed in with it does not bring it back.
        tab.emit("WebAuthn.credentialAsserted", {
          authenticatorId: "auth-1",
          credential: credential(9),
        });
        yield* settle(session);
        expect(yield* savedIds(passkeys, "work")).toEqual([]);

        const missing = yield* Effect.flip(
          passkeys.remove({ profileId: "work", credentialId: "Y3JlZA==" }),
        );
        expect(missing.reason).toBe("not_found");
        const unavailable = yield* Effect.flip(
          passkeys.setSettings({ profileId: "work", provider: "icloud-keychain" }),
        );
        expect(unavailable.reason).toBe("provider_unavailable");

        // A removed profile's passkeys leave the secret store and its open tabs.
        tab.create(credential(0));
        yield* settle(session);
        expect(tab.held()).toEqual(["Y3JlZA==#0"]);
        yield* passkeys.forget("work");
        yield* settle(session);
        expect(tab.held()).toEqual([]);
        expect(yield* savedIds(passkeys, "work")).toEqual([]);
        const secrets = yield* ServerSecretStore.ServerSecretStore;
        expect(Option.isNone(yield* secrets.get(BrowserPasskeys.passkeySecretName("work")))).toBe(
          true,
        );
        session.detach();
      }),
    ),
  );
});
