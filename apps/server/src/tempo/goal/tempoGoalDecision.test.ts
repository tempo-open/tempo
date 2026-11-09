import { TEMPO_GOAL_MAX_TURNS, type TempoGoal } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { decideTempoGoal, pauseGoal } from "./tempoGoalDecision.ts";

const setAt = "2026-10-20T10:00:00.000Z";
const now = "2026-10-20T11:00:00.000Z";
const active: TempoGoal = { objective: "Ship the router", status: "active", turns: 3, setAt };

describe("decideTempoGoal", () => {
  it("sets a new goal without queueing: the message that set it is its first turn", () => {
    expect(
      decideTempoGoal({
        goal: active,
        change: { type: "set", objective: "Fix the flaky tests" },
        busy: false,
        now,
      }),
    ).toEqual({
      goal: { objective: "Fix the flaky tests", status: "active", turns: 0, setAt: now },
      queueTurn: false,
    });
  });

  it("queues the next turn only while the thread is idle", () => {
    expect(
      decideTempoGoal({ goal: active, change: { type: "continue", setAt }, busy: false, now }),
    ).toEqual({ goal: { ...active, turns: 4 }, queueTurn: true });
    expect(
      decideTempoGoal({ goal: active, change: { type: "continue", setAt }, busy: true, now }),
    ).toEqual({ goal: active, queueTurn: false });
  });

  it("ignores a continue for a goal that was replaced, paused or finished", () => {
    const stale = decideTempoGoal({
      goal: active,
      change: { type: "continue", setAt: "2026-10-19T10:00:00.000Z" },
      busy: false,
      now,
    });
    expect(stale).toEqual({ goal: active, queueTurn: false });
    for (const status of ["paused", "blocked", "complete"] as const) {
      const goal = { ...active, status };
      expect(
        decideTempoGoal({ goal, change: { type: "continue", setAt }, busy: false, now }),
      ).toEqual({ goal, queueTurn: false });
    }
  });

  it("picks a goal held by a usage limit back up once a turn ends well", () => {
    expect(
      decideTempoGoal({
        goal: { ...active, status: "usage_limited" },
        change: { type: "continue", setAt },
        busy: false,
        now,
      }),
    ).toEqual({ goal: { ...active, turns: 4 }, queueTurn: true });
  });

  it("pauses after the most turns in a row, until resumed", () => {
    const tired = { ...active, turns: TEMPO_GOAL_MAX_TURNS };
    const decision = decideTempoGoal({
      goal: tired,
      change: { type: "continue", setAt },
      busy: false,
      now,
    });
    expect(decision).toEqual({
      goal: {
        ...tired,
        status: "paused",
        note: `Paused after ${TEMPO_GOAL_MAX_TURNS} turns in a row. Resume to keep going.`,
      },
      queueTurn: false,
    });
    if ("refusal" in decision || decision.goal === null) return;
    expect(
      decideTempoGoal({ goal: decision.goal, change: { type: "resume" }, busy: false, now }),
    ).toEqual({ goal: { ...active, turns: 1 }, queueTurn: true });
  });

  it("keeps the agent's note on a blocked or complete goal, and drops it on resume", () => {
    const blocked = decideTempoGoal({
      goal: active,
      change: { type: "block", note: "Needs the staging password" },
      busy: true,
      now,
    });
    expect(blocked).toEqual({
      goal: { ...active, status: "blocked", note: "Needs the staging password" },
      queueTurn: false,
    });
    if ("refusal" in blocked || blocked.goal === null) return;
    // Resumed mid-turn: the running turn's end continues the goal.
    expect(
      decideTempoGoal({ goal: blocked.goal, change: { type: "resume" }, busy: true, now }),
    ).toEqual({ goal: { ...active, turns: 0 }, queueTurn: false });
  });

  it("holds an active goal after a failed turn, but not a stale one", () => {
    expect(
      decideTempoGoal({
        goal: active,
        change: { type: "halt", setAt, status: "usage_limited" },
        busy: false,
        now,
      }),
    ).toEqual({ goal: { ...active, status: "usage_limited" }, queueTurn: false });
    const paused = { ...active, status: "paused" as const };
    expect(
      decideTempoGoal({
        goal: paused,
        change: { type: "halt", setAt, status: "paused", note: "A turn failed." },
        busy: false,
        now,
      }),
    ).toEqual({ goal: paused, queueTurn: false });
  });

  it("refuses changes that need a goal when there is none", () => {
    expect(
      decideTempoGoal({ goal: null, change: { type: "pause" }, busy: false, now }),
    ).toHaveProperty("refusal");
    expect(decideTempoGoal({ goal: null, change: { type: "clear" }, busy: false, now })).toEqual({
      goal: null,
      queueTurn: false,
    });
  });
});

describe("pauseGoal", () => {
  it("pauses a pursued goal and leaves others as they are", () => {
    expect(pauseGoal({ tempoGoal: active })).toEqual({
      tempoGoal: { ...active, status: "paused" },
    });
    expect(pauseGoal({ tempoGoal: { ...active, status: "blocked" } })).toEqual({});
    expect(pauseGoal({ tempoGoal: null })).toEqual({});
  });
});
