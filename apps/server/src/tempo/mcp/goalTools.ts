/**
 * tempo: the agent's way to set, finish or block a thread goal. It calls the same
 * `TempoGoals.update` as the goal banner's RPC.
 */
import {
  TEMPO_GOAL_MAX_TURNS,
  TempoGoal,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as TempoGoals from "../goal/TempoGoals.ts";

const UpdateGoalTool = Tool.make("update_goal", {
  description: `Set, finish or block a thread's goal: work to keep doing across turns until it is done. While a goal is active, ${TEMPO_APP_BASE_NAME} starts another turn each time you end one, up to ${TEMPO_GOAL_MAX_TURNS} in a row. The user sets goals with /goal and sees the goal above the composer. Pass objective to set a new goal, for example when the user asks you to keep going until something is done; it replaces the current one, and the turns start once you end this one. Once the goal is done, pass status "complete" with a short note on the outcome. When you can't go on without the user, pass status "blocked" with a note saying what you need, then say it in your reply too and end your turn. status "active" resumes a paused or blocked goal. Pass neither objective nor status to read the goal. Omit threadId for this thread.`,
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({ description: "Thread to change. Omit for this thread." }),
    ),
    objective: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "A new goal, replacing the current one. Starts active.",
      }),
    ),
    status: Schema.optional(
      Schema.Literals(["active", "complete", "blocked"]).annotate({
        description:
          "complete when the goal is done, blocked when you need the user, active to resume.",
      }),
    ),
    note: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "With complete or blocked: the outcome, or what you need. Shown with the goal.",
      }),
    ),
  }),
  success: Schema.Struct({
    goal: Schema.NullOr(TempoGoal),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    TempoGoals.TempoGoals,
  ],
})
  .annotate(Tool.Title, "Update goal")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const TempoGoalToolkit = Toolkit.make(UpdateGoalTool);
