import {
  OrchestratorMcpFailure,
  type TempoGoal,
  type TempoGoalChange,
  type TempoGoalError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readThread } from "../../mcp/threadAccess.ts";
import * as TempoGoals from "../goal/TempoGoals.ts";
import { TempoGoalToolkit } from "./goalTools.ts";

/** Every message here is written for the agent and says what to do next. */
const toFailure = (error: TempoGoalError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "TempoGoalFailedError"
        ? "orchestration_error"
        : error.reason === "notFound"
          ? "thread_not_found"
          : "invalid_request",
    message: error.message,
  });

function changeFor(input: {
  readonly objective?: string | undefined;
  readonly status?: "active" | "complete" | "blocked" | undefined;
  readonly note?: string | undefined;
}): TempoGoalChange | null {
  if (input.objective !== undefined) return { type: "set", objective: input.objective };
  const note = input.note === undefined ? {} : { note: input.note };
  switch (input.status) {
    case undefined:
      return null;
    case "active":
      return { type: "resume" };
    case "complete":
      return { type: "complete", ...note };
    case "blocked":
      return { type: "block", ...note };
  }
}

function describeGoal(goal: TempoGoal | null): string {
  switch (goal?.status) {
    case undefined:
      return "This thread has no goal.";
    case "active":
    case "usage_limited":
      return "The goal is active: keep working toward it. When you end your turn, the next one starts.";
    case "paused":
      return "The goal is paused. No turns start until it is resumed.";
    case "blocked":
      return "The goal is blocked. Tell the user what you need in your reply, then end your turn.";
    case "complete":
      return "The goal is complete. Sum up the outcome for the user, then end your turn.";
  }
}

export const layer = McpToolAccess.toLayer(TempoGoalToolkit, {
  update_goal: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const change = changeFor(input);
        if (change === null) {
          const goal = projection.thread.tempoGoal ?? null;
          return { goal, message: describeGoal(goal) };
        }
        const goals = yield* TempoGoals.TempoGoals;
        const { goal } = yield* goals
          .update({ threadId: projection.thread.id, change })
          .pipe(Effect.mapError(toFailure));
        return { goal, message: describeGoal(goal) };
      }),
  ),
});
