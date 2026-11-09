// @effect-diagnostics nodeBuiltinImport:off -- An EventEmitter stands in for Electron's powerMonitor.
import * as NodeEvents from "node:events";

import { describe, expect, it, vi } from "vite-plus/test";

import { pauseWhileAway } from "./pauseWhileAway.ts";

// A settled start reaches `pauseWhileAway` within microtasks; one macrotask lets it land.
// oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- a zero-delay macrotask boundary, not a wait for time
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** A helper whose every start the test finishes by hand. */
function makeHelper() {
  const signals = new NodeEvents.EventEmitter();
  const onFailure = vi.fn();
  const starts: Array<{
    readonly stop: ReturnType<typeof vi.fn<() => void>>;
    readonly fail: (error: Error) => void;
    readonly ready: () => Promise<void>;
    readonly refuse: (error: Error) => Promise<void>;
  }> = [];
  const start = (fail: (error: Error) => void) =>
    new Promise<() => void>((resolve, reject) => {
      const stop = vi.fn<() => void>();
      starts.push({
        stop,
        fail,
        ready: async () => {
          resolve(stop);
          await settle();
        },
        refuse: async (error) => {
          reject(error);
          await settle();
        },
      });
    });
  const run = async () => {
    const running = pauseWhileAway(signals, start, onFailure);
    await starts[0]!.ready();
    return running;
  };
  return { signals, onFailure, starts, run };
}

describe("pauseWhileAway", () => {
  it("stops while the screen is locked or the Mac sleeps, and starts once both end", async () => {
    const { signals, onFailure, starts, run } = makeHelper();
    const stop = await run();

    signals.emit("lock-screen");
    expect(starts[0]!.stop).toHaveBeenCalledOnce();
    // Waking at the lock screen is still away.
    signals.emit("suspend");
    signals.emit("resume");
    expect(starts).toHaveLength(1);
    signals.emit("unlock-screen");
    expect(starts).toHaveLength(2);
    await starts[1]!.ready();

    signals.emit("suspend");
    expect(starts[1]!.stop).toHaveBeenCalledOnce();
    signals.emit("resume");
    await starts[2]!.ready();
    expect(starts[2]!.stop).not.toHaveBeenCalled();

    stop();
    expect(starts[2]!.stop).toHaveBeenCalledOnce();
    expect(signals.eventNames()).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("stops a restart that finishes after the screen locked again or it was stopped", async () => {
    const { signals, starts, run } = makeHelper();
    const stop = await run();

    signals.emit("lock-screen");
    signals.emit("unlock-screen");
    signals.emit("lock-screen");
    await starts[1]!.ready();
    expect(starts[1]!.stop).toHaveBeenCalledOnce();

    signals.emit("unlock-screen");
    stop();
    await starts[2]!.ready();
    expect(starts[2]!.stop).toHaveBeenCalledOnce();
    expect(starts).toHaveLength(3);
  });

  it("ends for good, reporting once, when the helper fails or cannot restart", async () => {
    const running = makeHelper();
    await running.run();
    running.starts[0]!.fail(new Error("exited"));
    running.signals.emit("lock-screen");
    running.signals.emit("unlock-screen");
    expect(running.starts).toHaveLength(1);
    expect(running.onFailure.mock.calls).toEqual([[new Error("exited")]]);
    expect(running.signals.eventNames()).toEqual([]);

    const restarting = makeHelper();
    await restarting.run();
    restarting.signals.emit("suspend");
    restarting.signals.emit("resume");
    await restarting.starts[1]!.refuse(new Error("spawn failed"));
    expect(restarting.onFailure.mock.calls).toEqual([[new Error("spawn failed")]]);
    expect(restarting.signals.eventNames()).toEqual([]);
  });

  it("reports a restart that throws instead of throwing into the power monitor", async () => {
    const signals = new NodeEvents.EventEmitter();
    const onFailure = vi.fn();
    let starts = 0;
    await pauseWhileAway(
      signals,
      () => {
        starts += 1;
        if (starts > 1) throw new Error("spawn EPERM");
        return Promise.resolve(() => {});
      },
      onFailure,
    );
    signals.emit("lock-screen");
    expect(() => signals.emit("unlock-screen")).not.toThrow();
    await settle();
    expect(onFailure.mock.calls).toEqual([[new Error("spawn EPERM")]]);
  });

  it("rejects without listening when the first start fails", async () => {
    const { signals, onFailure } = makeHelper();
    const running = pauseWhileAway(
      signals,
      () => Promise.reject(new Error("no osascript")),
      onFailure,
    );
    await expect(running).rejects.toThrow("no osascript");
    expect(signals.eventNames()).toEqual([]);
    expect(onFailure).not.toHaveBeenCalled();
  });
});
