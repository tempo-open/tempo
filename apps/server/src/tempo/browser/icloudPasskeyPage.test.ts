// @effect-diagnostics nodeBuiltinImport:off - Runs the page script in its own realm, as a page would.
import * as NodeVM from "node:vm";

import { describe, expect, it } from "@effect/vitest";

import {
  PASSKEY_ANSWER,
  parsePageMessage,
  passkeyPageScript,
  preparePasskeyRequest,
} from "./icloudPasskeyPage.ts";

const b64u = (bytes: ReadonlyArray<number>) => Buffer.from(bytes).toString("base64url");
// Buffers from the page realm are not `instanceof` this realm's classes.
const bytesOf = (buffer: unknown) =>
  typeof buffer === "object" && buffer !== null
    ? [...new Uint8Array(buffer as ArrayBuffer)]
    : buffer;

const created = {
  credentialId: b64u([1, 2, 3]),
  clientDataJSON: b64u([4]),
  attestationObject: b64u([10]),
  authData: b64u([11]),
  publicKey: b64u([12]),
  publicKeyAlgorithm: -7,
  transports: ["internal", "hybrid"],
  extensions: { credProps: { rk: true } },
};

const asserted = {
  credentialId: b64u([1, 2, 3]),
  clientDataJSON: b64u([4]),
  authenticatorData: b64u([5]),
  signature: b64u([6, 7]),
  userHandle: b64u([8]),
  extensions: { prf: { results: { first: b64u([9]) } } },
};

/**
 * A page realm with stand-ins for the WebAuthn classes. Like Chromium's, their
 * getters only work on objects the browser made itself.
 */
const page = (options: { readonly top?: boolean } = {}) => {
  const sent: Array<Record<string, unknown>> = [];
  const nativeCalls: Array<string> = [];
  const sandbox: Record<string, unknown> = {
    DOMException,
    btoa,
    atob,
    AbortController,
    __tempoPasskeyRequest: (payload: string) => {
      sent.push(JSON.parse(payload) as Record<string, unknown>);
    },
    __native: (kind: string) => {
      nativeCalls.push(kind);
      return Promise.resolve(`native-${kind}`);
    },
  };
  sandbox.window = sandbox;
  sandbox.top = options.top === false ? {} : sandbox;
  const context = NodeVM.createContext(sandbox);
  NodeVM.runInContext(
    `
    const illegal = () => { throw new TypeError("Illegal invocation"); };
    class CredentialsContainer {
      create(options) { return __native("create"); }
      get(options) { return __native("get"); }
    }
    class PublicKeyCredential { get id() { return illegal(); } get response() { return illegal(); } }
    PublicKeyCredential.getClientCapabilities = async () => ({ conditionalGet: true });
    class AuthenticatorAttestationResponse { get clientDataJSON() { return illegal(); } }
    class AuthenticatorAssertionResponse { get signature() { return illegal(); } }
    window.CredentialsContainer = CredentialsContainer;
    window.PublicKeyCredential = PublicKeyCredential;
    window.AuthenticatorAttestationResponse = AuthenticatorAttestationResponse;
    window.AuthenticatorAssertionResponse = AuthenticatorAssertionResponse;
    window.navigator = { credentials: new CredentialsContainer() };
    `,
    context,
  );
  NodeVM.runInContext(passkeyPageScript(), context);
  const run = <A>(code: string) => NodeVM.runInContext(code, context) as A;
  const answer = (id: number, value: unknown) =>
    (sandbox[PASSKEY_ANSWER] as (id: number, value: unknown) => void)(id, value);
  return { sandbox, sent, nativeCalls, run, answer };
};

const CREATE = `navigator.credentials.create({ publicKey: {
  challenge: new Uint8Array([1, 2, 3]).buffer,
  rp: { name: "GitHub" },
  user: { id: new Uint8Array([9, 9]), name: "octocat", displayName: "The Octocat" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
  excludeCredentials: [{ type: "public-key", id: new Uint8Array([7]) }],
  timeout: 60000,
  hints: undefined,
} })`;

describe("passkeyPageScript", () => {
  it("sends the page's options with binary members as base64url", async () => {
    const tab = page();
    const pending = tab.run<Promise<unknown>>(CREATE);
    expect(tab.sent).toEqual([
      {
        id: 1,
        kind: "create",
        publicKey: {
          challenge: { $b64u: b64u([1, 2, 3]) },
          rp: { name: "GitHub" },
          user: { id: { $b64u: b64u([9, 9]) }, name: "octocat", displayName: "The Octocat" },
          pubKeyCredParams: [{ type: "public-key", alg: -7 }],
          excludeCredentials: [{ type: "public-key", id: { $b64u: b64u([7]) } }],
          timeout: 60000,
        },
      },
    ]);
    // The page cannot replace the answer function and intercept what the server sends.
    tab.run(`window.${PASSKEY_ANSWER} = () => {}`);
    tab.answer(1, { success: true, data: created });
    const credential = (await pending) as {
      readonly id: string;
      readonly rawId: unknown;
      readonly type: string;
      readonly response: {
        readonly clientDataJSON: unknown;
        readonly attestationObject: unknown;
        readonly getTransports: () => unknown;
        readonly getAuthenticatorData: () => unknown;
        readonly getPublicKey: () => unknown;
        readonly getPublicKeyAlgorithm: () => unknown;
      };
      readonly toJSON: () => unknown;
      readonly getClientExtensionResults: () => unknown;
    };
    expect(Object.getPrototypeOf(credential)).toBe(tab.run("PublicKeyCredential.prototype"));
    expect(Object.getPrototypeOf(credential.response)).toBe(
      tab.run("AuthenticatorAttestationResponse.prototype"),
    );
    expect(credential.id).toBe(created.credentialId);
    expect(bytesOf(credential.rawId)).toEqual([1, 2, 3]);
    expect(credential.type).toBe("public-key");
    expect(bytesOf(credential.response.clientDataJSON)).toEqual([4]);
    expect(bytesOf(credential.response.attestationObject)).toEqual([10]);
    expect(credential.response.getTransports()).toEqual(["internal", "hybrid"]);
    expect(bytesOf(credential.response.getAuthenticatorData())).toEqual([11]);
    expect(bytesOf(credential.response.getPublicKey())).toEqual([12]);
    expect(credential.response.getPublicKeyAlgorithm()).toBe(-7);
    expect(credential.getClientExtensionResults()).toEqual({ credProps: { rk: true } });
    expect(credential.toJSON()).toEqual({
      id: created.credentialId,
      rawId: created.credentialId,
      type: "public-key",
      response: {
        clientDataJSON: created.clientDataJSON,
        attestationObject: created.attestationObject,
        authenticatorData: created.authData,
        transports: ["internal", "hybrid"],
        publicKeyAlgorithm: -7,
        publicKey: created.publicKey,
      },
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it("turns a sign-in answer into an assertion with its user handle and PRF output", async () => {
    const tab = page();
    const pending = tab.run<Promise<unknown>>(
      `navigator.credentials.get({ publicKey: { challenge: new Uint8Array([5]), rpId: "github.com" } })`,
    );
    expect(tab.sent[0]).toEqual({
      id: 1,
      kind: "get",
      publicKey: { challenge: { $b64u: b64u([5]) }, rpId: "github.com" },
    });
    tab.answer(1, { success: true, data: asserted });
    const credential = (await pending) as {
      readonly response: Record<string, unknown>;
      readonly getClientExtensionResults: () => { prf: { results: { first: ArrayBuffer } } };
      readonly toJSON: () => unknown;
    };
    expect(Object.getPrototypeOf(credential.response)).toBe(
      tab.run("AuthenticatorAssertionResponse.prototype"),
    );
    expect(bytesOf(credential.response.signature)).toEqual([6, 7]);
    expect(bytesOf(credential.response.userHandle)).toEqual([8]);
    expect(bytesOf(credential.getClientExtensionResults().prf.results.first)).toEqual([9]);
    expect(credential.toJSON()).toMatchObject({
      response: { signature: asserted.signature, userHandle: asserted.userHandle },
      clientExtensionResults: { prf: { results: { first: b64u([9]) } } },
    });
  });

  it("rejects as the browser would, and hands fallbacks to the browser's own passkeys", async () => {
    const tab = page();
    const refused = tab.run<Promise<unknown>>(CREATE);
    tab.answer(1, { success: false, error: "InvalidStateError" });
    await expect(refused).rejects.toMatchObject({ name: "InvalidStateError" });

    const odd = tab.run<Promise<unknown>>(CREATE);
    tab.answer(2, { success: false, error: "SomethingElse" });
    await expect(odd).rejects.toMatchObject({ name: "NotAllowedError" });

    const fallback = tab.run<Promise<unknown>>(CREATE);
    tab.answer(3, { fallback: true });
    await expect(fallback).resolves.toBe("native-create");
    expect(tab.nativeCalls).toEqual(["create"]);
  });

  it("leaves autofill requests and child frames to the browser", async () => {
    const tab = page();
    await expect(
      tab.run(
        `navigator.credentials.get({ mediation: "conditional", publicKey: { challenge: new Uint8Array([1]) } })`,
      ),
    ).resolves.toBe("native-get");
    expect(tab.sent).toEqual([]);

    const frame = page({ top: false });
    await expect(frame.run(CREATE)).resolves.toBe("native-create");
    expect(frame.sent).toEqual([]);
  });

  it("cancels on the server when the page aborts", async () => {
    const tab = page();
    const pending = tab.run<Promise<unknown>>(`(() => {
      const controller = new AbortController();
      const request = navigator.credentials.get({ signal: controller.signal, publicKey: { challenge: new Uint8Array([1]) } });
      controller.abort();
      return request;
    })()`);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(tab.sent.map((message) => message.kind)).toEqual(["get", "cancel"]);
    // A late answer for the aborted request goes nowhere.
    tab.answer(1, { success: true, data: asserted });
  });

  it("rejects options too large for the server to read instead of waiting forever", async () => {
    const tab = page();
    await expect(
      tab.run(`navigator.credentials.create({ publicKey: {
        challenge: new Uint8Array([1]),
        excludeCredentials: Array.from({ length: 2000 }, () => ({ type: "public-key", id: new Uint8Array(32) })),
      } })`),
    ).rejects.toMatchObject({ name: "TypeError" });
    expect(tab.sent).toEqual([]);
  });

  it("reports a platform authenticator", async () => {
    const tab = page();
    await expect(
      tab.run("PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()"),
    ).resolves.toBe(true);
    await expect(tab.run("PublicKeyCredential.getClientCapabilities()")).resolves.toEqual({
      conditionalGet: true,
      hybridTransport: true,
      passkeyPlatformAuthenticator: true,
      userVerifyingPlatformAuthenticator: true,
    });
  });
});

describe("parsePageMessage", () => {
  it("reads requests and cancels and drops anything else", () => {
    expect(parsePageMessage(JSON.stringify({ id: 3, kind: "get", publicKey: { a: 1 } }))).toEqual({
      id: 3,
      kind: "get",
      publicKey: { a: 1 },
    });
    expect(parsePageMessage(JSON.stringify({ id: 3, kind: "cancel" }))).toEqual({
      id: 3,
      kind: "cancel",
    });
    expect(parsePageMessage("not json")).toBeNull();
    expect(parsePageMessage(JSON.stringify({ id: 0, kind: "get" }))).toBeNull();
    expect(parsePageMessage(JSON.stringify({ id: 1, kind: "delete" }))).toBeNull();
    expect(parsePageMessage(" ".repeat(70_000))).toBeNull();
  });
});

describe("preparePasskeyRequest", () => {
  const prepare = (origin: string, publicKey: unknown, kind: "create" | "get" = "get") =>
    preparePasskeyRequest({ kind, origin, publicKey });

  it("takes the relying party from the options or the origin's host", () => {
    expect(prepare("https://github.com", {})).toEqual({ rpId: "github.com", timeoutMs: 300_000 });
    expect(prepare("https://login.github.com", { rpId: "github.com", timeout: 1_000 })).toEqual({
      rpId: "github.com",
      timeoutMs: 15_000,
    });
    expect(
      prepare("https://login.github.com", { rp: { id: "github.com" }, timeout: 120_000 }, "create"),
    ).toEqual({ rpId: "github.com", timeoutMs: 120_000 });
    expect(prepare("http://localhost:3000", { timeout: 9e9 })).toEqual({
      rpId: "localhost",
      timeoutMs: 600_000,
    });
  });

  it("refuses insecure origins and relying parties outside the origin", () => {
    expect(prepare("http://example.com", {})).toEqual({ error: "SecurityError" });
    expect(prepare("https://127.0.0.1", {})).toEqual({ error: "SecurityError" });
    expect(prepare("https://[::1]", {})).toEqual({ error: "SecurityError" });
    expect(prepare("null", {})).toEqual({ error: "SecurityError" });
    expect(prepare("https://github.com", { rpId: "gitlab.com" })).toEqual({
      error: "SecurityError",
    });
    expect(prepare("https://evilgithub.com", { rpId: "github.com" })).toEqual({
      error: "SecurityError",
    });
    expect(prepare("https://github.com", { rpId: "com" })).toEqual({ error: "SecurityError" });
    expect(prepare("https://github.com", { rpId: 7 })).toEqual({ error: "TypeError" });
    expect(prepare("https://github.com", "options")).toEqual({ error: "TypeError" });
  });
});
