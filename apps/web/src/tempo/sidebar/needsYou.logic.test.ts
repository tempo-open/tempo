import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_ROUTE_NEEDS_HOLD,
  isNeedsYouWhileOpen,
  isSidebarThreadRunning,
  nextRouteNeedsHold,
  resolveSidebarNeed,
  staysInSidebarList,
  type SidebarNeedInput,
} from "./needsYou.logic";

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

const NOT_VISITED_SINCE = "2026-10-16T09:00:00.000Z";
const VISITED_AFTER = "2026-10-16T11:00:00.000Z";

describe("resolveSidebarNeed", () => {
  it("returns nothing for a finished chat the user has already seen", () => {
    expect(resolveSidebarNeed(thread(), VISITED_AFTER)).toBeNull();
  });

  it("maps a pending approval to approval", () => {
    expect(resolveSidebarNeed(thread({ hasPendingApprovals: true }), VISITED_AFTER)).toBe(
      "approval",
    );
  });

  it("maps pending user input to input", () => {
    expect(resolveSidebarNeed(thread({ hasPendingUserInput: true }), VISITED_AFTER)).toBe("input");
  });

  it("bubbles a subagent's approval request to the parent", () => {
    expect(resolveSidebarNeed(thread({ pendingSubagentRequest: "approval" }), VISITED_AFTER)).toBe(
      "approval",
    );
  });

  it("bubbles a subagent's question to the parent", () => {
    expect(
      resolveSidebarNeed(thread({ pendingSubagentRequest: "user_input" }), VISITED_AFTER),
    ).toBe("input");
  });

  it("puts approval ahead of input", () => {
    expect(
      resolveSidebarNeed(
        thread({ hasPendingApprovals: true, hasPendingUserInput: true }),
        VISITED_AFTER,
      ),
    ).toBe("approval");
  });

  it("maps an actionable proposed plan on a settled plan-mode run to plan", () => {
    expect(
      resolveSidebarNeed(
        thread({ interactionMode: "plan", hasActionableProposedPlan: true }),
        VISITED_AFTER,
      ),
    ).toBe("plan");
  });

  it("does not show plan outside plan mode", () => {
    expect(
      resolveSidebarNeed(thread({ hasActionableProposedPlan: true }), VISITED_AFTER),
    ).toBeNull();
  });

  it("maps a failed run to failed", () => {
    expect(resolveSidebarNeed(thread({ runtime: runtime("failed") }), VISITED_AFTER)).toBe(
      "failed",
    );
  });

  it("maps a usage-limit failure to limited", () => {
    expect(
      resolveSidebarNeed(
        thread({ runtime: runtime("failed", { lastErrorClass: "usage_limit" }) }),
        VISITED_AFTER,
      ),
    ).toBe("limited");
  });

  it("maps a completion the user has not visited to done", () => {
    expect(resolveSidebarNeed(thread(), NOT_VISITED_SINCE)).toBe("done");
  });

  it("does not call a completion done when the visit time is unknown", () => {
    expect(resolveSidebarNeed(thread(), undefined)).toBeNull();
  });

  it("counts a reply the user has not read beside a watch, not while a subagent runs", () => {
    const watching = thread({
      runtime: runtime("idle"),
      pendingBackgroundTasks: [{ taskId: "watch-1", kind: "monitor" }],
    });
    expect(resolveSidebarNeed(watching, NOT_VISITED_SINCE)).toBe("done");
    expect(resolveSidebarNeed(watching, VISITED_AFTER)).toBeNull();
    // The agent's own subagent still runs: its reply is not the end of the work.
    const delegating = thread({
      runtime: runtime("idle"),
      pendingBackgroundTasks: [{ taskId: "agent-1", kind: "subagent" }],
    });
    expect(resolveSidebarNeed(delegating, NOT_VISITED_SINCE)).toBeNull();
  });

  it("never counts a running chat", () => {
    expect(
      resolveSidebarNeed(
        thread({ runtime: runtime("running", { activeRunId: "run-2" as never }) }),
        NOT_VISITED_SINCE,
      ),
    ).toBeNull();
  });

  it("still counts a running chat that is blocked on an approval", () => {
    expect(
      resolveSidebarNeed(
        thread({
          hasPendingApprovals: true,
          runtime: runtime("running", { activeRunId: "run-2" as never }),
        }),
        NOT_VISITED_SINCE,
      ),
    ).toBe("approval");
  });
});

describe("staysInSidebarList", () => {
  const hold = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", "done");

  it("never keeps a chat in the list when the new sidebar is off", () => {
    for (const need of ["done", "approval", null] as const) {
      expect(staysInSidebarList({ isSidebarV2: false, need, isOpen: false, hold })).toBe(false);
      expect(staysInSidebarList({ isSidebarV2: false, need, isOpen: true, hold })).toBe(false);
    }
  });

  it("keeps a chat that needs the user in the list when the new sidebar is on", () => {
    expect(staysInSidebarList({ isSidebarV2: true, need: "done", isOpen: false, hold })).toBe(true);
    expect(staysInSidebarList({ isSidebarV2: true, need: null, isOpen: false, hold })).toBe(false);
  });

  it("holds only the open chat", () => {
    expect(staysInSidebarList({ isSidebarV2: true, need: null, isOpen: true, hold })).toBe(true);
    expect(staysInSidebarList({ isSidebarV2: true, need: null, isOpen: false, hold })).toBe(false);
  });
});

describe("the open chat keeps its place", () => {
  // The visit that ChatView records on open clears the Done need at once; the sidebar must not
  // move the row into Waiting, or "next thread" and settle-and-advance start from the wrong
  // neighbour.
  const openedDone = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", "done");
  const visitedNeed = resolveSidebarNeed(thread(), VISITED_AFTER);

  it("holds a Done chat after the visit clears its need", () => {
    expect(openedDone.isDoneHeld).toBe(true);
    expect(visitedNeed).toBeNull();
    expect(isNeedsYouWhileOpen(visitedNeed, openedDone)).toBe(true);
  });

  it("keeps holding it across further renders of the same route", () => {
    const again = nextRouteNeedsHold(openedDone, "env:a", visitedNeed);
    expect(again).toBe(openedDone);
  });

  it("releases the hold when the route moves to another chat", () => {
    const moved = nextRouteNeedsHold(
      openedDone,
      "env:b",
      resolveSidebarNeed(thread(), VISITED_AFTER),
    );
    expect(moved.isDoneHeld).toBe(false);
    expect(isNeedsYouWhileOpen(null, moved)).toBe(false);
  });

  it("releases a Done hold once a follow-up starts a run", () => {
    const running = thread({ runtime: runtime("running", { activeRunId: "run-2" as never }) });
    expect(isSidebarThreadRunning(running)).toBe(true);
    expect(isSidebarThreadRunning(thread())).toBe(false);
    const released = nextRouteNeedsHold(openedDone, "env:a", null, isSidebarThreadRunning(running));
    expect(released.isDoneHeld).toBe(false);
    expect(isNeedsYouWhileOpen(null, released)).toBe(false);
    // Its own completion is seen as it lands, so the finished run does not re-file it.
    expect(isNeedsYouWhileOpen("done", released)).toBe(false);
  });

  it("does not hold a chat you opened when it did not need you", () => {
    const hold = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", null);
    expect(isNeedsYouWhileOpen(null, hold)).toBe(false);
  });

  it("does not count the chat you are watching as needing you when its turn finishes", () => {
    const hold = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", null);
    const finished = resolveSidebarNeed(thread(), NOT_VISITED_SINCE);
    expect(finished).toBe("done");
    expect(isNeedsYouWhileOpen(finished, hold)).toBe(false);
  });

  it("still counts the open chat when it asks for approval", () => {
    const hold = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", null);
    expect(isNeedsYouWhileOpen("approval", hold)).toBe(true);
  });
});
