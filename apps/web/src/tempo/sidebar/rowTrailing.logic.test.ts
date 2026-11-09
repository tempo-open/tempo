import { describe, expect, it } from "vite-plus/test";

import type { SidebarNeedInput } from "./needsYou.logic";
import { elapsedLabelTickDelayMs, resolveSidebarRowTrailing } from "./rowTrailing.logic";

const RUN_DONE = {
  runId: "run-1" as never,
  status: "completed" as const,
  requestedAt: "2026-10-16T10:00:00.000Z",
  startedAt: "2026-10-16T10:00:01.000Z",
  completedAt: "2026-10-16T10:05:00.000Z",
  assistantMessageId: null,
};

function runtime(
  status: NonNullable<SidebarNeedInput["runtime"]>["status"],
  extra: Partial<NonNullable<SidebarNeedInput["runtime"]>> = {},
): NonNullable<SidebarNeedInput["runtime"]> {
  return {
    status,
    activeRunId: null,
    providerInstanceId: "codex" as never,
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-10-16T10:05:00.000Z",
    ...extra,
  };
}

function thread(overrides: Partial<SidebarNeedInput> = {}): SidebarNeedInput {
  return {
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    interactionMode: "default",
    latestRun: RUN_DONE,
    runtime: null,
    ...overrides,
  };
}

const VISITED_AFTER = "2026-10-16T11:00:00.000Z";
const NOT_VISITED_SINCE = "2026-10-16T09:00:00.000Z";

const RUNNING = {
  latestRun: {
    ...RUN_DONE,
    runId: "run-2" as never,
    status: "running" as const,
    startedAt: "2026-10-16T11:30:00.000Z",
    completedAt: null,
  },
  runtime: runtime("running", {
    activeRunId: "run-2" as never,
    activityStartedAt: "2026-10-16T11:30:00.000Z",
  }),
};

describe("resolveSidebarRowTrailing", () => {
  it("shows the relative time for a quiet chat", () => {
    expect(resolveSidebarRowTrailing(thread(), VISITED_AFTER)).toEqual({ kind: "time" });
  });

  it("shows a chip when the chat needs the user", () => {
    expect(resolveSidebarRowTrailing(thread({ hasPendingApprovals: true }), VISITED_AFTER)).toEqual(
      { kind: "chip", need: "approval", label: "Approval" },
    );
    expect(resolveSidebarRowTrailing(thread({ hasPendingUserInput: true }), VISITED_AFTER)).toEqual(
      { kind: "chip", need: "input", label: "Question" },
    );
    expect(resolveSidebarRowTrailing(thread(), NOT_VISITED_SINCE)).toEqual({
      kind: "chip",
      need: "done",
      label: "Done",
    });
  });

  it("shows Limit for a usage-limit failure and Failed for any other failure", () => {
    expect(
      resolveSidebarRowTrailing(
        thread({ runtime: runtime("failed", { lastErrorClass: "usage_limit" }) }),
        VISITED_AFTER,
      ),
    ).toEqual({ kind: "chip", need: "limited", label: "Limit" });
    expect(
      resolveSidebarRowTrailing(thread({ runtime: runtime("failed") }), VISITED_AFTER),
    ).toEqual({ kind: "chip", need: "failed", label: "Failed" });
  });

  it("shows the elapsed time and a spinner for a running chat", () => {
    expect(resolveSidebarRowTrailing(thread(RUNNING), VISITED_AFTER)).toEqual({
      kind: "running",
      startedAt: "2026-10-16T11:30:00.000Z",
    });
  });

  it("keeps the spinner when the run's start time is unknown", () => {
    expect(
      resolveSidebarRowTrailing(
        thread({ ...RUNNING, runtime: runtime("starting", { activeRunId: "run-2" as never }) }),
        VISITED_AFTER,
      ),
    ).toMatchObject({ kind: "running" });
  });

  it("shows a chip instead of the spinner when a running chat is blocked on the user", () => {
    expect(
      resolveSidebarRowTrailing(thread({ ...RUNNING, hasPendingApprovals: true }), VISITED_AFTER),
    ).toEqual({ kind: "chip", need: "approval", label: "Approval" });
  });

  it("shows a chip on a parent whose subagent is waiting on the user", () => {
    expect(
      resolveSidebarRowTrailing(
        thread({ ...RUNNING, pendingSubagentRequest: "user_input" }),
        VISITED_AFTER,
      ),
    ).toEqual({ kind: "chip", need: "input", label: "Question" });
  });

  it("shows the time for an idle chat holding background work", () => {
    expect(resolveSidebarRowTrailing(thread({ runtime: runtime("idle") }), VISITED_AFTER)).toEqual({
      kind: "time",
    });
  });
});

describe("elapsedLabelTickDelayMs", () => {
  it("ticks at the next second while the label shows seconds", () => {
    expect(elapsedLabelTickDelayMs(0)).toBe(1_000);
    expect(elapsedLabelTickDelayMs(12_250)).toBe(750);
    expect(elapsedLabelTickDelayMs(59_999)).toBe(1);
  });

  it("ticks once at the next whole minute after the first minute", () => {
    expect(elapsedLabelTickDelayMs(60_000)).toBe(60_000);
    expect(elapsedLabelTickDelayMs(61_000)).toBe(59_000);
    expect(elapsedLabelTickDelayMs(3_725_000)).toBe(55_000);
  });

  it("never schedules a negative or non-finite wait", () => {
    expect(elapsedLabelTickDelayMs(-5_000)).toBe(1_000);
    expect(elapsedLabelTickDelayMs(Number.NaN)).toBe(1_000);
  });
});
