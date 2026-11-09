import {
  EnvironmentId,
  LaptopToolHostId,
  LaptopToolServerId,
  RunId,
  ThreadId,
  type DesktopLaptopToolsHandleInput,
  type LaptopPasskeyRequest,
  type LaptopToolsOutcome,
  type LaptopToolsResponse,
  type LaptopToolsStreamEvent,
} from "@t3tools/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { createLaptopToolsRequestRelay, relayLaptopToolsEvents } from "./laptopToolsRequests";

const environmentId = EnvironmentId.make("env-mini");
const hostId = LaptopToolHostId.make("host-1");

const callEvent = (requestId: string, connectionId = "conn-1"): LaptopToolsStreamEvent => ({
  type: "request",
  connectionId,
  requestId,
  request: {
    _tag: "callTool",
    threadId: ThreadId.make("thread-1"),
    threadTitle: "Check the dashboard",
    runId: RunId.make("run-1"),
    serverId: LaptopToolServerId.make("computer-use"),
    tool: "screenshot",
    arguments: {},
    timeoutMs: 5_000,
  },
});

const passkeyRequest: LaptopPasskeyRequest = {
  _tag: "passkey",
  ceremony: "get",
  origin: "https://github.com",
  rpId: "github.com",
  publicKey: { challenge: { $b64u: "BwcH" } },
  threadId: ThreadId.make("thread-1"),
  threadTitle: "Sign in",
  requester: "person",
  timeoutMs: 60_000,
};

const passkeyEvent = (requestId: string): LaptopToolsStreamEvent => ({
  type: "request",
  connectionId: "conn-1",
  requestId,
  request: passkeyRequest,
});

function relayWith(handle: (input: DesktopLaptopToolsHandleInput) => Promise<LaptopToolsOutcome>) {
  const handled: DesktopLaptopToolsHandleInput[] = [];
  const cancelled: string[] = [];
  const responses: LaptopToolsResponse[] = [];
  const passkeyNotices: unknown[] = [];
  let settle: () => void = () => undefined;
  const responded = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const { relay, dispose } = createLaptopToolsRequestRelay({
    hostId,
    environmentId,
    environmentLabel: () => "Office Mac mini",
    bridge: {
      handleRequest: (input) => {
        handled.push(input);
        return handle(input);
      },
      cancelRequest: async (input) => {
        cancelled.push(input.requestId);
      },
    },
    respond: async (response) => {
      responses.push(response);
      settle();
    },
    onPasskeyUnavailable: (notice) => passkeyNotices.push(notice),
  });
  return { relay, dispose, handled, cancelled, responses, responded, passkeyNotices };
}

describe("laptop tools request relay", () => {
  it("answers each request once with the desktop's outcome", async () => {
    const outcome: LaptopToolsOutcome = {
      _tag: "result",
      result: { content: [{ type: "text", text: "ok" }] },
    };
    const { relay, handled, responses, responded } = relayWith(async () => outcome);
    relay({ type: "connected", connectionId: "conn-1" });
    relay(callEvent("r1"));
    relay(callEvent("r1"));
    await responded;
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({ environmentId, environmentLabel: "Office Mac mini" });
    expect(responses).toEqual([{ hostId, connectionId: "conn-1", requestId: "r1", outcome }]);
  });

  it("reports a desktop failure to the environment instead of leaving the agent waiting", async () => {
    const { relay, responses, responded } = relayWith(async () => {
      throw new Error("IPC closed");
    });
    relay(callEvent("r1"));
    await responded;
    expect(responses[0]?.outcome).toMatchObject({ _tag: "failure", code: "failed" });
  });

  it("says why this Mac could not run a passkey request, and still answers the environment", async () => {
    const unavailable: LaptopToolsOutcome = {
      _tag: "passkey",
      result: { _tag: "unavailable", status: "awaiting-entitlement" },
    };
    const answers = new Map<string, (outcome: LaptopToolsOutcome) => void>();
    const { relay, responses, responded, passkeyNotices } = relayWith(
      (input) => new Promise((resolve) => answers.set(input.requestId, resolve)),
    );
    relay(passkeyEvent("r1"));
    relay(passkeyEvent("r2"));
    // The page went away before this Mac answered: nobody waits, so nothing is said.
    relay({ type: "cancel", connectionId: "conn-1", requestId: "r1" });
    answers.get("r1")?.(unavailable);
    answers.get("r2")?.(unavailable);
    await responded;
    // The environment falls back to the profile's saved passkeys on this answer.
    expect(responses).toEqual([
      { hostId, connectionId: "conn-1", requestId: "r2", outcome: unavailable },
    ]);
    expect(passkeyNotices).toEqual([
      {
        request: passkeyRequest,
        status: "awaiting-entitlement",
        environmentLabel: "Office Mac mini",
      },
    ]);
  });

  it("passes cancellations to the desktop", () => {
    const { relay, cancelled } = relayWith(() => new Promise(() => undefined));
    relay(callEvent("r1"));
    relay({ type: "cancel", connectionId: "conn-1", requestId: "r1" });
    expect(cancelled).toEqual(["r1"]);
  });

  effectIt.effect("relays every event of a batch, not only the last one", () =>
    Effect.gen(function* () {
      const { relay, handled, cancelled } = relayWith(() => new Promise(() => undefined));
      // The transport delivers events in chunks; two parallel calls and a
      // cancel can arrive together.
      yield* Stream.runDrain(
        relayLaptopToolsEvents(
          Stream.fromIterable<LaptopToolsStreamEvent>([
            { type: "connected", connectionId: "conn-1" },
            callEvent("r1"),
            callEvent("r2"),
            { type: "cancel", connectionId: "conn-1", requestId: "r1" },
          ]),
          relay,
        ),
      );
      expect(handled.map((input) => input.requestId)).toEqual(["r1", "r2"]);
      expect(cancelled).toEqual(["r1"]);
    }),
  );

  it("cancels what is still running when the registration goes away, and sends no answer", async () => {
    let finish: (outcome: LaptopToolsOutcome) => void = () => undefined;
    const { relay, dispose, cancelled, responses } = relayWith(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    relay(callEvent("r1"));
    dispose();
    expect(cancelled).toEqual(["r1"]);
    finish({ _tag: "failure", code: "cancelled", message: "The call was cancelled." });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(responses).toEqual([]);
    // Nothing more is relayed after it is gone.
    relay(callEvent("r2"));
    expect(cancelled).toEqual(["r1"]);
  });

  it("cancels the old connection's calls when the laptop reconnects", () => {
    const { relay, cancelled } = relayWith(() => new Promise(() => undefined));
    relay({ type: "connected", connectionId: "conn-1" });
    relay(callEvent("r1"));
    relay({ type: "connected", connectionId: "conn-2" });
    relay(callEvent("r2", "conn-2"));
    expect(cancelled).toEqual(["r1"]);
  });
});
