/**
 * The page half of iCloud Keychain passkeys in server tabs: the page script, its messages, and the
 * server's checks on them. The page may lie about everything it sends, so the server reads the
 * origin from the browser and takes only the WebAuthn options from the page; the laptop builds
 * `clientDataJSON` from that origin, since macOS AuthenticationServices signs its hash.
 */
import {
  TEMPO_PASSKEY_MAX_OPTIONS_CHARS,
  type TempoPasskeyAssertedData,
  type TempoPasskeyCeremonyKind,
  type TempoPasskeyCreatedData,
  type TempoPasskeyErrorName,
} from "@t3tools/contracts";

/** The CDP binding the page script calls with each request. */
export const PASSKEY_BINDING = "__tempoPasskeyRequest";
/** The page function the server calls with each answer; the page cannot replace it. */
export const PASSKEY_ANSWER = "__tempoPasskeyAnswer";

/** What the page script sends over the binding. */
export type PagePasskeyMessage =
  | { readonly id: number; readonly kind: TempoPasskeyCeremonyKind; readonly publicKey: unknown }
  | { readonly id: number; readonly kind: "cancel" };

/** What the page script is answered with. `fallback` hands the request to the browser's own passkeys. */
export type PagePasskeyAnswer =
  | { readonly success: true; readonly data: TempoPasskeyCreatedData | TempoPasskeyAssertedData }
  | { readonly success: false; readonly error: TempoPasskeyErrorName }
  | { readonly fallback: true };

export const refusePasskey = (
  error: TempoPasskeyErrorName = "NotAllowedError",
): PagePasskeyAnswer => ({
  success: false,
  error,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Reads one binding payload; anything else the page sends is dropped. */
export const parsePageMessage = (payload: string): PagePasskeyMessage | null => {
  // The options plus the envelope; a page cannot make the server parse more.
  if (payload.length > TEMPO_PASSKEY_MAX_OPTIONS_CHARS + 256) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  const message = asRecord(parsed);
  const id = message?.id;
  if (message === null || typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    return null;
  }
  if (message.kind === "cancel") return { id, kind: "cancel" };
  if (message.kind !== "create" && message.kind !== "get") return null;
  return { id, kind: message.kind, publicKey: message.publicKey };
};

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u;

/**
 * Secure contexts only: https, or http on the environment's own loopback,
 * as Chromium allows. WebAuthn refuses IP addresses as relying parties.
 */
const hostOf = (origin: string): string | null => {
  if (!URL.canParse(origin)) return null;
  const url = new URL(origin);
  const host = url.hostname;
  if (host.startsWith("[") || IPV4.test(host)) return null;
  if (url.protocol === "https:") return host;
  return url.protocol === "http:" && host === "localhost" ? host : null;
};

const MIN_TIMEOUT_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

export interface PreparedPasskeyRequest {
  readonly rpId: string;
  /** How long the person has to answer the sheet, from the page's own `timeout`. */
  readonly timeoutMs: number;
}

/**
 * Checks a ceremony against the origin that asked for it, as a browser does before any passkey
 * UI: a secure origin, and a relying party that is the origin's host or a parent domain of it.
 * Whether that parent is a public suffix (`github.io`) is checked again on the Mac, which has the
 * public suffix list; here a relying party must at least have a dot.
 */
export const preparePasskeyRequest = (input: {
  readonly kind: TempoPasskeyCeremonyKind;
  readonly origin: string;
  readonly publicKey: unknown;
}): PreparedPasskeyRequest | { readonly error: TempoPasskeyErrorName } => {
  const host = hostOf(input.origin);
  if (host === null) return { error: "SecurityError" };
  const options = asRecord(input.publicKey);
  if (options === null) return { error: "TypeError" };
  if (JSON.stringify(options).length > TEMPO_PASSKEY_MAX_OPTIONS_CHARS)
    return { error: "TypeError" };
  const requested = input.kind === "create" ? asRecord(options.rp)?.id : options.rpId;
  if (requested !== undefined && typeof requested !== "string") return { error: "TypeError" };
  const rpId = requested ?? host;
  const withinOrigin = rpId === host || host.endsWith(`.${rpId}`);
  if (!withinOrigin || (rpId !== "localhost" && !rpId.includes("."))) {
    return { error: "SecurityError" };
  }
  const timeout = options.timeout;
  const timeoutMs =
    typeof timeout === "number" && Number.isFinite(timeout) && timeout > 0
      ? Math.min(Math.max(timeout, MIN_TIMEOUT_MS), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;
  return { rpId, timeoutMs };
};

/**
 * Takes over `navigator.credentials` in a top-level page: modal create and get go to the server;
 * autofill requests and subframes stay with the browser's saved passkeys. Natives are captured
 * before page script runs. Results borrow native prototypes for `instanceof`, with own properties
 * over getters that need real objects. Mirrors apps/desktop/src/preview/PasskeyBridge.ts.
 */
export const passkeyPageScript = (): string => `(() => {
  if (window.top !== window) return;
  if (typeof CredentialsContainer === "undefined" || typeof PublicKeyCredential === "undefined") return;
  const send = window[${JSON.stringify(PASSKEY_BINDING)}];
  if (typeof send !== "function") return;
  try { delete window[${JSON.stringify(PASSKEY_BINDING)}]; } catch {}
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const toAscii = btoa;
  const fromAscii = atob;
  const fromCharCode = String.fromCharCode;
  const defineProperty = Object.defineProperty;
  const create = Object.create;
  const entries = Object.entries;
  const isArray = Array.isArray;
  const isView = ArrayBuffer.isView;
  const apply = Reflect.apply;
  const NativeDOMException = DOMException;
  const NativeTypeError = TypeError;
  const NOT_ALLOWED = "The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/#sctn-privacy-considerations-client.";
  const NAMES = ["AbortError", "InvalidStateError", "NotAllowedError", "NotSupportedError", "SecurityError"];
  const pending = new Map();
  let nextId = 0;

  const toBase64Url = (bytes) => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += apply(fromCharCode, null, bytes.subarray(index, index + 0x8000));
    }
    return toAscii(binary).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  };
  const fromBase64Url = (value) => {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const binary = fromAscii(base64 + "===".slice((base64.length + 3) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  };
  // Binary members travel as {"$b64u": ...}; functions and undefined drop out, as Chromium ignores them.
  const encode = (value, depth) => {
    if (depth > 16) return undefined;
    if (value instanceof ArrayBuffer) return { $b64u: toBase64Url(new Uint8Array(value)) };
    if (isView(value)) return { $b64u: toBase64Url(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
    if (isArray(value)) return value.map((item) => { const encoded = encode(item, depth + 1); return encoded === undefined ? null : encoded; });
    if (typeof value === "object" && value !== null) {
      const out = {};
      for (const [key, member] of entries(value)) {
        const encoded = encode(member, depth + 1);
        if (encoded !== undefined) out[key] = encoded;
      }
      return out;
    }
    return typeof value === "function" ? undefined : value;
  };
  const ceremonyError = (name) =>
    name === "TypeError"
      ? new NativeTypeError("The passkey request options are invalid.")
      : new NativeDOMException(NOT_ALLOWED, NAMES.includes(name) ? name : "NotAllowedError");
  const abortReason = (signal) => signal.reason !== undefined ? signal.reason : new NativeDOMException("The operation was aborted.", "AbortError");
  const withValues = (target, values) => {
    for (const [key, value] of entries(values)) defineProperty(target, key, { value, enumerable: true, configurable: true });
    return target;
  };
  const prfOutputs = (prf) => {
    const out = {};
    if (prf.enabled !== undefined) out.enabled = prf.enabled;
    if (prf.results && prf.results.first !== undefined) {
      out.results = { first: fromBase64Url(prf.results.first) };
      if (prf.results.second !== undefined) out.results.second = fromBase64Url(prf.results.second);
    }
    return out;
  };
  const extensionJson = (results) => parse(stringify(results, (_key, value) => value instanceof ArrayBuffer ? toBase64Url(new Uint8Array(value)) : value));
  const credential = (id, response, responseJson, extensionResults) =>
    withValues(create(PublicKeyCredential.prototype), {
      id,
      rawId: fromBase64Url(id),
      type: "public-key",
      authenticatorAttachment: null,
      response,
      getClientExtensionResults: () => extensionResults,
      toJSON: () => ({ id, rawId: id, type: "public-key", response: responseJson, clientExtensionResults: extensionJson(extensionResults) }),
    });
  const fromCreated = (data) => {
    const transports = [...data.transports];
    const publicKey = data.publicKey.length > 0 ? data.publicKey : null;
    const extensions = data.extensions || {};
    const results = {};
    if (extensions.credProps) results.credProps = { ...extensions.credProps };
    if (extensions.prf) results.prf = prfOutputs(extensions.prf);
    if (extensions.largeBlob) results.largeBlob = { ...extensions.largeBlob };
    const response = withValues(create(AuthenticatorAttestationResponse.prototype), {
      clientDataJSON: fromBase64Url(data.clientDataJSON),
      attestationObject: fromBase64Url(data.attestationObject),
      getTransports: () => [...transports],
      getAuthenticatorData: () => fromBase64Url(data.authData),
      getPublicKey: () => publicKey === null ? null : fromBase64Url(publicKey),
      getPublicKeyAlgorithm: () => data.publicKeyAlgorithm,
    });
    const json = { clientDataJSON: data.clientDataJSON, attestationObject: data.attestationObject, authenticatorData: data.authData, transports, publicKeyAlgorithm: data.publicKeyAlgorithm };
    if (publicKey !== null) json.publicKey = publicKey;
    return credential(data.credentialId, response, json, results);
  };
  const fromAsserted = (data) => {
    const userHandle = data.userHandle.length > 0 ? data.userHandle : null;
    const extensions = data.extensions || {};
    const results = {};
    if (extensions.prf) results.prf = prfOutputs(extensions.prf);
    if (extensions.largeBlob) {
      results.largeBlob = {};
      if (extensions.largeBlob.blob !== undefined) results.largeBlob.blob = fromBase64Url(extensions.largeBlob.blob);
      if (extensions.largeBlob.written !== undefined) results.largeBlob.written = extensions.largeBlob.written;
    }
    const response = withValues(create(AuthenticatorAssertionResponse.prototype), {
      clientDataJSON: fromBase64Url(data.clientDataJSON),
      authenticatorData: fromBase64Url(data.authenticatorData),
      signature: fromBase64Url(data.signature),
      userHandle: userHandle === null ? null : fromBase64Url(userHandle),
    });
    const json = { clientDataJSON: data.clientDataJSON, authenticatorData: data.authenticatorData, signature: data.signature };
    if (userHandle !== null) json.userHandle = userHandle;
    return credential(data.credentialId, response, json, results);
  };

  defineProperty(window, ${JSON.stringify(PASSKEY_ANSWER)}, {
    value: (id, answer) => {
      const settle = pending.get(id);
      if (settle === undefined) return;
      pending.delete(id);
      settle(answer);
    },
    configurable: false,
    writable: false,
    enumerable: false,
  });

  const run = (kind, publicKey, signal, native) => {
    if (signal && signal.aborted) return Promise.reject(abortReason(signal));
    const id = ++nextId;
    let message;
    try {
      message = stringify({ id, kind, publicKey: encode(publicKey, 0) });
    } catch {
      return Promise.reject(ceremonyError("TypeError"));
    }
    // The server reads nothing larger, so such a request fails here rather than wait forever.
    if (message.length > ${TEMPO_PASSKEY_MAX_OPTIONS_CHARS}) return Promise.reject(ceremonyError("TypeError"));
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        pending.delete(id);
        try { send(stringify({ id, kind: "cancel" })); } catch {}
        reject(abortReason(signal));
      };
      pending.set(id, (answer) => {
        if (signal) signal.removeEventListener("abort", onAbort);
        if (answer && answer.fallback === true) {
          native().then(resolve, reject);
          return;
        }
        if (!answer || answer.success !== true) {
          reject(ceremonyError(answer && answer.error));
          return;
        }
        try {
          resolve(answer.data.attestationObject !== undefined ? fromCreated(answer.data) : fromAsserted(answer.data));
        } catch {
          reject(ceremonyError("NotAllowedError"));
        }
      });
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      try {
        send(message);
      } catch {
        pending.delete(id);
        reject(ceremonyError("NotAllowedError"));
      }
    });
  };

  const container = CredentialsContainer.prototype;
  const nativeCreate = container.create;
  const nativeGet = container.get;
  const define = (target, key, value) => defineProperty(target, key, { value, configurable: true, writable: true });
  define(container, "create", function create(options) {
    const self = this;
    return options && options.publicKey && options.mediation !== "conditional"
      ? run("create", options.publicKey, options.signal, () => apply(nativeCreate, self, [options]))
      : apply(nativeCreate, this, [options]);
  });
  define(container, "get", function get(options) {
    const self = this;
    return options && options.publicKey && options.mediation !== "conditional"
      ? run("get", options.publicKey, options.signal, () => apply(nativeGet, self, [options]))
      : apply(nativeGet, this, [options]);
  });
  define(PublicKeyCredential, "isUserVerifyingPlatformAuthenticatorAvailable", async () => true);
  const nativeCapabilities = PublicKeyCredential.getClientCapabilities;
  if (typeof nativeCapabilities === "function") {
    define(PublicKeyCredential, "getClientCapabilities", async () => ({
      ...(await apply(nativeCapabilities, PublicKeyCredential, [])),
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
    }));
  }
})();`;
