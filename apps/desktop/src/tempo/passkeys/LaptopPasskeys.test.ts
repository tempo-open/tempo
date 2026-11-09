import { describe, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type LaptopPasskeyRequest,
  LaptopToolsOutcome,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { vi } from "vite-plus/test";

import type { PasskeyBackend, PasskeyCeremonyContext } from "../../preview/PasskeyBackend.ts";
import type { PasskeyCeremonyResult } from "../../preview/PasskeyBridge.ts";
import {
  decodePasskeyOptions,
  LaptopPasskeys,
  laptopPasskeyStatus,
  PASSKEY_DENIED_QUIET_MS,
  type PasskeyPrompt,
} from "./LaptopPasskeys.ts";

const environmentId = EnvironmentId.make("mini");
const windowHandle = Buffer.from([1, 2, 3, 4]);

const createOptions = {
  challenge: { $b64u: Buffer.from([1, 2, 3]).toString("base64url") },
  rp: { name: "GitHub", id: "evil.example" },
  user: { id: { $b64u: "CQk" }, name: "octocat", displayName: "The Octocat" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
};

const request = (overrides: Partial<LaptopPasskeyRequest> = {}): LaptopPasskeyRequest => ({
  _tag: "passkey",
  ceremony: "create",
  origin: "https://login.github.com",
  rpId: "github.com",
  publicKey: createOptions,
  threadId: ThreadId.make("thread-1"),
  threadTitle: "Sign in to GitHub",
  requester: "person",
  timeoutMs: 60_000,
  ...overrides,
});

const created: PasskeyCeremonyResult = {
  success: true,
  data: {
    credentialId: "AQID",
    clientDataJSON: "BA",
    attestationObject: "Cg",
    authData: "Cw",
    publicKey: "DA",
    publicKeyAlgorithm: -7,
    transports: ["internal"],
    extensions: { credProps: { rk: true } },
  },
};

const asserted: PasskeyCeremonyResult = {
  success: true,
  data: {
    credentialId: "AQID",
    clientDataJSON: "BA",
    authenticatorData: "BQ",
    signature: "Bgc",
    userHandle: "CA",
  },
};

/**
 * A result as electron-webauthn really builds it: its types promise strings,
 * but members it did not set are present and undefined.
 */
const fromNative = (result: unknown) => result as PasskeyCeremonyResult;

interface Call {
  readonly kind: "create" | "get";
  readonly publicKey: unknown;
  readonly context: PasskeyCeremonyContext;
}

/** Stands in for macOS AuthenticationServices; each ceremony answers when the test says so. */
const fakeBackend = () => {
  const calls: Call[] = [];
  const pending: Array<(result: PasskeyCeremonyResult) => void> = [];
  const ceremony =
    (kind: Call["kind"]) => (publicKey: unknown, context: PasskeyCeremonyContext) => {
      calls.push({ kind, publicKey, context });
      return new Promise<PasskeyCeremonyResult>((resolve) => pending.push(resolve));
    };
  const backend: PasskeyBackend = { create: ceremony("create"), get: ceremony("get") };
  return {
    backend,
    calls,
    answer: (result: PasskeyCeremonyResult) => pending.shift()?.(result),
  };
};

const makePasskeys = (
  options: {
    readonly status?: Parameters<typeof laptopPasskeyStatus>[0];
    readonly confirm?: (prompt: PasskeyPrompt) => Promise<boolean>;
    readonly probe?: () => Promise<boolean>;
    readonly enabled?: () => boolean;
  } = {},
) => {
  const native = fakeBackend();
  const prompts: PasskeyPrompt[] = [];
  const onChange = vi.fn();
  const passkeys = new LaptopPasskeys({
    status: laptopPasskeyStatus(
      options.status ?? { platform: "darwin", systemVersion: "26.0.0", entitled: true },
    ),
    probe: options.probe ?? (async () => true),
    enabled: options.enabled ?? (() => true),
    backend: native.backend,
    sheetWindow: async () => windowHandle,
    confirm: async (prompt) => {
      prompts.push(prompt);
      return options.confirm ? options.confirm(prompt) : true;
    },
    onChange,
  });
  const handle = (passkeyRequest: LaptopPasskeyRequest, requestId = "laptop-1") =>
    passkeys.handle({
      environmentId,
      environmentLabel: "mac-mini",
      requestId,
      request: passkeyRequest,
    });
  return { passkeys, native, prompts, onChange, handle };
};

/** What the desktop's IPC does with every answer before it reaches the environment. */
const encodeOutcome = Schema.encodeUnknownSync(LaptopToolsOutcome);
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise((resolve) => setImmediate(resolve));
const result = (outcome: LaptopToolsOutcome) =>
  outcome._tag === "passkey" ? outcome.result : null;

describe("laptopPasskeyStatus", () => {
  it("needs a Mac on 15 or later and a build signed with the entitlement", () => {
    expect(laptopPasskeyStatus({ platform: "win32", systemVersion: "10", entitled: true })).toBe(
      "not-mac",
    );
    expect(
      laptopPasskeyStatus({ platform: "darwin", systemVersion: "14.7.1", entitled: true }),
    ).toBe("unsupported-os");
    expect(laptopPasskeyStatus({ platform: "darwin", systemVersion: "15.0", entitled: true })).toBe(
      "available",
    );
    expect(
      laptopPasskeyStatus({ platform: "darwin", systemVersion: "27.0.0", entitled: false }),
    ).toBe("awaiting-entitlement");
  });
});

describe("decodePasskeyOptions", () => {
  it("turns tagged members back into ArrayBuffers and leaves the rest", () => {
    const decoded = decodePasskeyOptions({
      challenge: { $b64u: "AQID" },
      allowCredentials: [{ type: "public-key", id: { $b64u: "Bw" } }],
      odd: { $b64u: "AQ", extra: true },
      timeout: 5,
    }) as {
      challenge: ArrayBuffer;
      allowCredentials: Array<{ id: ArrayBuffer }>;
      odd: unknown;
      timeout: number;
    };
    expect(decoded.challenge).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(decoded.challenge)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(decoded.allowCredentials[0]!.id)]).toEqual([7]);
    expect(decoded.odd).toEqual({ $b64u: "AQ", extra: true });
    expect(decoded.timeout).toBe(5);
  });
});

describe("LaptopPasskeys", () => {
  it("creates a passkey for the checked relying party, in the page's origin, on the app window", async () => {
    const { native, handle, passkeys, onChange } = makePasskeys();
    const answer = handle(request());
    await settle();
    expect(passkeys.state().pending).toEqual([
      {
        key: expect.any(String),
        environmentLabel: "mac-mini",
        threadTitle: "Sign in to GitHub",
        rpId: "github.com",
        ceremony: "create",
        requester: "person",
      },
    ]);
    const [call] = native.calls;
    expect(call?.kind).toBe("create");
    expect(call?.context).toEqual({
      origin: "https://login.github.com",
      nativeWindowHandle: windowHandle,
    });
    const publicKey = call?.publicKey as PublicKeyCredentialCreationOptions;
    expect(publicKey.rp).toEqual({ name: "GitHub", id: "github.com" });
    expect([...new Uint8Array(publicKey.challenge as ArrayBuffer)]).toEqual([1, 2, 3]);
    expect([...new Uint8Array(publicKey.user.id as ArrayBuffer)]).toEqual([9, 9]);

    native.answer({
      ...created,
      data: { ...created.data, unexpected: "dropped" },
    } as PasskeyCeremonyResult);
    expect(result(await answer)).toEqual({ _tag: "created", data: created.data });
    expect(passkeys.state().pending).toEqual([]);
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("signs in with the relying party the environment checked, and maps refusals", async () => {
    const { native, handle } = makePasskeys();
    const signIn = handle(request({ ceremony: "get", publicKey: { rpId: "evil.example" } }));
    await settle();
    expect(native.calls[0]?.publicKey).toMatchObject({ rpId: "github.com" });
    native.answer(asserted);
    expect(result(await signIn)).toEqual({ _tag: "asserted", data: asserted.data });

    const excluded = handle(request(), "laptop-2");
    await settle();
    native.answer({ success: false, error: "InvalidStateError" });
    expect(result(await excluded)).toEqual({ _tag: "refused", error: "InvalidStateError" });

    const odd = handle(request(), "laptop-3");
    await settle();
    native.answer({ success: false, error: "UnknownError" });
    expect(result(await odd)).toEqual({ _tag: "refused", error: "NotAllowedError" });
  });

  it("says why it cannot run passkeys so the environment falls back", async () => {
    const { native, handle } = makePasskeys({
      status: { platform: "darwin", systemVersion: "26.0", entitled: false },
    });
    expect(result(await handle(request()))).toEqual({
      _tag: "unavailable",
      status: "awaiting-entitlement",
    });
    expect(native.calls).toEqual([]);

    // Entitled, but macOS passkeys did not load in this build.
    const broken = makePasskeys({ probe: async () => false });
    expect(result(await broken.handle(request()))).toEqual({
      _tag: "unavailable",
      status: "failed",
    });
    expect(broken.passkeys.state().status).toBe("failed");
    expect(broken.onChange).toHaveBeenCalled();
    expect(broken.native.calls).toEqual([]);

    // Turned off in Laptop tools settings, and back on.
    let enabled = false;
    const off = makePasskeys({ enabled: () => enabled });
    expect(result(await off.handle(request()))).toEqual({ _tag: "unavailable", status: "off" });
    enabled = true;
    expect(off.passkeys.state().status).toBe("available");
  });

  it("hands every sign-in result to the bridge in a shape its schema takes", async () => {
    const { native, handle } = makePasskeys();
    // electron-webauthn reports members it did not set as undefined: one PRF salt, a large blob read.
    const signIn = handle(request({ ceremony: "get", publicKey: {} }));
    await settle();
    native.answer(
      fromNative({
        success: true,
        data: {
          ...asserted.data,
          extensions: {
            prf: { results: { first: "AQ", second: undefined } },
            largeBlob: { blob: "Ag", written: undefined },
          },
        },
      }),
    );
    const assertedOutcome = await signIn;
    expect(() => encodeOutcome(assertedOutcome)).not.toThrow();
    expect(result(assertedOutcome)).toStrictEqual({
      _tag: "asserted",
      data: {
        ...asserted.data,
        extensions: { prf: { results: { first: "AQ" } }, largeBlob: { blob: "Ag" } },
      },
    });

    // A new passkey with PRF on and nothing evaluated yet.
    const signUp = handle(request(), "laptop-2");
    await settle();
    native.answer(
      fromNative({
        ...created,
        data: {
          ...created.data,
          extensions: {
            prf: { enabled: true, results: { first: undefined, second: undefined } },
            largeBlob: { supported: undefined },
          },
        },
      }),
    );
    const createdOutcome = await signUp;
    expect(() => encodeOutcome(createdOutcome)).not.toThrow();
    expect(result(createdOutcome)).toStrictEqual({
      _tag: "created",
      data: { ...created.data, extensions: { prf: { enabled: true }, largeBlob: {} } },
    });
  });

  it("gives the system sheet only the time the request has left", async () => {
    vi.useFakeTimers();
    try {
      const { native, handle } = makePasskeys();
      // The page set no timeout; the environment allows 60 s.
      const answer = handle(request({ ceremony: "get", publicKey: {} }));
      await vi.advanceTimersByTimeAsync(0);
      expect(native.calls[0]?.publicKey).toMatchObject({ timeout: 60_000 });

      // A page asking for an hour gets what the environment allows, less the time already spent.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(result(await answer)).toEqual({ _tag: "refused", error: "NotAllowedError" });
      native.answer({ success: false, error: "NotAllowedError" });
      let answerPrompt!: (allowed: boolean) => void;
      const asked = makePasskeys({
        confirm: () =>
          new Promise<boolean>((resolve) => {
            answerPrompt = resolve;
          }),
      });
      const agent = asked.handle(
        request({ requester: "agent", publicKey: { ...createOptions, timeout: 3_600_000 } }),
      );
      // The person takes ten seconds to answer the prompt.
      await vi.advanceTimersByTimeAsync(10_000);
      answerPrompt(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(asked.native.calls[0]?.publicKey).toMatchObject({ timeout: 50_000 });
      asked.native.answer(created);
      expect(result(await agent)).toMatchObject({ _tag: "created" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("frees the Mac for the next request when a native ceremony never settles", async () => {
    vi.useFakeTimers();
    try {
      const { native, handle } = makePasskeys();
      const first = handle(request({ timeoutMs: 15_000 }));
      await vi.advanceTimersByTimeAsync(15_000);
      expect(result(await first)).toEqual({ _tag: "refused", error: "NotAllowedError" });
      // The sheet's own timeout has passed but the native layer never answered.
      expect(result(await handle(request(), "laptop-2"))).toEqual({
        _tag: "refused",
        error: "NotAllowedError",
      });
      await vi.advanceTimersByTimeAsync(5_000);
      const next = handle(request(), "laptop-3");
      await vi.advanceTimersByTimeAsync(0);
      expect(native.calls).toHaveLength(2);
      native.answer({ success: false, error: "NotAllowedError" });
      native.answer(created);
      expect(result(await next)).toMatchObject({ _tag: "created" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses an insecure origin, a local one, and a second request while the sheet is open", async () => {
    const { native, handle, passkeys } = makePasskeys();
    expect(result(await handle(request({ origin: "http://example.com" })))).toEqual({
      _tag: "refused",
      error: "SecurityError",
    });
    // An environment's localhost is not this Mac's.
    for (const local of [
      { origin: "http://localhost:5173", rpId: "localhost" },
      { origin: "https://localhost", rpId: "localhost" },
      { origin: "https://app.localhost", rpId: "app.localhost" },
    ]) {
      expect(result(await handle(request(local)))).toEqual({
        _tag: "refused",
        error: "SecurityError",
      });
    }
    expect(native.calls).toEqual([]);

    const first = handle(request());
    await settle();
    expect(result(await handle(request(), "laptop-2"))).toEqual({
      _tag: "refused",
      error: "NotAllowedError",
    });

    // The environment gave up on the first; its sheet is still open, so others still wait.
    passkeys.cancel(environmentId, "laptop-1");
    expect(result(await first)).toEqual({ _tag: "refused", error: "AbortError" });
    expect(result(await handle(request(), "laptop-3"))).toEqual({
      _tag: "refused",
      error: "NotAllowedError",
    });
    native.answer(created);
    await settle();
    const next = handle(request(), "laptop-4");
    await settle();
    native.answer(created);
    expect(result(await next)).toMatchObject({ _tag: "created" });
  });

  it("times out like WebAuthn does", async () => {
    vi.useFakeTimers();
    try {
      const { handle } = makePasskeys();
      const answer = handle(request({ timeoutMs: 1_000 }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(result(await answer)).toEqual({ _tag: "refused", error: "NotAllowedError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks the person before an agent's ceremony and names who asks", async () => {
    const denied = makePasskeys({ confirm: async () => false });
    expect(result(await denied.handle(request({ requester: "agent" })))).toEqual({
      _tag: "refused",
      error: "NotAllowedError",
    });
    expect(denied.prompts).toEqual([
      {
        environmentLabel: "mac-mini",
        threadTitle: "Sign in to GitHub",
        rpId: "github.com",
        ceremony: "create",
        requester: "agent",
      },
    ]);
    expect(denied.native.calls).toEqual([]);

    const allowed = makePasskeys({ confirm: async () => true });
    const answer = allowed.handle(request({ requester: "agent" }));
    await settle();
    allowed.native.answer(created);
    expect(result(await answer)).toMatchObject({ _tag: "created" });
  });

  it("asks once per site and environment before a sign-in the person drives", async () => {
    vi.useFakeTimers();
    try {
      let allow = false;
      const { native, handle, prompts } = makePasskeys({ confirm: async () => allow });
      // Only the environment says the person drives the tab: the first request for a site asks.
      expect(result(await handle(request()))).toEqual({
        _tag: "refused",
        error: "NotAllowedError",
      });
      expect(prompts).toEqual([
        {
          environmentLabel: "mac-mini",
          threadTitle: "Sign in to GitHub",
          rpId: "github.com",
          ceremony: "create",
          requester: "person",
        },
      ]);
      // A Deny quiets that site, in every thread, without asking.
      allow = true;
      expect(
        result(await handle(request({ threadId: ThreadId.make("thread-2") }), "laptop-2")),
      ).toEqual({ _tag: "refused", error: "NotAllowedError" });
      expect(prompts).toHaveLength(1);
      expect(native.calls).toEqual([]);

      await vi.advanceTimersByTimeAsync(PASSKEY_DENIED_QUIET_MS);
      const confirmed = handle(request(), "laptop-3");
      await vi.advanceTimersByTimeAsync(0);
      native.answer(created);
      expect(result(await confirmed)).toMatchObject({ _tag: "created" });
      expect(prompts).toHaveLength(2);

      // Once confirmed, the person's later sign-ins to that site go straight to the sheet.
      const later = handle(request({ ceremony: "get", publicKey: {} }), "laptop-4");
      await vi.advanceTimersByTimeAsync(0);
      native.answer(asserted);
      expect(result(await later)).toMatchObject({ _tag: "asserted" });
      expect(prompts).toHaveLength(2);

      // Another site asks again.
      const other = handle(
        request({ origin: "https://accounts.example.com", rpId: "example.com" }),
        "laptop-5",
      );
      await vi.advanceTimersByTimeAsync(0);
      native.answer(created);
      expect(result(await other)).toMatchObject({ _tag: "created" });
      expect(prompts.map((prompt) => prompt.rpId)).toEqual([
        "github.com",
        "github.com",
        "example.com",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks before a tab nobody holds signs in, and a Deny quiets that thread for a while", async () => {
    vi.useFakeTimers();
    try {
      let allow = false;
      const { native, handle, prompts } = makePasskeys({ confirm: async () => allow });
      expect(result(await handle(request({ requester: "page" })))).toEqual({
        _tag: "refused",
        error: "NotAllowedError",
      });
      expect(prompts.map((prompt) => prompt.requester)).toEqual(["page"]);

      // The page tries again: refused without asking, until the quiet minute is over.
      allow = true;
      expect(result(await handle(request({ requester: "page" }), "laptop-2"))).toEqual({
        _tag: "refused",
        error: "NotAllowedError",
      });
      expect(prompts).toHaveLength(1);
      expect(native.calls).toEqual([]);

      // The person's own sign-in in that thread is not held back (it asks once for the
      // site), nor is another thread.
      const own = handle(request(), "laptop-3");
      await vi.advanceTimersByTimeAsync(0);
      native.answer(created);
      expect(result(await own)).toMatchObject({ _tag: "created" });
      const other = handle(
        request({ requester: "agent", threadId: ThreadId.make("thread-2") }),
        "laptop-4",
      );
      await vi.advanceTimersByTimeAsync(0);
      native.answer(created);
      expect(result(await other)).toMatchObject({ _tag: "created" });
      expect(prompts.map((prompt) => prompt.requester)).toEqual(["page", "person", "agent"]);

      await vi.advanceTimersByTimeAsync(PASSKEY_DENIED_QUIET_MS);
      const again = handle(request({ requester: "page" }), "laptop-5");
      await vi.advanceTimersByTimeAsync(0);
      native.answer(created);
      expect(result(await again)).toMatchObject({ _tag: "created" });
      expect(prompts).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
