import { EnvironmentId, LaptopToolsOutcome, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it, vi } from "vite-plus/test";

// electron-webauthn builds and hashes `clientDataJSON` itself: `type`, the
// challenge, `origin` from `currentOrigin`, and `crossOrigin` (with
// `topOrigin`) when `topFrameOrigin` differs. This pins what the laptop hands
// it for an environment's request; the module itself only runs on a Mac.
const getCredential = vi.hoisted(() =>
  vi.fn<
    (
      publicKey: PublicKeyCredentialRequestOptions,
      options: { readonly currentOrigin: string; readonly topFrameOrigin: string | undefined },
    ) => Promise<unknown>
  >(),
);
vi.mock("electron-webauthn", () => ({ getCredential, createCredential: vi.fn() }));

import { macPasskeyBackend } from "../../preview/PasskeyBackendMac.ts";
import { LaptopPasskeys } from "./LaptopPasskeys.ts";

const encodeOutcome = Schema.encodeUnknownSync(LaptopToolsOutcome);

it("signs the environment's origin as a same-origin top frame, and answers in the bridge's shape", async () => {
  getCredential.mockResolvedValue({
    success: true,
    data: {
      credentialId: "AQID",
      clientDataJSON: "BA",
      authenticatorData: "BQ",
      signature: "Bg",
      userHandle: "CA",
      // As the native layer reports one PRF salt.
      extensions: { prf: { results: { first: "AQ", second: undefined } } },
    },
  });
  const passkeys = new LaptopPasskeys({
    status: "available",
    probe: async () => true,
    enabled: () => true,
    backend: macPasskeyBackend,
    sheetWindow: async () => Buffer.from([1]),
    confirm: async () => true,
    onChange: () => {},
  });
  const outcome = await passkeys.handle({
    environmentId: EnvironmentId.make("mini"),
    environmentLabel: "mac-mini",
    requestId: "laptop-1",
    request: {
      _tag: "passkey",
      ceremony: "get",
      origin: "https://login.github.com",
      rpId: "github.com",
      publicKey: { challenge: { $b64u: "BwcH" }, rpId: "evil.example", timeout: 3_600_000 },
      threadId: ThreadId.make("thread-1"),
      threadTitle: "Sign in",
      requester: "person",
      timeoutMs: 60_000,
    },
  });

  const [publicKey, options] = getCredential.mock.calls[0] ?? [];
  expect(options).toMatchObject({
    currentOrigin: "https://login.github.com",
    topFrameOrigin: "https://login.github.com",
  });
  expect(publicKey?.rpId).toBe("github.com");
  expect([...new Uint8Array(publicKey?.challenge as ArrayBuffer)]).toEqual([7, 7, 7]);
  expect(publicKey?.timeout).toBeGreaterThan(59_000);
  expect(publicKey?.timeout).toBeLessThanOrEqual(60_000);
  expect(() => encodeOutcome(outcome)).not.toThrow();
  expect(outcome).toMatchObject({
    _tag: "passkey",
    result: { _tag: "asserted", data: { extensions: { prf: { results: { first: "AQ" } } } } },
  });
});
