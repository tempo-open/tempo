import { describe, expect, it } from "@effect/vitest";

import {
  type DesktopTabPasskeyAnswer,
  DesktopTabPasskeyGate,
  desktopTabRelyingParty,
} from "./DesktopTabPasskeyGate.ts";
import { PASSKEY_DENIED_QUIET_MS } from "./LaptopPasskeys.ts";

const origin = "https://accounts.example.com";

/** A gate on a clock the test moves, and the person's answers in order. */
const makeGate = (answers: Array<DesktopTabPasskeyAnswer>) => {
  let now = 1_000;
  const asked: Array<string> = [];
  const gate = new DesktopTabPasskeyGate({ now: () => now });
  const request = (input: {
    readonly agentDrove: boolean;
    readonly ceremony?: "create" | "get";
    readonly publicKey?: unknown;
    readonly origin?: string;
  }) =>
    gate.admit({
      agentDrove: input.agentDrove,
      ceremony: input.ceremony ?? "get",
      publicKey: input.publicKey ?? { rpId: "example.com" },
      origin: input.origin ?? origin,
      ask: async (rpId) => {
        asked.push(rpId);
        return answers.shift() ?? "dismissed";
      },
    });
  return { request, asked, advance: (ms: number) => (now += ms) };
};

describe("DesktopTabPasskeyGate", () => {
  it("leaves a tab no agent drove to the system sheet without asking", async () => {
    const { request, asked } = makeGate([]);
    expect(await request({ agentDrove: false })).toBe("sheet");
    // Even a relying party the origin cannot use: the native layer refuses it, as before.
    expect(await request({ agentDrove: false, publicKey: { rpId: "other.test" } })).toBe("sheet");
    expect(asked).toEqual([]);
  });

  it("asks once per site for tabs an agent drove, then goes straight to the sheet", async () => {
    const { request, asked } = makeGate(["allow", "allow"]);
    expect(await request({ agentDrove: true })).toBe("sheet");
    expect(await request({ agentDrove: true })).toBe("sheet");
    expect(await request({ agentDrove: true, ceremony: "create", publicKey: { rp: {} } })).toBe(
      "sheet",
    );
    // The first request names example.com; the creation defaults to the page's own host.
    expect(asked).toEqual(["example.com", "accounts.example.com"]);
  });

  it("refuses on Deny and stays quiet for that site for a minute", async () => {
    const { request, asked, advance } = makeGate(["deny", "allow"]);
    expect(await request({ agentDrove: true })).toBe("NotAllowedError");
    expect(await request({ agentDrove: true })).toBe("NotAllowedError");
    expect(asked).toEqual(["example.com"]);
    // Another site still asks.
    expect(
      await request({
        agentDrove: true,
        origin: "https://shop.test",
        publicKey: { rpId: "shop.test" },
      }),
    ).toBe("sheet");
    advance(PASSKEY_DENIED_QUIET_MS);
    expect(await request({ agentDrove: true })).toBe("NotAllowedError");
    expect(asked).toEqual(["example.com", "shop.test", "example.com"]);
  });

  it("asks again after a request that gave up without an answer", async () => {
    const { request, asked } = makeGate(["dismissed", "allow"]);
    expect(await request({ agentDrove: true })).toBe("NotAllowedError");
    expect(await request({ agentDrove: true })).toBe("sheet");
    expect(asked).toEqual(["example.com", "example.com"]);
  });

  it("refuses a relying party the page's origin may not use without asking", async () => {
    const { request, asked } = makeGate(["allow"]);
    expect(await request({ agentDrove: true, publicKey: { rpId: "bank.test" } })).toBe(
      "SecurityError",
    );
    expect(
      await request({
        agentDrove: true,
        ceremony: "create",
        publicKey: { rp: { id: "ample.com" } },
      }),
    ).toBe("SecurityError");
    expect(asked).toEqual([]);
  });
});

describe("desktopTabRelyingParty", () => {
  it("takes the page's host or a parent domain of it, and defaults to the host", () => {
    expect(desktopTabRelyingParty("get", { rpId: "Example.com" }, origin)).toBe("example.com");
    expect(desktopTabRelyingParty("get", {}, origin)).toBe("accounts.example.com");
    expect(desktopTabRelyingParty("create", { rp: { id: "example.com" } }, origin)).toBe(
      "example.com",
    );
    expect(desktopTabRelyingParty("create", { rp: { name: "Example" } }, origin)).toBe(
      "accounts.example.com",
    );
    expect(desktopTabRelyingParty("get", { rpId: "evil.test" }, origin)).toBeNull();
    expect(desktopTabRelyingParty("get", { rpId: "" }, origin)).toBeNull();
    expect(desktopTabRelyingParty("get", {}, "not a url")).toBeNull();
  });
});
