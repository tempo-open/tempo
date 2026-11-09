import * as NodeEvents from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";

import {
  listenForShutdownSignals,
  makeShutdownDeadline,
  summarizeActiveResources,
} from "./shutdownDeadline.ts";

describe("shutdown deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const harness = () => {
    const exits: number[] = [];
    const reports: string[] = [];
    const start = makeShutdownDeadline({
      deadlineMs: 60_000,
      exit: (code) => exits.push(code),
      report: (message) => reports.push(message),
      activeResources: () => ["ChildProcess", "TCPWrap", "ChildProcess"],
    });
    return { exits, reports, start };
  };

  it("exits once the deadline passes after a stop starts, naming what was still open", () => {
    const { exits, reports, start } = harness();
    start();
    vi.advanceTimersByTime(59_999);
    expect(exits).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(exits).toEqual([1]);
    expect(reports).toEqual([
      "Shutdown did not finish within 60 s; exiting. Still open: ChildProcess ×2, TCPWrap",
    ]);
  });

  it("counts from the first stop only", () => {
    const { exits, start } = harness();
    start();
    vi.advanceTimersByTime(30_000);
    start();
    vi.advanceTimersByTime(30_000);
    expect(exits).toEqual([1]);
  });

  it("never exits a server that was never asked to stop", () => {
    const { exits } = harness();
    vi.advanceTimersByTime(10 * 60_000);
    expect(exits).toEqual([]);
  });

  it("starts on SIGTERM or SIGINT, and stops listening when released", () => {
    const signals = new NodeEvents.EventEmitter();
    const start = vi.fn();
    const stopListening = listenForShutdownSignals(start, signals);
    signals.emit("SIGTERM");
    signals.emit("SIGINT");
    expect(start).toHaveBeenCalledTimes(2);
    stopListening();
    signals.emit("SIGTERM");
    expect(start).toHaveBeenCalledTimes(2);
    expect(signals.listenerCount("SIGTERM") + signals.listenerCount("SIGINT")).toBe(0);
  });

  it("summarizes no open handles as nothing", () => {
    expect(summarizeActiveResources([])).toBe("nothing");
  });
});
