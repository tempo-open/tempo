/**
 * The `icloud-keychain` passkey provider: modal ceremonies go over the laptop-tools bridge to the
 * Mac of the session holding the tab, whose desktop app shows the system passkey sheet. Without a
 * Mac that can answer, and always on the environment's own `localhost`, the saved passkeys do.
 * Agents get NotAllowedError unless allowed, and even then only the Mac, which asks the person.
 */
import type {
  TempoPasskeyCeremonyKind,
  TempoPasskeySettings,
  LaptopPasskeyRequest,
  LaptopPasskeyResult,
  ThreadId,
} from "@t3tools/contracts";
import type { CDPSession } from "playwright-core";

import {
  PASSKEY_ANSWER,
  PASSKEY_BINDING,
  passkeyPageScript,
  parsePageMessage,
  preparePasskeyRequest,
  refusePasskey,
  type PagePasskeyAnswer,
} from "./icloudPasskeyPage.ts";

/** How much longer than the sheet's own timeout the server waits for the laptop. */
const LAPTOP_PASSKEY_MARGIN_MS = 30_000;

const FALLBACK: PagePasskeyAnswer = { fallback: true };

export interface ICloudKeychainOptions {
  /**
   * Runs one ceremony on the laptop of `sessionId`, or on the only laptop
   * that can when no session holds the tab. `no-laptop` when none can.
   */
  readonly relay: (input: {
    readonly sessionId: string | undefined;
    readonly request: LaptopPasskeyRequest;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }) => Promise<LaptopPasskeyResult | "no-laptop">;
  readonly settings: (profileId: string) => Promise<TempoPasskeySettings>;
  readonly threadTitle: (threadId: ThreadId) => Promise<string>;
  readonly warn: (message: string, cause: unknown) => void;
}

/** One ceremony a page asked for, with what the server knows about who asked. */
export interface PasskeyCeremony {
  readonly profileId: string;
  readonly threadId: ThreadId | undefined;
  readonly kind: TempoPasskeyCeremonyKind;
  /** Read from the browser, never from the page. */
  readonly origin: string;
  readonly publicKey: unknown;
  /** Whether an agent opened or acted in the page; read again when the laptop answers. */
  readonly agentTouched: () => boolean;
  /** The session of the person holding the tab, if anyone does. */
  readonly controllerSessionId: string | null;
  readonly signal: AbortSignal;
}

/**
 * The answer when no Mac does: the profile's saved passkeys if it keeps them.
 * With iCloud Keychain, never for a page an agent touched: an agent signs in
 * only through the Mac's prompt.
 */
const withoutMac = (settings: TempoPasskeySettings, agentTouched: boolean): PagePasskeyAnswer =>
  settings.savePasskeys && !(agentTouched && settings.provider === "icloud-keychain")
    ? FALLBACK
    : refusePasskey();

const isLocalHost = (host: string) => host === "localhost" || host.endsWith(".localhost");

/** How DevTools reports an opaque origin, such as a CSP-sandboxed page's. */
const isOpaqueOrigin = (origin: string) => origin === "" || origin === "://" || origin === "null";

/**
 * Whether a Mac may answer for this page: only https sites off the
 * environment's own machine. The environment's `localhost` is not the
 * person's, and the Mac's passkeys for it belong to the Mac's own local sites.
 */
const laptopMayAnswer = (origin: string, rpId: string) => {
  const { protocol, hostname } = new URL(origin);
  return protocol === "https:" && !isLocalHost(hostname) && !isLocalHost(rpId);
};

/** Answers one ceremony: from the person's Mac, by falling back to saved passkeys, or with an error. */
export const runPasskeyCeremony = async (
  options: ICloudKeychainOptions,
  ceremony: PasskeyCeremony,
): Promise<PagePasskeyAnswer> => {
  const prepared = preparePasskeyRequest(ceremony);
  if ("error" in prepared) return refusePasskey(prepared.error);
  const settings = await options.settings(ceremony.profileId);
  // Whatever answers, a page an agent touched may not sign in unless the profile allows it.
  const agentTouched = ceremony.agentTouched();
  if (agentTouched && !settings.agentsMayUse) return refusePasskey();
  // No Mac for this page: the profile switched back to saved passkeys (a page
  // may still run the script), the tab has no thread to name, or the page is
  // on the environment's own machine.
  if (
    settings.provider !== "icloud-keychain" ||
    ceremony.threadId === undefined ||
    !laptopMayAnswer(ceremony.origin, prepared.rpId)
  ) {
    return withoutMac(settings, agentTouched);
  }
  const threadTitle = await options.threadTitle(ceremony.threadId).catch(() => "");
  const result = await options.relay({
    sessionId: ceremony.controllerSessionId ?? undefined,
    request: {
      _tag: "passkey",
      ceremony: ceremony.kind,
      origin: ceremony.origin,
      rpId: prepared.rpId,
      publicKey: ceremony.publicKey,
      threadId: ceremony.threadId,
      threadTitle: threadTitle.slice(0, 500),
      requester: agentTouched ? "agent" : ceremony.controllerSessionId !== null ? "person" : "page",
      timeoutMs: prepared.timeoutMs,
    },
    timeoutMs: prepared.timeoutMs + LAPTOP_PASSKEY_MARGIN_MS,
    signal: ceremony.signal,
  });
  if (ceremony.signal.aborted) return refusePasskey("AbortError");
  // An agent that acted while the sheet was open does not get the sign-in.
  const latest = await options.settings(ceremony.profileId);
  const touchedSince = ceremony.agentTouched();
  if (touchedSince && !latest.agentsMayUse) return refusePasskey();
  if (result === "no-laptop") return withoutMac(latest, touchedSince);
  switch (result._tag) {
    case "created":
    case "asserted":
      return { success: true, data: result.data };
    case "refused":
      return refusePasskey(result.error);
    case "unavailable":
      return withoutMac(latest, touchedSince);
  }
};

export interface ICloudKeychainTarget {
  readonly profileId: string;
  readonly threadId: ThreadId | undefined;
  readonly cdp: Pick<CDPSession, "send" | "on" | "off">;
  readonly controllerSessionId: () => string | null;
  readonly agentTouched: () => boolean;
}

export interface ICloudKeychainTab {
  /** Installs or removes the page script to follow the profile's provider. */
  readonly apply: () => Promise<void>;
  readonly detach: () => void;
  /** Resolves once the tab's ceremonies in flight have been answered. */
  readonly idle: () => Promise<void>;
}

const constVoid = () => {};

/**
 * Serves one tab while it is open. The page script runs only while the
 * profile's provider is `icloud-keychain`; `apply` follows a change, for the
 * page already open (once its script is in) and every page after it.
 */
export const attachICloudKeychain = (
  options: ICloudKeychainOptions,
  target: ICloudKeychainTarget,
): ICloudKeychainTab => {
  const { cdp } = target;
  /** Ceremonies in flight, by execution context and the page's own id. */
  const inFlight = new Map<string, { readonly contextId: number; readonly abort: () => void }>();
  const running = new Set<Promise<void>>();
  /**
   * Each execution context's security origin as the browser reports it.
   * `location.origin` is the URL's origin: a sandboxed (opaque-origin) page
   * still reads its site there, but must not sign in as it.
   */
  const contextOrigins = new Map<number, string>();
  let scriptId: string | null = null;
  /**
   * Once bound, the binding stays for the tab's life: a page still running the
   * script after a switch back to saved passkeys must get its fallback answer,
   * not wait on a binding that no longer reports.
   */
  let bound = false;
  let detached = false;
  let queue = Promise.resolve();

  const answer = (contextId: number, id: number, result: PagePasskeyAnswer) =>
    cdp
      .send("Runtime.evaluate", {
        contextId,
        // `window` and the answer function are unforgeable, so the page cannot intercept it.
        expression: `window.${PASSKEY_ANSWER}(${id}, ${JSON.stringify(result)})`,
      })
      .then(constVoid, constVoid);

  /**
   * The context's committed origin, if it is a top-level page whose security
   * origin is that same origin; the page cannot change any of them.
   */
  const topOrigin = async (contextId: number) => {
    const securityOrigin = contextOrigins.get(contextId);
    if (securityOrigin === undefined || isOpaqueOrigin(securityOrigin)) return null;
    const read = await cdp
      .send("Runtime.evaluate", {
        contextId,
        expression: "[location.origin, window.top === window]",
        returnByValue: true,
      })
      .catch(() => null);
    const value: unknown = read?.result.value;
    if (!Array.isArray(value)) return null;
    const [origin, top] = value as ReadonlyArray<unknown>;
    return origin === securityOrigin && top === true ? origin : null;
  };

  const serve = (contextId: number, payload: string) => {
    const message = parsePageMessage(payload);
    if (message === null) return;
    const key = `${contextId}:${message.id}`;
    if (message.kind === "cancel") {
      inFlight.get(key)?.abort();
      return;
    }
    if (inFlight.has(key)) return;
    const controller = new AbortController();
    inFlight.set(key, { contextId, abort: () => controller.abort() });
    const work = (async () => {
      const origin = await topOrigin(contextId);
      const result =
        origin === null
          ? refusePasskey()
          : await runPasskeyCeremony(options, {
              profileId: target.profileId,
              threadId: target.threadId,
              kind: message.kind,
              origin,
              publicKey: message.publicKey,
              agentTouched: target.agentTouched,
              controllerSessionId: target.controllerSessionId(),
              signal: controller.signal,
            }).catch((cause: unknown) => {
              options.warn("A passkey request from a server tab failed.", cause);
              return refusePasskey();
            });
      // A page that cancelled already rejected; one that went away has nobody to answer.
      if (!controller.signal.aborted && !detached) await answer(contextId, message.id, result);
    })().finally(() => {
      inFlight.delete(key);
      running.delete(work);
    });
    running.add(work);
  };

  const onBinding = (event: { name: string; payload: string; executionContextId: number }) => {
    if (event.name !== PASSKEY_BINDING || detached || !bound) return;
    serve(event.executionContextId, event.payload);
  };
  // Runtime.enable reports the contexts already open, then each new one.
  const onContextCreated = (event: { context: { id: number; origin: string } }) => {
    contextOrigins.set(event.context.id, event.context.origin);
  };
  // A page that navigated away or closed no longer waits; the laptop's sheet is told to stop.
  const onContextGone = (event: { executionContextId: number }) => {
    contextOrigins.delete(event.executionContextId);
    for (const entry of inFlight.values()) {
      if (entry.contextId === event.executionContextId) entry.abort();
    }
  };
  const onContextsCleared = () => {
    contextOrigins.clear();
    for (const entry of inFlight.values()) entry.abort();
  };

  const applyNow = async () => {
    if (detached) return;
    const wanted = (await options.settings(target.profileId)).provider === "icloud-keychain";
    if (wanted === (scriptId !== null)) return;
    if (wanted) {
      if (!bound) {
        await cdp.send("Runtime.enable");
        await cdp.send("Runtime.addBinding", { name: PASSKEY_BINDING });
        bound = true;
      }
      ({ identifier: scriptId } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: passkeyPageScript(),
        runImmediately: true,
      }));
      return;
    }
    // New pages load without the script; the open one answers from saved passkeys.
    const identifier = scriptId;
    scriptId = null;
    if (identifier !== null) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier });
    }
  };

  cdp.on("Runtime.bindingCalled", onBinding);
  cdp.on("Runtime.executionContextCreated", onContextCreated);
  cdp.on("Runtime.executionContextDestroyed", onContextGone);
  cdp.on("Runtime.executionContextsCleared", onContextsCleared);

  return {
    apply: () => {
      const run = queue.then(applyNow);
      queue = run.catch((cause: unknown) => {
        if (!detached) options.warn("Could not switch a tab's passkeys to iCloud Keychain.", cause);
      });
      return run;
    },
    detach: () => {
      detached = true;
      cdp.off("Runtime.bindingCalled", onBinding);
      cdp.off("Runtime.executionContextCreated", onContextCreated);
      cdp.off("Runtime.executionContextDestroyed", onContextGone);
      cdp.off("Runtime.executionContextsCleared", onContextsCleared);
      for (const entry of inFlight.values()) entry.abort();
    },
    idle: async () => {
      await queue;
      while (running.size > 0) await Promise.all(running);
    },
  };
};
