// @effect-diagnostics globalTimers:off globalDate:off - Ceremonies settle inside IPC handlers, outside an Effect runtime.
/**
 * tempo: runs remote server tabs' WebAuthn ceremonies on this Mac with the in-app browser's backend,
 * whose `electron-webauthn` uses private macOS SPI: an OS update can break both while the startup
 * probe passes. Asks before any ceremony the person did not start and before their first sign-in
 * to each site, since only the environment says who drives a tab.
 */
import type {
  DesktopPasskeyRequestState,
  DesktopPasskeysState,
  TempoLaptopPasskeyStatus,
  TempoPasskeyErrorName,
  EnvironmentId,
  LaptopPasskeyRequest,
  LaptopPasskeyResult,
  LaptopToolsOutcome,
} from "@t3tools/contracts";

import type { PasskeyBackend } from "../../preview/PasskeyBackend.ts";
import type { PasskeyCeremonyResult } from "../../preview/PasskeyBridge.ts";

/**
 * This desktop's passkey status, from facts read at launch. `entitled` is whether the build was
 * signed with the passkey entitlement (`PreviewPasskeys.bridgeEnabled`). Before macOS 15 a
 * sign-in never settles: its result lacks the `prf` member `electron-webauthn` reads.
 */
export const laptopPasskeyStatus = (input: {
  readonly platform: NodeJS.Platform;
  readonly systemVersion: string;
  readonly entitled: boolean;
}): TempoLaptopPasskeyStatus => {
  if (input.platform !== "darwin") return "not-mac";
  const [major = 0] = input.systemVersion.split(".").map(Number);
  if (!(major >= 15)) return "unsupported-os";
  return input.entitled ? "available" : "awaiting-entitlement";
};

/** Turns the page's `{ "$b64u": ... }` members back into the ArrayBuffers WebAuthn takes. */
export const decodePasskeyOptions = (value: unknown, depth = 0): unknown => {
  if (depth > 32) return undefined;
  if (Array.isArray(value)) return value.map((item) => decodePasskeyOptions(item, depth + 1));
  if (typeof value !== "object" || value === null) return value;
  const entries = Object.entries(value);
  const [only] = entries;
  if (entries.length === 1 && only?.[0] === "$b64u" && typeof only[1] === "string") {
    return Uint8Array.from(Buffer.from(only[1], "base64url")).buffer;
  }
  return Object.fromEntries(
    entries.map(([key, member]) => [key, decodePasskeyOptions(member, depth + 1)]),
  );
};

const ERROR_NAMES: ReadonlySet<string> = new Set<TempoPasskeyErrorName>([
  "NotAllowedError",
  "InvalidStateError",
  "NotSupportedError",
  "SecurityError",
  "AbortError",
  "TypeError",
]);

const refused = (error: TempoPasskeyErrorName = "NotAllowedError"): LaptopPasskeyResult => ({
  _tag: "refused",
  error,
});

// The native layer reports extension members it did not set as `undefined`;
// the bridge's schema takes a member or its absence, so only set ones are copied.
const prfResults = (results: { readonly first?: string; readonly second?: string } | undefined) => {
  const first = results?.first;
  const second = results?.second;
  return first === undefined
    ? {}
    : { results: { first, ...(second === undefined ? {} : { second }) } };
};

/** Copies what the page needs out of the native result, nothing more. */
const resultOf = (result: PasskeyCeremonyResult): LaptopPasskeyResult => {
  if (!result.success) {
    return refused(
      ERROR_NAMES.has(result.error) ? (result.error as TempoPasskeyErrorName) : "NotAllowedError",
    );
  }
  const data = result.data;
  if ("attestationObject" in data) {
    const { credProps, prf, largeBlob } = data.extensions;
    return {
      _tag: "created",
      data: {
        credentialId: data.credentialId,
        clientDataJSON: data.clientDataJSON,
        attestationObject: data.attestationObject,
        authData: data.authData,
        publicKey: data.publicKey,
        publicKeyAlgorithm: data.publicKeyAlgorithm,
        transports: [...data.transports],
        extensions: {
          ...(credProps?.rk === undefined ? {} : { credProps: { rk: credProps.rk } }),
          ...(prf === undefined
            ? {}
            : {
                prf: {
                  ...(prf.enabled === undefined ? {} : { enabled: prf.enabled }),
                  ...prfResults(prf.results),
                },
              }),
          ...(largeBlob === undefined
            ? {}
            : {
                largeBlob:
                  largeBlob.supported === undefined ? {} : { supported: largeBlob.supported },
              }),
        },
      },
    };
  }
  const extensions = data.extensions;
  const blob = extensions?.largeBlob?.blob;
  const written = extensions?.largeBlob?.written;
  return {
    _tag: "asserted",
    data: {
      credentialId: data.credentialId,
      clientDataJSON: data.clientDataJSON,
      authenticatorData: data.authenticatorData,
      signature: data.signature,
      userHandle: data.userHandle,
      ...(extensions === undefined
        ? {}
        : {
            extensions: {
              ...(extensions.prf === undefined ? {} : { prf: prfResults(extensions.prf.results) }),
              ...(extensions.largeBlob === undefined
                ? {}
                : {
                    largeBlob: {
                      ...(blob === undefined ? {} : { blob }),
                      ...(written === undefined ? {} : { written }),
                    },
                  }),
            },
          }),
    },
  };
};

const isLocalHost = (host: string) => host === "localhost" || host.endsWith(".localhost");

/**
 * Pages on the environment's own machine never reach this Mac: an
 * environment's `localhost` is not this Mac's, and passkeys for it here belong
 * to this Mac's own local sites. The environment checks the same.
 */
const isLaptopOrigin = (origin: string, rpId: string) => {
  if (!URL.canParse(origin)) return false;
  const { protocol, hostname } = new URL(origin);
  return protocol === "https:" && !isLocalHost(hostname) && !isLocalHost(rpId);
};

/**
 * What the person is asked before a ceremony they did not start themselves, or
 * before the first one an environment says they started for a site.
 */
export interface PasskeyPrompt {
  readonly environmentLabel: string;
  readonly threadTitle: string;
  readonly rpId: string;
  readonly ceremony: LaptopPasskeyRequest["ceremony"];
  /** An agent the profile lets use passkeys, a page nobody holds, or the person driving the tab. */
  readonly requester: LaptopPasskeyRequest["requester"];
}

export interface LaptopPasskeysOptions {
  /** What this platform and build allow (`laptopPasskeyStatus`), read at launch. */
  readonly status: TempoLaptopPasskeyStatus;
  /** Whether macOS passkeys load in this process; run once, when `status` allows them. */
  readonly probe: () => Promise<boolean>;
  /** False while the person has turned passkey requests off in Laptop tools settings. */
  readonly enabled: () => boolean;
  readonly backend: PasskeyBackend;
  /** The native handle of the window the system sheet attaches to, readied for it; undefined without one. */
  readonly sheetWindow: (request: LaptopPasskeyRequest) => Promise<Buffer | undefined>;
  /** Asks the person before a ceremony they did not start; false on Deny, or when `signal` aborts. */
  readonly confirm: (prompt: PasskeyPrompt, signal: AbortSignal) => Promise<boolean>;
  readonly onChange: () => void;
}

interface Active {
  readonly key: string;
  readonly controller: AbortController;
  readonly view: DesktopPasskeyRequestState;
}

const requestKey = (environmentId: EnvironmentId, requestId: string) =>
  `${environmentId}\u0000${requestId}`;

/** A site's key for one environment's requests; apart from thread keys. */
const siteKey = (environmentId: EnvironmentId, rpId: string) =>
  `${environmentId}\u0000site\u0000${rpId}`;

/**
 * How long a Deny keeps a thread's agent and unheld-page requests, or a site's
 * first sign-in from an environment, from asking again.
 */
export const PASSKEY_DENIED_QUIET_MS = 60_000;
/** How long past its own timeout a native ceremony may stay unsettled before the next may start. */
const NATIVE_GRACE_MS = 5_000;

/**
 * Runs the passkey requests of every environment this desktop is connected
 * to, one at a time, like a browser: the system sheet is modal, and a second
 * request while one is open is refused.
 */
export class LaptopPasskeys {
  private readonly options: LaptopPasskeysOptions;
  /** Whether macOS passkeys loaded; null until the probe answers or when it never runs. */
  private loaded: boolean | null = null;
  private readonly probed: Promise<void>;
  private active: Active | null = null;
  /**
   * The native ceremony still open, even after its request gave up. It cannot
   * be dismissed from here; it closes itself when its timeout runs out.
   */
  private native: Promise<unknown> | null = null;
  /** Until when requests are refused without asking, by environment and thread or site. */
  private readonly deniedUntil = new Map<string, number>();
  /**
   * Sites whose sign-ins the person confirmed once from an environment, until
   * the app quits. Later requests the environment says they started go
   * straight to the system sheet.
   */
  private readonly confirmedSites = new Set<string>();

  constructor(options: LaptopPasskeysOptions) {
    this.options = options;
    this.probed =
      options.status === "available"
        ? Promise.resolve()
            .then(() => options.probe())
            .catch(() => false)
            .then((loaded) => {
              this.loaded = loaded;
              if (!loaded) options.onChange();
            })
        : Promise.resolve();
  }

  /** What this Mac can do now. Anything but `available` sends environments to saved passkeys. */
  status(): TempoLaptopPasskeyStatus {
    if (this.options.status !== "available") return this.options.status;
    if (!this.options.enabled()) return "off";
    return this.loaded === false ? "failed" : "available";
  }

  state(): DesktopPasskeysState {
    return {
      status: this.status(),
      pending: this.active === null ? [] : [this.active.view],
    };
  }

  async handle(input: {
    readonly environmentId: EnvironmentId;
    readonly environmentLabel: string;
    readonly requestId: string;
    readonly request: LaptopPasskeyRequest;
  }): Promise<LaptopToolsOutcome> {
    const outcome = (result: LaptopPasskeyResult): LaptopToolsOutcome => ({
      _tag: "passkey",
      result,
    });
    const { request } = input;
    await this.probed;
    const status = this.status();
    if (status !== "available") return outcome({ _tag: "unavailable", status });
    if (!isLaptopOrigin(request.origin, request.rpId)) return outcome(refused("SecurityError"));
    if (this.active !== null || this.native !== null) return outcome(refused());
    const person = request.requester === "person";
    const site = siteKey(input.environmentId, request.rpId);
    const ask = !person || !this.confirmedSites.has(site);
    // A person's Deny quiets that site, so it does not hold back their other threads.
    const quietKey = person ? site : requestKey(input.environmentId, request.threadId);
    if (ask && this.quiet(quietKey)) return outcome(refused());
    const deadline = Date.now() + request.timeoutMs;
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    this.active = {
      key: requestKey(input.environmentId, input.requestId),
      controller,
      view: {
        key: requestKey(input.environmentId, input.requestId),
        environmentLabel: input.environmentLabel,
        threadTitle: request.threadTitle,
        rpId: request.rpId,
        ceremony: request.ceremony,
        requester: request.requester,
      },
    };
    this.options.onChange();
    try {
      if (ask) {
        const allowed = await this.options.confirm(
          {
            environmentLabel: input.environmentLabel,
            threadTitle: request.threadTitle,
            rpId: request.rpId,
            ceremony: request.ceremony,
            requester: request.requester,
          },
          controller.signal,
        );
        if (!allowed) {
          // A Deny quiets the thread (or site) for a while, so a retry cannot keep asking.
          if (!controller.signal.aborted) {
            this.deniedUntil.set(quietKey, Date.now() + PASSKEY_DENIED_QUIET_MS);
          }
          return outcome(refused());
        }
        if (person) this.confirmedSites.add(site);
      }
      if (controller.signal.aborted)
        return outcome(refused(timedOut ? "NotAllowedError" : "AbortError"));
      const nativeWindowHandle = await this.options.sheetWindow(request);
      if (nativeWindowHandle === undefined) return outcome(refused());
      const options = decodePasskeyOptions(request.publicKey);
      const context = { origin: request.origin, nativeWindowHandle };
      // The sheet gets the time this request has left, whatever the page asked
      // for, so the native layer closes it when this request gives up.
      const timeout = Math.max(1, deadline - Date.now());
      // The relying party the environment checked against the origin, whatever the page sent.
      const ceremony =
        request.ceremony === "create"
          ? this.options.backend.create(
              {
                ...withRelyingParty(options, request.rpId),
                timeout,
              } as PublicKeyCredentialCreationOptions,
              context,
            )
          : this.options.backend.get(
              {
                ...asRecord(options),
                rpId: request.rpId,
                timeout,
              } as PublicKeyCredentialRequestOptions,
              context,
            );
      const native = ceremony.catch((): PasskeyCeremonyResult => ({
        success: false,
        error: "NotAllowedError",
      }));
      this.holdNative(native, timeout + NATIVE_GRACE_MS);
      const aborted = new Promise<"aborted">((resolve) => {
        if (controller.signal.aborted) resolve("aborted");
        controller.signal.addEventListener("abort", () => resolve("aborted"), { once: true });
      });
      const settled = await Promise.race([native, aborted]);
      // A ceremony that ran out of time fails as WebAuthn's own timeouts do.
      if (settled !== "aborted") return outcome(resultOf(settled));
      return outcome(refused(timedOut ? "NotAllowedError" : "AbortError"));
    } finally {
      clearTimeout(timer);
      this.active = null;
      this.options.onChange();
    }
  }

  /** The environment stopped waiting: the page aborted, navigated away, or timed out. */
  cancel(environmentId: EnvironmentId, requestId: string): void {
    if (this.active?.key === requestKey(environmentId, requestId)) this.active.controller.abort();
  }

  private quiet(key: string): boolean {
    const until = this.deniedUntil.get(key);
    if (until === undefined) return false;
    if (until > Date.now()) return true;
    this.deniedUntil.delete(key);
    return false;
  }

  /**
   * Keeps the next ceremony waiting until this one settles, or until its own
   * timeout and a grace period have passed if the native layer never settles
   * it. Registered before anyone awaits `native`, so it is released first.
   */
  private holdNative(native: Promise<unknown>, atMostMs: number): void {
    const release = () => {
      clearTimeout(timer);
      if (this.native === native) this.native = null;
    };
    const timer = setTimeout(release, atMostMs);
    this.native = native;
    void native.then(release);
  }
}

const asRecord = (value: unknown): object =>
  typeof value === "object" && value !== null ? value : {};

const withRelyingParty = (options: unknown, rpId: string) => {
  const record = asRecord(options);
  const rp = "rp" in record && typeof record.rp === "object" && record.rp !== null ? record.rp : {};
  return { ...record, rp: { ...rp, id: rpId } };
};
