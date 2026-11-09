import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { SidebarSection } from "../../components/Sidebar.logic";
import { makeThreadFixture } from "../../test-fixtures";
import type { Thread } from "../../types";
import { EMPTY_ROUTE_NEEDS_HOLD, nextRouteNeedsHold, type RouteNeedsHold } from "./needsYou.logic";
import {
  estimateSidebarRowHeight,
  resolveSidebarRowSection,
  resolveSidebarRowVariant,
  shouldRulePinnedRows,
} from "./sidebarV2.logic";

const SECTIONS: readonly SidebarSection[] = [
  "pinned",
  "active",
  "working",
  "background",
  "snoozed",
  "waiting",
  "settled",
];

describe("resolveSidebarRowVariant", () => {
  it("keeps T3's cards for live sections and slim rows elsewhere when off", () => {
    expect(resolveSidebarRowVariant("active", false, false)).toBe("card");
    expect(resolveSidebarRowVariant("background", false, false)).toBe("card");
    expect(resolveSidebarRowVariant("settled", false, false)).toBe("slim");
  });

  it("shows one-line rows for live sections when on, and keeps the shelves slim", () => {
    expect(SECTIONS.map((section) => resolveSidebarRowVariant(section, true, false))).toEqual([
      "line",
      "line",
      "line",
      "line",
      "slim",
      "slim",
      "slim",
    ]);
  });
});

const COMPLETED_AT = "2026-10-16T10:05:00.000Z";
const VISITED_BEFORE = "2026-10-16T09:00:00.000Z";
const VISITED_AFTER = "2026-10-16T11:00:00.000Z";

/** A finished turn whose agent still watches a pull request, read unless overridden. */
function watching(overrides: Partial<Thread> = {}): Thread {
  return makeThreadFixture({
    latestRun: {
      runId: "run-1" as never,
      status: "completed",
      requestedAt: "2026-10-16T10:00:00.000Z",
      startedAt: "2026-10-16T10:00:01.000Z",
      completedAt: COMPLETED_AT,
      assistantMessageId: null,
    },
    runtime: {
      status: "idle",
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: "Codex",
      lastError: null,
      updatedAt: COMPLETED_AT,
    },
    pendingBackgroundTasks: [{ taskId: "watch-1", description: "Watch #12", kind: "monitor" }],
    lastVisitedAt: VISITED_AFTER,
    ...overrides,
  });
}

function filed(
  thread: Thread,
  options: {
    readonly isSidebarV2: boolean;
    readonly workingShelfEnabled?: boolean;
    readonly snoozed?: boolean;
    readonly settled?: boolean;
    readonly isOpen?: boolean;
    readonly hold?: RouteNeedsHold;
    readonly productionWaitShelfEnabled?: boolean;
  },
) {
  return resolveSidebarRowSection({
    thread,
    isSidebarV2: options.isSidebarV2,
    workingShelfEnabled: options.workingShelfEnabled ?? true,
    lastVisitedAt: thread.lastVisitedAt ?? undefined,
    isOpen: options.isOpen ?? false,
    hold: options.hold ?? EMPTY_ROUTE_NEEDS_HOLD,
    snoozed: options.snoozed ?? false,
    settled: options.settled ?? false,
    productionWaitShelfEnabled: options.productionWaitShelfEnabled ?? true,
  });
}

const kept = { section: "active", needsYou: true };
const question = watching({ hasPendingUserInput: true });
const done = watching({ lastVisitedAt: VISITED_BEFORE });
const approval = watching({ hasPendingApprovals: true });
const read = watching();
const running = watching({
  runtime: { ...read.runtime!, status: "running", activeRunId: "run-2" as never },
  pendingBackgroundTasks: [],
});
const waitsForProduction = (thread: Thread): Thread => ({
  ...thread,
  source: { ...thread.source, waitingForProductionSince: "2026-10-16T10:06:00.000Z" },
});
const waitingForProduction = waitsForProduction(done);

describe("resolveSidebarRowSection", () => {
  it("keeps a Question, Done or Approval chat waiting on a watch in the list", () => {
    for (const thread of [question, done, approval]) {
      expect(filed(thread, { isSidebarV2: true })).toEqual(kept);
      expect(filed(thread, { isSidebarV2: true, workingShelfEnabled: false })).toEqual(kept);
    }
    // Once nothing needs you, the watch folds it into Waiting as before.
    expect(filed(read, { isSidebarV2: true })).toEqual({ section: "background", needsYou: false });
  });

  it("keeps the open chat where it was after its visit clears Done, until the route moves on", () => {
    const hold = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", "done");
    expect(filed(read, { isSidebarV2: true, isOpen: true, hold })).toEqual(kept);
    expect(filed(read, { isSidebarV2: true, isOpen: false, hold })).toEqual({
      section: "background",
      needsYou: false,
    });
  });

  it("files a chat waiting for production under Waiting for Production, whatever it needs", () => {
    for (const isSidebarV2 of [true, false]) {
      expect(filed(waitingForProduction, { isSidebarV2 })).toEqual({
        section: "waiting",
        needsYou: false,
      });
    }
  });

  it("with that section off, files a waiting chat where it would sit without the wait", () => {
    const off = { isSidebarV2: true, productionWaitShelfEnabled: false };
    const idle = makeThreadFixture();
    expect(filed(waitsForProduction(idle), off)).toEqual({ section: "active", needsYou: false });
    expect(filed(waitingForProduction, off)).toEqual(kept);
    const pinned = waitsForProduction({ ...idle, pinnedAt: COMPLETED_AT });
    expect(filed(pinned, off).section).toBe("pinned");
    expect(filed(waitsForProduction(idle), { ...off, snoozed: true }).section).toBe("snoozed");
    expect(filed(waitsForProduction(idle), { ...off, isSidebarV2: false }).section).toBe("active");
  });

  it("files a chat a bot launched like any other, in both sidebars", () => {
    const idle = makeThreadFixture();
    const byBot = { ...idle, source: { ...idle.source, tempoLaunchedBy: "Release bot" } };
    for (const isSidebarV2 of [true, false]) {
      expect(filed(byBot, { isSidebarV2 })).toEqual({ section: "active", needsYou: false });
    }
  });

  it("leaves pinned, snoozed and settled chats where they are when they need you", () => {
    expect(filed({ ...question, pinnedAt: COMPLETED_AT }, { isSidebarV2: true })).toEqual({
      section: "pinned",
      needsYou: false,
    });
    expect(filed(question, { isSidebarV2: true, snoozed: true }).section).toBe("snoozed");
    expect(filed(question, { isSidebarV2: true, settled: true }).section).toBe("settled");
  });

  it("files every chat as T3's sidebar does with the switch off", () => {
    const cases: ReadonlyArray<readonly [Thread, SidebarSection]> = [
      [running, "working"],
      [read, "background"],
      [question, "active"],
      [done, "active"],
      [approval, "active"],
      [waitingForProduction, "waiting"],
      [{ ...question, pinnedAt: COMPLETED_AT }, "pinned"],
    ];
    for (const [thread, section] of cases) {
      expect(filed(thread, { isSidebarV2: false })).toEqual({ section, needsYou: false });
    }
    // Without the Working section, every chat outside Pinned and the parked shelves is listed.
    for (const thread of [running, read, question, done, approval]) {
      expect(filed(thread, { isSidebarV2: false, workingShelfEnabled: false }).section).toBe(
        "active",
      );
    }
    // The open chat is held only in the opt-in sidebar.
    const hold = nextRouteNeedsHold(EMPTY_ROUTE_NEEDS_HOLD, "env:a", "done");
    expect(filed(read, { isSidebarV2: false, isOpen: true, hold }).section).toBe("background");
  });
});

describe("shouldRulePinnedRows", () => {
  it("rules pinned rows off from the list only in the opt-in sidebar, when both have rows", () => {
    const both = { hasPinnedThreads: true, hasActiveThreads: true };
    expect(shouldRulePinnedRows({ ...both, isSidebarV2: true })).toBe(true);
    expect(shouldRulePinnedRows({ ...both, isSidebarV2: false })).toBe(false);
    expect(shouldRulePinnedRows({ ...both, isSidebarV2: true, hasActiveThreads: false })).toBe(
      false,
    );
    expect(shouldRulePinnedRows({ ...both, isSidebarV2: true, hasPinnedThreads: false })).toBe(
      false,
    );
  });
});

describe("estimateSidebarRowHeight", () => {
  it("reserves 36px plus 28px per nested sub chat row for a one-line or slim row", () => {
    const estimate = (variant: "slim" | "line", nestedRowCount: number) =>
      estimateSidebarRowHeight({ variant, nestedRowCount, isTempoLook: false });
    expect(estimate("line", 0)).toBe(36);
    expect(estimate("line", 3)).toBe(120);
    expect(estimate("slim", 2)).toBe(92);
  });

  it("leaves T3's cards to their own intrinsic size", () => {
    expect(
      estimateSidebarRowHeight({ variant: "card", nestedRowCount: 0, isTempoLook: false }),
    ).toBeNull();
  });
});
