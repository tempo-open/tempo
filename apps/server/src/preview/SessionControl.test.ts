import { describe, expect, it } from "vite-plus/test";

import { BrowserControlInterrupted, HUMAN_HOLD_MS, SessionControl } from "./SessionControl.ts";

describe("SessionControl", () => {
  it("returns an action result before tracked navigation but drains it before already queued actions", async () => {
    const control = new SessionControl("agent");
    const committed = Promise.withResolvers<void>();
    const events: string[] = [];
    const navigation = control.agent("agent", async () => {
      control.track(committed.promise.then(() => events.push("navigation committed")));
      return "started";
    });
    const next = control.agent("agent", async () => events.push("next action"));
    await expect(navigation).resolves.toBe("started");
    expect(events).toEqual([]);
    committed.resolve();
    await next;
    expect(events).toEqual(["navigation committed", "next action"]);
  });

  it("handles tracked navigation failures without poisoning the next action", async () => {
    const control = new SessionControl("agent");
    const committed = Promise.withResolvers<void>();
    await control.agent("agent", async () => control.track(committed.promise));
    committed.reject(new Error("navigation failed"));
    await expect(control.agent("agent", async () => "resumed")).resolves.toBe("resumed");
  });

  it("only lets the assigned agent act and restores that agent after human control", async () => {
    const control = new SessionControl("agent-a");
    await expect(control.agent("agent-b", async () => "wrong agent")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.agent("agent-a", async () => "first")).resolves.toBe("first");
    control.claim("viewer-a");
    await expect(control.agent("agent-a", async () => "racing")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.human("viewer-a", async () => "typed")).resolves.toBe("typed");
    await control.release("viewer-a");
    await expect(control.agent("agent-a", async () => "resumed")).resolves.toBe("resumed");
    await expect(control.agent("agent-b", async () => "wrong agent")).rejects.toThrow(
      BrowserControlInterrupted,
    );
  });

  it("drains running work before takeover and cancels previously queued agent actions", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.agent("agent", async () => {
      events.push("agent started");
      started.resolve();
      await finish.promise;
      events.push("agent finished");
    });
    await started.promise;
    const queued = expect(
      control.agent("agent", async () => events.push("stale agent action")),
    ).rejects.toThrow(BrowserControlInterrupted);
    control.claim("viewer");
    const typing = control.human("viewer", async () => events.push("human typed"));
    await expect(control.agent("agent", async () => "late action")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    expect(events).toEqual(["agent started"]);
    finish.resolve();
    await Promise.all([running, queued, typing]);
    expect(events).toEqual(["agent started", "agent finished", "human typed"]);
  });

  it("lets a second viewer take the tab once the first lets go of what it holds", async () => {
    const events: string[] = [];
    const control = new SessionControl("agent", () => {}, {
      releaseInput: async (viewerId) => void events.push(`${viewerId} let go`),
    });
    control.claim("viewer-a");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const pressing = control.human("viewer-a", async () => {
      events.push("viewer-a pressed");
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const queued = expect(
      control.human("viewer-a", async () => events.push("stale input")),
    ).rejects.toThrow(BrowserControlInterrupted);
    expect(control.claim("viewer-b")).toBe(true);
    expect(control.controller).toBe("viewer-b");
    const typing = control.human("viewer-b", async () => events.push("viewer-b typed"));
    await expect(control.human("viewer-a", async () => "late input")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    await expect(control.release("viewer-a")).rejects.toThrow("Only the controlling viewer");
    await control.disconnect("viewer-a");
    expect(control.controller).toBe("viewer-b");
    finish.resolve();
    await Promise.all([pressing, queued, typing]);
    expect(events).toEqual(["viewer-a pressed", "viewer-a let go", "viewer-b typed"]);
  });

  // tempo: an agent waits for a page a person left loading; another person does not.
  it("lets a second viewer act during the first's navigation, but holds agents until it commits", async () => {
    const events: string[] = [];
    const control = new SessionControl(null, () => {}, {
      releaseInput: async (viewerId) => void events.push(`${viewerId} let go`),
    });
    const committed = Promise.withResolvers<void>();
    control.claim("viewer-a");
    await control.human("viewer-a", async () =>
      control.trackUntilHandoff(committed.promise.then(() => events.push("navigation committed"))),
    );
    control.claim("viewer-b");
    await control.human("viewer-b", async () => events.push("viewer-b clicked"));
    expect(events).toEqual(["viewer-a let go", "viewer-b clicked"]);

    const handBack = control.release("viewer-b");
    const agent = control.agent("agent", async () => events.push("agent acted"));
    await Promise.resolve();
    expect(events).toEqual(["viewer-a let go", "viewer-b clicked"]);
    committed.resolve();
    await Promise.all([handBack, agent]);
    expect(events).toEqual([
      "viewer-a let go",
      "viewer-b clicked",
      "navigation committed",
      "viewer-b let go",
      "agent acted",
    ]);
  });

  it("keeps an active person's tab from agents and hands an idle one's back on the agent's next action", async () => {
    let now = 1_000;
    let changes = 0;
    const events: string[] = [];
    const control = new SessionControl(null, () => changes++, {
      now: () => now,
      releaseInput: async (viewerId) => void events.push(`${viewerId} let go`),
    });
    expect(control.claim("viewer")).toBe(true);
    now += HUMAN_HOLD_MS - 1;
    expect(control.agentCanActNow("agent")).toBe(false);
    await expect(control.agent("agent", async () => "too soon")).rejects.toMatchObject({
      reason: "humanControl",
      message: "A person is using this browser tab. Try again in a few seconds.",
    });
    // More deliberate input renews the hold without changing hands.
    expect(control.claim("viewer")).toBe(false);
    now += HUMAN_HOLD_MS - 1;
    expect(control.yieldToAgent()).toBe(false);
    expect(changes).toBe(1);

    now += 1;
    expect(control.humanActive()).toBe(false);
    expect(control.agentCanActNow("agent")).toBe(true);
    // Nothing changes hands until an agent acts.
    expect(control.controller).toBe("viewer");
    expect(changes).toBe(1);
    await expect(
      control.agent("agent", async () => {
        events.push("agent acted");
        return "acted";
      }),
    ).resolves.toBe("acted");
    expect(events).toEqual(["viewer let go", "agent acted"]);
    expect(control.controller).toBeNull();
    expect(changes).toBe(2);

    // The person's next input takes it straight back.
    expect(control.claim("viewer")).toBe(true);
    await expect(control.agent("agent", async () => "again")).rejects.toMatchObject({
      reason: "humanControl",
    });
  });

  it("never hands an idle person's tab to an agent that may not act on it", async () => {
    let now = 0;
    const control = new SessionControl("agent-a", () => {}, { now: () => now });
    control.claim("viewer");
    now += HUMAN_HOLD_MS;
    await expect(control.agent("agent-b", async () => "foreign")).rejects.toMatchObject({
      reason: "agentMismatch",
    });
    expect(control.agentCanActNow("agent-b")).toBe(false);
    expect(control.controller).toBe("viewer");
  });

  it("invalidates queued human actions and refs when a viewer disconnects", async () => {
    let invalidations = 0;
    const control = new SessionControl("agent", () => invalidations++);
    control.claim("viewer");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const events: string[] = [];
    const running = control.human("viewer", async () => {
      started.resolve();
      await finish.promise;
      events.push("human finished");
    });
    await started.promise;
    const queued = expect(
      control.human("viewer", async () => events.push("stale human action")),
    ).rejects.toThrow(BrowserControlInterrupted);
    const disconnected = control.disconnect("viewer");
    const resumed = control.agent("agent", async () => events.push("agent resumed"));
    expect(control.generation).toBe(2);
    expect(invalidations).toBe(2);
    finish.resolve();
    await Promise.all([running, queued, disconnected, resumed]);
    expect(events).toEqual(["human finished", "agent resumed"]);
  });

  it("does not revive stale actions when takeover is released before running work finishes", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.agent("agent", async () => {
      started.resolve();
      await finish.promise;
    });
    await started.promise;
    const staleAgent = expect(control.agent("agent", async () => "stale")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    control.claim("viewer");
    const staleHuman = expect(control.human("viewer", async () => "stale")).rejects.toThrow(
      BrowserControlInterrupted,
    );
    const release = control.release("viewer");
    const resumed = control.agent("agent", async () => "fresh");
    finish.resolve();
    await Promise.all([running, staleAgent, staleHuman, release]);
    await expect(resumed).resolves.toBe("fresh");
  });

  it("closes after running work finishes and never runs queued or new actions", async () => {
    const control = new SessionControl("agent");
    const started = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const running = control.agent("agent", async () => {
      started.resolve();
      await finish.promise;
      return "finished";
    });
    await started.promise;
    const queued = expect(control.agent("agent", async () => "stale")).rejects.toThrow("closed");
    const closed = control.close();
    expect(() => control.claim("viewer")).toThrow("closed");
    await expect(control.agent("agent", async () => "new")).rejects.toThrow("closed");
    finish.resolve();
    await expect(running).resolves.toBe("finished");
    await Promise.all([queued, closed]);
    await control.disconnect("viewer");
    await control.close();
    expect(control.generation).toBe(1);
  });

  it("lets any agent act on a tab no agent opened, but not while a person is using it", async () => {
    const control = new SessionControl(null);
    await expect(control.agent("agent-a", async () => "acted")).resolves.toBe("acted");
    control.claim("viewer-a");
    await expect(control.agent("agent-a", async () => "racing")).rejects.toMatchObject({
      reason: "humanControl",
    });
    await expect(control.observe(async () => "read")).resolves.toBe("read");
    await control.release("viewer-a");
    await expect(control.agent("agent-b", async () => "acted")).resolves.toBe("acted");
  });
});
