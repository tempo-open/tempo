import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  TEMPO_DEFAULT_PASSKEY_SETTINGS,
  type TempoPasskeySettings,
  LaptopToolHostId,
  type LaptopPasskeyRequest,
  type LaptopPasskeyResult,
  type LaptopToolsStreamEvent,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as LaptopToolHosts from "../laptopTools/LaptopToolHosts.ts";
import type { BrowserAuthenticatorTarget } from "./BrowserAuthenticator.ts";
import * as BrowserPasskeys from "./BrowserPasskeys.ts";
import { PASSKEY_ANSWER, PASSKEY_BINDING } from "./icloudPasskeyPage.ts";
import {
  attachICloudKeychain,
  type ICloudKeychainOptions,
  type PasskeyCeremony,
  runPasskeyCeremony,
} from "./ICloudKeychainPasskeys.ts";

const threadId = ThreadId.make("thread-passkeys");
const ICLOUD: TempoPasskeySettings = {
  ...TEMPO_DEFAULT_PASSKEY_SETTINGS,
  provider: "icloud-keychain",
};

const createdData = {
  credentialId: "AQID",
  clientDataJSON: "BA",
  attestationObject: "Cg",
  authData: "Cw",
  publicKey: "DA",
  publicKeyAlgorithm: -7,
  transports: [],
  extensions: {},
};

interface Relayed {
  readonly sessionId: string | undefined;
  readonly request: LaptopPasskeyRequest;
  readonly signal: AbortSignal;
}

/** Options whose laptop answers with `answer`; every relayed request is kept. */
const fakeOptions = (
  settings: TempoPasskeySettings,
  answer: (relayed: Relayed) => Promise<LaptopPasskeyResult | "no-laptop">,
) => {
  const relayed: Relayed[] = [];
  const current = { settings };
  const options: ICloudKeychainOptions = {
    relay: (input) => {
      relayed.push(input);
      return answer(input);
    },
    settings: async () => current.settings,
    threadTitle: async () => "Sign in to GitHub",
    warn: () => {},
  };
  return { options, relayed, current };
};

const ceremony = (overrides: Partial<PasskeyCeremony> = {}): PasskeyCeremony => ({
  profileId: "work",
  threadId,
  kind: "get",
  origin: "https://github.com",
  publicKey: { challenge: { $b64u: "AQ" } },
  agentTouched: () => false,
  controllerSessionId: "session-me",
  signal: new AbortController().signal,
  ...overrides,
});

describe("runPasskeyCeremony", () => {
  it("sends a person's ceremony to their own Mac, with the origin the browser reported", async () => {
    const { options, relayed } = fakeOptions(ICLOUD, async () => ({
      _tag: "created",
      data: createdData,
    }));
    const answer = await runPasskeyCeremony(options, ceremony({ kind: "create" }));
    expect(answer).toEqual({ success: true, data: createdData });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]?.sessionId).toBe("session-me");
    expect(relayed[0]?.request).toEqual({
      _tag: "passkey",
      ceremony: "create",
      origin: "https://github.com",
      rpId: "github.com",
      publicKey: { challenge: { $b64u: "AQ" } },
      threadId,
      threadTitle: "Sign in to GitHub",
      requester: "person",
      timeoutMs: 300_000,
    });
  });

  it("refuses a page an agent touched, unless the profile lets agents use passkeys", async () => {
    const refused = fakeOptions(ICLOUD, async () => ({ _tag: "created", data: createdData }));
    expect(
      await runPasskeyCeremony(refused.options, ceremony({ agentTouched: () => true })),
    ).toEqual({ success: false, error: "NotAllowedError" });
    expect(refused.relayed).toHaveLength(0);

    // Allowed, the agent's request still reaches the Mac, which asks the person first.
    const allowed = fakeOptions({ ...ICLOUD, agentsMayUse: true }, async () => ({
      _tag: "asserted",
      data: { ...createdData, authenticatorData: "BQ", signature: "Bg", userHandle: "" },
    }));
    const answer = await runPasskeyCeremony(
      allowed.options,
      ceremony({ agentTouched: () => true, controllerSessionId: null }),
    );
    expect(answer).toMatchObject({ success: true });
    expect(allowed.relayed[0]?.request.requester).toBe("agent");
    expect(allowed.relayed[0]?.sessionId).toBeUndefined();
  });

  it("drops the answer when an agent acted in the page while the sheet was open", async () => {
    let touched = false;
    const { options } = fakeOptions(ICLOUD, async () => {
      touched = true;
      return { _tag: "created", data: createdData };
    });
    expect(await runPasskeyCeremony(options, ceremony({ agentTouched: () => touched }))).toEqual({
      success: false,
      error: "NotAllowedError",
    });
  });

  it("falls back to saved passkeys only when no Mac can answer and the profile keeps them", async () => {
    const noLaptop = fakeOptions(ICLOUD, async () => "no-laptop");
    expect(await runPasskeyCeremony(noLaptop.options, ceremony())).toEqual({ fallback: true });

    const unentitled = fakeOptions(ICLOUD, async () => ({
      _tag: "unavailable",
      status: "awaiting-entitlement",
    }));
    expect(
      await runPasskeyCeremony(unentitled.options, ceremony({ controllerSessionId: null })),
    ).toEqual({ fallback: true });
    expect(unentitled.relayed[0]?.request.requester).toBe("page");

    const nothingSaved = fakeOptions({ ...ICLOUD, savePasskeys: false }, async () => "no-laptop");
    expect(await runPasskeyCeremony(nothingSaved.options, ceremony())).toEqual({
      success: false,
      error: "NotAllowedError",
    });

    // The person saying no is not a reason to fall back.
    const cancelled = fakeOptions(ICLOUD, async () => ({
      _tag: "refused",
      error: "NotAllowedError",
    }));
    expect(await runPasskeyCeremony(cancelled.options, ceremony())).toEqual({
      success: false,
      error: "NotAllowedError",
    });

    // A profile switched back to saved passkeys answers pages that still run the script.
    const switched = fakeOptions(TEMPO_DEFAULT_PASSKEY_SETTINGS, async () => "no-laptop");
    expect(await runPasskeyCeremony(switched.options, ceremony())).toEqual({ fallback: true });
    expect(switched.relayed).toHaveLength(0);
  });

  it("never hands an allowed agent's sign-in to saved passkeys when no Mac answers", async () => {
    const allowed = { ...ICLOUD, agentsMayUse: true };
    const answers = ["no-laptop", { _tag: "unavailable", status: "awaiting-entitlement" }] as const;
    for (const answer of answers) {
      const { options } = fakeOptions(allowed, async () => answer);
      expect(await runPasskeyCeremony(options, ceremony({ agentTouched: () => true }))).toEqual({
        success: false,
        error: "NotAllowedError",
      });
    }
    // Nor an agent that acted while a person's request was out.
    let touched = false;
    const late = fakeOptions(allowed, async () => {
      touched = true;
      return "no-laptop";
    });
    expect(
      await runPasskeyCeremony(late.options, ceremony({ agentTouched: () => touched })),
    ).toEqual({ success: false, error: "NotAllowedError" });
    // With saved passkeys as the provider, an allowed agent still uses them.
    const saved = fakeOptions(
      { ...TEMPO_DEFAULT_PASSKEY_SETTINGS, agentsMayUse: true },
      async () => "no-laptop",
    );
    expect(await runPasskeyCeremony(saved.options, ceremony({ agentTouched: () => true }))).toEqual(
      {
        fallback: true,
      },
    );
  });

  it("keeps pages on the environment's own localhost to saved passkeys", async () => {
    const { options, relayed } = fakeOptions(ICLOUD, async () => ({
      _tag: "created",
      data: createdData,
    }));
    for (const origin of ["http://localhost:5173", "https://localhost", "https://app.localhost"]) {
      expect(await runPasskeyCeremony(options, ceremony({ origin }))).toEqual({ fallback: true });
    }
    expect(relayed).toHaveLength(0);
  });

  it("refuses a relying party outside the page's origin before asking any Mac", async () => {
    const { options, relayed } = fakeOptions(ICLOUD, async () => "no-laptop");
    expect(
      await runPasskeyCeremony(options, ceremony({ publicKey: { rpId: "google.com" } })),
    ).toEqual({ success: false, error: "SecurityError" });
    expect(relayed).toHaveLength(0);
  });
});

/** One tab's DevTools session: records commands and answers origin reads. */
class FakeCdp {
  readonly commands: Array<{ readonly method: string; readonly params: Record<string, unknown> }> =
    [];
  private readonly listeners = new Map<string, Set<(payload: unknown) => void>>();
  /** What `[location.origin, window.top === window]` reads in each context. */
  private readonly contexts = new Map<number, readonly [string, boolean]>();
  /** Each context's security origin, as Runtime reports it once enabled. */
  private readonly securityOrigins = new Map<number, string>();
  private runtimeEnabled = false;

  readonly cdp = {
    send: async (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
      this.commands.push({ method, params });
      if (method === "Runtime.enable") {
        this.runtimeEnabled = true;
        for (const id of this.securityOrigins.keys()) this.announce(id);
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") return { identifier: "script-1" };
      if (method === "WebAuthn.addVirtualAuthenticator") return { authenticatorId: "auth-1" };
      if (method === "WebAuthn.getCredentials") return { credentials: [] };
      if (method === "Runtime.evaluate" && params.returnByValue === true) {
        const context = this.contexts.get(params.contextId as number);
        if (context === undefined) throw new Error("Cannot find context with specified id");
        return { result: { value: [...context] } };
      }
      return {};
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

  get typed() {
    // The fake answers only what the bridge sends.
    return this.cdp as unknown as BrowserAuthenticatorTarget["cdp"];
  }

  emit(event: string, payload: unknown) {
    for (const listener of this.listeners.get(event) ?? []) listener(payload);
  }

  /**
   * A page or frame loads in a context. `securityOrigin` differs from the URL's
   * origin for a sandboxed page, which DevTools reports as opaque.
   */
  open(id: number, origin: string, top: boolean, securityOrigin = origin) {
    this.contexts.set(id, [origin, top]);
    this.securityOrigins.set(id, securityOrigin);
    if (this.runtimeEnabled) this.announce(id);
  }

  private announce(id: number) {
    this.emit("Runtime.executionContextCreated", {
      context: { id, origin: this.securityOrigins.get(id), name: "", uniqueId: `context-${id}` },
    });
  }

  /** The page calls the binding from a context. */
  request(executionContextId: number, message: unknown) {
    this.emit("Runtime.bindingCalled", {
      name: PASSKEY_BINDING,
      payload: JSON.stringify(message),
      executionContextId,
    });
  }

  methods() {
    return this.commands.map((command) => command.method);
  }

  /** The answers the server sent into the page, by context. */
  answers() {
    return this.commands
      .filter(
        (command) =>
          command.method === "Runtime.evaluate" &&
          String(command.params.expression).startsWith(`window.${PASSKEY_ANSWER}(`),
      )
      .map((command) => ({
        contextId: command.params.contextId,
        expression: command.params.expression,
      }));
  }
}

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

describe("attachICloudKeychain", () => {
  it("runs the page script only while the profile uses iCloud Keychain", async () => {
    const tab = new FakeCdp();
    const { options, current } = fakeOptions(
      TEMPO_DEFAULT_PASSKEY_SETTINGS,
      async () => "no-laptop",
    );
    const bridge = attachICloudKeychain(options, {
      profileId: "work",
      threadId,
      cdp: tab.typed,
      controllerSessionId: () => "session-me",
      agentTouched: () => false,
    });
    await bridge.apply();
    expect(tab.methods()).toEqual([]);

    current.settings = ICLOUD;
    await bridge.apply();
    expect(tab.methods()).toEqual([
      "Runtime.enable",
      "Runtime.addBinding",
      "Page.addScriptToEvaluateOnNewDocument",
    ]);
    expect(tab.commands[2]?.params.runImmediately).toBe(true);
    await bridge.apply();
    expect(tab.commands).toHaveLength(3);

    // Back to saved passkeys: new pages load without the script, and the open page,
    // which still runs it, gets its fallback answer over the binding it keeps.
    current.settings = TEMPO_DEFAULT_PASSKEY_SETTINGS;
    await bridge.apply();
    expect(tab.methods().slice(3)).toEqual(["Page.removeScriptToEvaluateOnNewDocument"]);
    tab.open(5, "https://github.com", true);
    tab.request(5, { id: 1, kind: "get", publicKey: {} });
    await bridge.idle();
    expect(tab.answers()).toEqual([
      {
        contextId: 5,
        expression: `window.${PASSKEY_ANSWER}(1, ${JSON.stringify({ fallback: true })})`,
      },
    ]);

    // And back again: the binding is already there.
    current.settings = ICLOUD;
    await bridge.apply();
    expect(tab.methods().slice(-1)).toEqual(["Page.addScriptToEvaluateOnNewDocument"]);
    expect(tab.methods().filter((method) => method === "Runtime.addBinding")).toHaveLength(1);
    bridge.detach();
  });

  it("answers a top-level page from the Mac and refuses a frame's own call", async () => {
    const tab = new FakeCdp();
    tab.open(7, "https://github.com", true);
    tab.open(8, "https://ads.example.com", false);
    const { options, relayed } = fakeOptions(ICLOUD, async () => ({
      _tag: "created",
      data: createdData,
    }));
    const bridge = attachICloudKeychain(options, {
      profileId: "work",
      threadId,
      cdp: tab.typed,
      controllerSessionId: () => "session-me",
      agentTouched: () => false,
    });
    await bridge.apply();

    tab.request(7, { id: 1, kind: "create", publicKey: { challenge: { $b64u: "AQ" } } });
    tab.request(8, { id: 1, kind: "get", publicKey: { challenge: { $b64u: "AQ" } } });
    await bridge.idle();

    expect(relayed.map((input) => input.request.origin)).toEqual(["https://github.com"]);
    expect(tab.answers()).toEqual([
      {
        contextId: 8,
        expression: `window.${PASSKEY_ANSWER}(1, ${JSON.stringify({ success: false, error: "NotAllowedError" })})`,
      },
      {
        contextId: 7,
        expression: `window.${PASSKEY_ANSWER}(1, ${JSON.stringify({ success: true, data: createdData })})`,
      },
    ]);
    bridge.detach();
  });

  it("refuses a sandboxed page that reads its site's URL but has an opaque origin", async () => {
    const tab = new FakeCdp();
    // Served with `Content-Security-Policy: sandbox allow-scripts`: `location.origin`
    // still names the site, while DevTools reports the context's origin as opaque.
    tab.open(9, "https://github.com", true, "://");
    const { options, relayed } = fakeOptions(ICLOUD, async () => ({
      _tag: "created",
      data: createdData,
    }));
    const bridge = attachICloudKeychain(options, {
      profileId: "work",
      threadId,
      cdp: tab.typed,
      controllerSessionId: () => "session-me",
      agentTouched: () => false,
    });
    await bridge.apply();

    tab.request(9, { id: 1, kind: "get", publicKey: { challenge: { $b64u: "AQ" } } });
    await bridge.idle();

    expect(relayed).toEqual([]);
    expect(tab.answers()).toEqual([
      {
        contextId: 9,
        expression: `window.${PASSKEY_ANSWER}(1, ${JSON.stringify({ success: false, error: "NotAllowedError" })})`,
      },
    ]);
    bridge.detach();
  });

  it("stops the Mac's ceremony when the page cancels or goes away", async () => {
    const tab = new FakeCdp();
    tab.open(7, "https://github.com", true);
    const aborted: string[] = [];
    const { options } = fakeOptions(ICLOUD, (input) => {
      const settled = deferred<LaptopPasskeyResult>();
      input.signal.addEventListener("abort", () => {
        aborted.push(input.request.ceremony);
        settled.resolve({ _tag: "refused", error: "AbortError" });
      });
      return settled.promise;
    });
    const bridge = attachICloudKeychain(options, {
      profileId: "work",
      threadId,
      cdp: tab.typed,
      controllerSessionId: () => "session-me",
      agentTouched: () => false,
    });
    await bridge.apply();

    tab.request(7, { id: 1, kind: "get", publicKey: {} });
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
    await new Promise((resolve) => setImmediate(resolve));
    tab.request(7, { id: 1, kind: "cancel" });
    tab.request(7, { id: 2, kind: "create", publicKey: {} });
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
    await new Promise((resolve) => setImmediate(resolve));
    tab.emit("Runtime.executionContextDestroyed", { executionContextId: 7 });
    await bridge.idle();

    expect(aborted).toEqual(["get", "create"]);
    // The page already rejected; nothing is sent into it.
    expect(tab.answers()).toEqual([]);
    bridge.detach();
  });
});

const passkeysWithLaptops = (baseDir: string) =>
  BrowserPasskeys.layer.pipe(
    Layer.provideMerge(LaptopToolHosts.layer),
    Layer.provideMerge(ServerSecretStore.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

it.layer(NodeServices.layer)("BrowserPasskeys with iCloud Keychain", (it) => {
  it.effect("routes a server tab's ceremony to the laptop of the person holding it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-icloud-passkeys-" });
      yield* Effect.gen(function* () {
        const passkeys = yield* BrowserPasskeys.BrowserPasskeys;
        const hosts = yield* LaptopToolHosts.LaptopToolHosts;
        const view = yield* passkeys.setSettings({
          profileId: "work",
          provider: "icloud-keychain",
        });
        expect(view.availableProviders).toEqual(["saved", "icloud-keychain"]);

        // The person's Mac, registered from the session that holds the tab.
        const requests: LaptopToolsStreamEvent[] = [];
        const stream = yield* hosts.connect(
          {
            hostId: LaptopToolHostId.make("macbook"),
            hostLabel: "MacBook",
            servers: [],
            accepts: ["passkey"],
          },
          "session-me",
        );
        const connected = yield* Deferred.make<void>();
        yield* Stream.runForEach(stream, (event) =>
          Effect.gen(function* () {
            requests.push(event);
            if (event.type === "connected") yield* Deferred.succeed(connected, undefined);
            if (event.type !== "request") return;
            yield* hosts.respond(
              {
                hostId: LaptopToolHostId.make("macbook"),
                connectionId: event.connectionId,
                requestId: event.requestId,
                outcome: { _tag: "passkey", result: { _tag: "created", data: createdData } },
              },
              "session-me",
            );
          }),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);

        const tab = new FakeCdp();
        tab.open(3, "https://github.com", true);
        const session = yield* passkeys.attach({
          profileId: "work",
          cdp: tab.typed,
          agentTouched: false,
          linkedTabsTouched: () => false,
          threadId,
          controllerSessionId: () => "session-me",
        });
        // The saved authenticator stays beside the bridge, for fallbacks and autofill.
        expect(tab.methods()).toContain("WebAuthn.addVirtualAuthenticator");
        expect(tab.methods()).toContain("Page.addScriptToEvaluateOnNewDocument");

        tab.request(3, { id: 1, kind: "create", publicKey: { challenge: { $b64u: "AQ" } } });
        yield* Effect.promise(() => session.idle());
        const request = requests.find((event) => event.type === "request");
        expect(request?.type === "request" ? request.request : null).toMatchObject({
          _tag: "passkey",
          ceremony: "create",
          origin: "https://github.com",
          rpId: "github.com",
          requester: "person",
        });
        expect(tab.answers()).toEqual([
          {
            contextId: 3,
            expression: `window.${PASSKEY_ANSWER}(1, ${JSON.stringify({ success: true, data: createdData })})`,
          },
        ]);

        // Someone else holding the tab has no Mac here: the saved passkeys answer.
        const other = new FakeCdp();
        other.open(4, "https://github.com", true);
        const otherSession = yield* passkeys.attach({
          profileId: "work",
          cdp: other.typed,
          agentTouched: false,
          linkedTabsTouched: () => false,
          threadId,
          controllerSessionId: () => "session-someone-else",
        });
        other.request(4, { id: 1, kind: "get", publicKey: {} });
        yield* Effect.promise(() => otherSession.idle());
        expect(other.answers()).toEqual([
          {
            contextId: 4,
            expression: `window.${PASSKEY_ANSWER}(1, ${JSON.stringify({ fallback: true })})`,
          },
        ]);
        expect(requests.filter((event) => event.type === "request")).toHaveLength(1);
        session.detach();
        otherSession.detach();
      }).pipe(Effect.provide(passkeysWithLaptops(baseDir)));
    }).pipe(Effect.scoped),
  );

  it.effect("keeps saved passkeys locked in an agent's page while the Mac answers for it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-icloud-passkeys-" });
      yield* Effect.gen(function* () {
        const passkeys = yield* BrowserPasskeys.BrowserPasskeys;
        yield* passkeys.setSettings({
          profileId: "work",
          provider: "icloud-keychain",
          agentsMayUse: true,
        });
        const tab = new FakeCdp();
        const presence = () =>
          tab.commands.findLast(
            (command) => command.method === "WebAuthn.setAutomaticPresenceSimulation",
          )?.params.enabled;
        const session = yield* passkeys.attach({
          profileId: "work",
          cdp: tab.typed,
          agentTouched: true,
          linkedTabsTouched: () => false,
          threadId,
          controllerSessionId: () => null,
        });
        yield* Effect.promise(() => session.idle());
        // Frames and fallbacks reach Chrome's authenticator, which must not sign for the agent.
        expect(presence()).toBe(false);

        // Back to saved passkeys, an allowed agent signs in with them again.
        yield* passkeys.setSettings({ profileId: "work", provider: "saved" });
        yield* Effect.promise(() => session.idle());
        expect(presence()).toBe(true);
        session.detach();
      }).pipe(Effect.provide(passkeysWithLaptops(baseDir)));
    }).pipe(Effect.scoped),
  );
});
