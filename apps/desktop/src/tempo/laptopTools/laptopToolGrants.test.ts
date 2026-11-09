// @effect-diagnostics globalTimers:off -- The consent state machine under test is plain Promise code.
import { EnvironmentId, LaptopToolServerId, RunId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  LAPTOP_TOOL_GRANT_IDLE_MS,
  LaptopToolGrants,
  type LaptopToolConsentDecision,
  type LaptopToolConsentRequest,
} from "./laptopToolGrants.ts";

const environmentId = EnvironmentId.make("env-mini");
const threadId = ThreadId.make("thread-1");
const run1 = RunId.make("run-1");
const run2 = RunId.make("run-2");

const consent = (overrides: Partial<LaptopToolConsentRequest> = {}): LaptopToolConsentRequest => ({
  environmentId,
  environmentLabel: "Office Mac mini",
  threadId,
  threadTitle: "Check the dashboard",
  runId: run1,
  serverId: LaptopToolServerId.make("computer-use"),
  serverName: "Computer use",
  launchKey: "launch-a",
  ...overrides,
});

/** A person who answers each prompt when the test says so. */
function harness() {
  let now = 1_000;
  const prompts: Array<{
    readonly request: LaptopToolConsentRequest;
    readonly signal: AbortSignal;
    readonly answer: (decision: LaptopToolConsentDecision) => void;
  }> = [];
  const grants = new LaptopToolGrants({
    now: () => now,
    prompt: (request, signal) =>
      new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve("dismissed"), { once: true });
        prompts.push({ request, signal, answer: resolve });
      }),
  });
  return {
    grants,
    prompts,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("laptop tool consent", () => {
  it("asks once per thread, server and run, then reuses the grant", async () => {
    const { grants, prompts } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    expect(prompts).toHaveLength(1);
    prompts[0]!.answer("allow");
    const allowed = await first;
    expect(allowed.allowed).toBe(true);
    if (allowed.allowed) allowed.release();

    const second = await grants.acquire(consent(), new AbortController().signal);
    expect(second.allowed).toBe(true);
    expect(prompts).toHaveLength(1);

    // Another server for the same thread is a separate decision.
    void grants.acquire(
      consent({ serverId: LaptopToolServerId.make("laptop-browser") }),
      new AbortController().signal,
    );
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it("shows one prompt to calls that arrive while the person decides", async () => {
    const { grants, prompts } = harness();
    const calls = [1, 2, 3].map(() => grants.acquire(consent(), new AbortController().signal));
    await flush();
    expect(prompts).toHaveLength(1);
    prompts[0]!.answer("allow");
    const results = await Promise.all(calls);
    expect(results.every((result) => result.allowed)).toBe(true);
    expect(grants.list()[0]?.inFlight).toBe(3);
  });

  it("keeps a denial for the rest of the run and asks again in the next run", async () => {
    const { grants, prompts } = harness();
    const denied = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("deny");
    expect(await denied).toEqual({ allowed: false, reason: "denied" });
    expect(grants.list()).toHaveLength(0);

    expect(await grants.acquire(consent(), new AbortController().signal)).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(prompts).toHaveLength(1);

    void grants.acquire(consent({ runId: run2 }), new AbortController().signal);
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it("asks again when a new run calls, ending the old run's grant", async () => {
    const { grants, prompts } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("allow");
    const held = await first;
    expect(held.allowed).toBe(true);

    void grants.acquire(consent({ runId: run2 }), new AbortController().signal);
    await flush();
    expect(prompts).toHaveLength(2);
    if (held.allowed) expect(held.signal.aborted).toBe(true);
  });

  it("stops a grant: its calls abort and the run does not ask again", async () => {
    const { grants, prompts } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("allow");
    const held = await first;
    if (!held.allowed) throw new Error("expected a grant");
    const [grant] = grants.list();

    grants.stop(grant!.key);
    expect(held.signal.aborted).toBe(true);
    expect(grants.list()).toHaveLength(0);

    expect(await grants.acquire(consent(), new AbortController().signal)).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(prompts).toHaveLength(1);

    void grants.acquire(consent({ runId: run2 }), new AbortController().signal);
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it("closes an open prompt on Stop without allowing anything", async () => {
    const { grants, prompts } = harness();
    const pending = grants.acquire(consent(), new AbortController().signal);
    await flush();
    grants.stop();
    expect(prompts[0]!.signal.aborted).toBe(true);
    // A late click on the closed prompt does not count.
    prompts[0]!.answer("allow");
    expect(await pending).toEqual({ allowed: false, reason: "dismissed" });
    expect(grants.list()).toHaveLength(0);
    expect(await grants.acquire(consent(), new AbortController().signal)).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(prompts).toHaveLength(1);
  });

  it("closes a prompt nobody answered once every waiting call gave up, and refuses the run", async () => {
    const { grants, prompts } = harness();
    const a = new AbortController();
    const b = new AbortController();
    const first = grants.acquire(consent(), a.signal);
    const second = grants.acquire(consent(), b.signal);
    await flush();
    a.abort();
    expect(prompts[0]!.signal.aborted).toBe(false);
    b.abort();
    expect(prompts[0]!.signal.aborted).toBe(true);
    expect(await first).toEqual({ allowed: false, reason: "dismissed" });
    expect(await second).toEqual({ allowed: false, reason: "dismissed" });
    await flush();

    // The agent cannot reopen the prompt by calling again in the same run.
    expect(await grants.acquire(consent(), new AbortController().signal)).toEqual({
      allowed: false,
      reason: "denied",
    });
    expect(prompts).toHaveLength(1);
  });

  it("asks again when the server launches differently than when it was allowed", async () => {
    const { grants, prompts } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("allow");
    const held = await first;
    if (!held.allowed) throw new Error("expected a grant");
    held.release();

    void grants.acquire(consent({ launchKey: "launch-b" }), new AbortController().signal);
    await flush();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]!.request.launchKey).toBe("launch-b");
  });

  it("revoking a server's grants asks again without refusing the run", async () => {
    const { grants, prompts } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("allow");
    const held = await first;
    if (!held.allowed) throw new Error("expected a grant");

    grants.revokeServer(LaptopToolServerId.make("computer-use"));
    expect(held.signal.aborted).toBe(true);
    expect(grants.list()).toHaveLength(0);

    void grants.acquire(consent(), new AbortController().signal);
    await flush();
    expect(prompts).toHaveLength(2);
  });

  it("expires a grant after 30 idle minutes, but not while a call runs", async () => {
    const { grants, prompts, advance } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("allow");
    const held = await first;
    if (!held.allowed) throw new Error("expected a grant");

    advance(LAPTOP_TOOL_GRANT_IDLE_MS + 1);
    grants.sweep();
    expect(grants.list()).toHaveLength(1);

    held.release();
    advance(LAPTOP_TOOL_GRANT_IDLE_MS - 1);
    grants.sweep();
    expect(grants.list()).toHaveLength(1);
    advance(1);
    grants.sweep();
    expect(grants.list()).toHaveLength(0);
  });

  it("ends a thread's grants when its run ends", async () => {
    const { grants, prompts } = harness();
    const first = grants.acquire(consent(), new AbortController().signal);
    await flush();
    prompts[0]!.answer("allow");
    await first;

    grants.runChanged(environmentId, threadId, run1);
    expect(grants.list()).toHaveLength(1);
    grants.runChanged(environmentId, ThreadId.make("other-thread"), null);
    expect(grants.list()).toHaveLength(1);
    grants.runChanged(environmentId, threadId, null);
    expect(grants.list()).toHaveLength(0);
  });
});
