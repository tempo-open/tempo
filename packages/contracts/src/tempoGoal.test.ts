import { describe, expect, it } from "@effect/vitest";

import {
  tempoGoalForShell,
  tempoGoalRefusal,
  parseTempoGoalCommand,
  type TempoGoal,
} from "./tempoGoal.ts";

describe("parseTempoGoalCommand", () => {
  it("reads the control words, and anything else as the objective", () => {
    expect(parseTempoGoalCommand("/goal")).toEqual({ type: "show" });
    expect(parseTempoGoalCommand(" /goal Pause ")).toEqual({ type: "pause" });
    expect(parseTempoGoalCommand("/goal resume")).toEqual({ type: "resume" });
    expect(parseTempoGoalCommand("/goal clear")).toEqual({ type: "clear" });
    expect(parseTempoGoalCommand("/goal fix the\nflaky tests")).toEqual({
      type: "set",
      objective: "fix the\nflaky tests",
    });
  });

  it("leaves other messages alone", () => {
    expect(parseTempoGoalCommand("/goals")).toBeNull();
    expect(parseTempoGoalCommand("set a /goal")).toBeNull();
  });
});

describe("tempoGoalRefusal", () => {
  const goal: TempoGoal = {
    objective: "ship it",
    status: "complete",
    turns: 3,
    setAt: "2026-10-20T00:00:00Z",
  };

  it("needs a goal for every change but setting and clearing one", () => {
    expect(tempoGoalRefusal(null, { type: "set", objective: "ship it" })).toBeNull();
    expect(tempoGoalRefusal(null, { type: "clear" })).toBeNull();
    expect(tempoGoalRefusal(null, { type: "pause" })).toBe("noGoal");
    expect(tempoGoalRefusal(null, { type: "complete" })).toBe("noGoal");
  });

  it("does not resume a finished goal", () => {
    expect(tempoGoalRefusal({ ...goal, status: "complete" }, { type: "resume" })).toBe("complete");
    expect(tempoGoalRefusal({ ...goal, status: "blocked" }, { type: "resume" })).toBeNull();
  });
});

describe("tempoGoalForShell", () => {
  it("shows the note where the goal banner reads a provider's last check", () => {
    expect(
      tempoGoalForShell({
        objective: "ship it",
        status: "blocked",
        note: "Needs the staging password",
        turns: 4,
        setAt: "2026-10-20T00:00:00Z",
      }),
    ).toEqual({ objective: "ship it", status: "blocked", lastCheck: "Needs the staging password" });
    expect(tempoGoalForShell(undefined)).toBeNull();
  });
});
