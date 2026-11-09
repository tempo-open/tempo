import {
  TempoThreadMoveId,
  EnvironmentId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadRuntimeSummary } from "../state/models.ts";
import { onProductionWaitShelf, productionWaitAction } from "./productionWait.ts";

const since = "2026-10-14T09:30:00.000Z";

function thread(
  input: {
    readonly waiting?: boolean;
    readonly runtime?: ThreadRuntimeSummary["status"];
    readonly approval?: boolean;
    readonly settled?: boolean;
    readonly archived?: boolean;
    readonly subagent?: boolean;
    readonly movedAway?: boolean;
  } = {},
) {
  return {
    source: {
      ...(input.waiting === true ? { waitingForProductionSince: since } : {}),
      ...(input.movedAway === true
        ? {
            movedTo: {
              moveId: TempoThreadMoveId.make("move-1"),
              environmentId: EnvironmentId.make("studio"),
              environmentLabel: "Studio",
              threadId: ThreadId.make("moved"),
              movedAt: since,
            },
          }
        : {}),
    },
    runtime:
      input.runtime === undefined
        ? null
        : {
            status: input.runtime,
            activeRunId: input.runtime === "running" ? RunId.make("run-1") : null,
            providerInstanceId: ProviderInstanceId.make("codex"),
            providerName: null,
            lastError: null,
            updatedAt: since,
          },
    hasPendingApprovals: input.approval === true,
    hasPendingUserInput: false,
    deletedAt: null,
    archivedAt: input.archived === true ? since : null,
    settledOverride: input.settled === true ? ("settled" as const) : null,
    settledAt: input.settled === true ? since : null,
    lineage: {
      parentThreadId: input.subagent === true ? ThreadId.make("parent") : null,
      relationshipToParent: input.subagent === true ? ("subagent" as const) : null,
      rootThreadId: ThreadId.make("root"),
    },
  };
}

describe("onProductionWaitShelf", () => {
  it("shelves a waiting thread until it runs or asks for the user", () => {
    expect(onProductionWaitShelf(thread({ waiting: true }))).toBe(true);
    expect(onProductionWaitShelf(thread({ waiting: true, runtime: "completed" }))).toBe(true);
    // Working stays visible as working, and a question needs the user.
    expect(onProductionWaitShelf(thread({ waiting: true, runtime: "running" }))).toBe(false);
    expect(onProductionWaitShelf(thread({ waiting: true, approval: true }))).toBe(false);
    expect(
      onProductionWaitShelf({ ...thread({ waiting: true }), pendingSubagentRequest: "user_input" }),
    ).toBe(false);
    expect(onProductionWaitShelf(thread())).toBe(false);
  });
});

describe("productionWaitAction", () => {
  it("offers stop while waiting and start where a thread may wait", () => {
    expect(productionWaitAction(thread({ waiting: true }))).toBe("stop");
    expect(productionWaitAction(thread())).toBe("start");
    // A running thread can start waiting: the agent calls the tool mid-turn.
    expect(productionWaitAction(thread({ runtime: "running" }))).toBe("start");
  });

  it("offers nothing to threads that cannot wait", () => {
    expect(productionWaitAction(thread({ settled: true }))).toBeNull();
    expect(productionWaitAction(thread({ archived: true }))).toBeNull();
    expect(productionWaitAction(thread({ subagent: true }))).toBeNull();
    expect(productionWaitAction(thread({ movedAway: true }))).toBeNull();
  });
});
