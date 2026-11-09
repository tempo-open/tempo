/**
 * tempo: thread goals (`tempoGoal.ts` in contracts). The orchestrator's decisions
 * about a goal, and the messages that carry it to the agent.
 *
 * @module tempoGoalDecision
 */
import {
  TEMPO_GOAL_MAX_TURNS,
  tempoGoalRefusal,
  tempoGoalRefusalMessage,
  type TempoGoal,
  type TempoGoalChange,
  type OrchestrationV2Notification,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";

/** What the agent reads for the user's `/goal <objective>`; the message shows it too. */
export function goalKickoffText(objective: string): string {
  return `Goal: ${objective}\n\nKeep working until this is done. Each time you end a turn while the goal is active, ${TEMPO_APP_BASE_NAME} starts another. When it is done, call update_goal with status "complete". If you can't go on without me, call it with status "blocked" and say why.`;
}

/** The message that starts the next turn toward an active goal, after `goal.turns` was counted. */
export function goalContinuationText(goal: TempoGoal): string {
  return `Keep working toward the goal: ${goal.objective}\n\nThe goal is still active, so ${TEMPO_APP_BASE_NAME} started this turn (${goal.turns} of ${TEMPO_GOAL_MAX_TURNS} in a row). Carry on from where you stopped. When the goal is done, call update_goal with status "complete". If you can't go on without the user, call it with status "blocked" and say why.`;
}

export const GOAL_CONTINUATION_NOTIFICATION: OrchestrationV2Notification = {
  source: { kind: "system" },
  outcome: "updated",
  summary: "Continuing toward the goal",
};

/** Whether the reactor still works toward `goal`: a usage limit only holds it until a turn ends well. */
export function isGoalPursued(goal: TempoGoal | null | undefined): goal is TempoGoal {
  return goal?.status === "active" || goal?.status === "usage_limited";
}

const settle = (goal: TempoGoal, status: TempoGoal["status"], note?: string): TempoGoal => {
  const { note: _previous, ...rest } = goal;
  return note === undefined ? { ...rest, status } : { ...rest, status, note };
};

export type TempoGoalDecision =
  | { readonly refusal: string }
  | { readonly goal: TempoGoal | null; readonly queueTurn: boolean };

/**
 * The goal a change leaves, and whether to queue the next turn toward it as
 * the command's message. `busy` says the thread has a run queued or going:
 * its end continues the goal, so a resume or continue queues nothing then.
 * A continue or halt for a goal that was replaced or stopped changes nothing.
 */
export function decideTempoGoal(input: {
  readonly goal: TempoGoal | null;
  readonly change: TempoGoalChange;
  readonly busy: boolean;
  /** ISO time; becomes a new goal's `setAt`. */
  readonly now: string;
}): TempoGoalDecision {
  const { goal, change, busy, now } = input;
  const refusal = tempoGoalRefusal(goal, change);
  if (refusal !== null) return { refusal: tempoGoalRefusalMessage(refusal) };
  if (change.type === "set") {
    return {
      goal: { objective: change.objective, status: "active", turns: 0, setAt: now },
      queueTurn: false,
    };
  }
  if (change.type === "clear" || goal === null) return { goal: null, queueTurn: false };
  const unchanged = { goal, queueTurn: false };
  switch (change.type) {
    case "pause":
      return { goal: settle(goal, "paused"), queueTurn: false };
    case "resume":
      return { goal: { ...settle(goal, "active"), turns: busy ? 0 : 1 }, queueTurn: !busy };
    case "block":
      return { goal: settle(goal, "blocked", change.note), queueTurn: false };
    case "complete":
      return { goal: settle(goal, "complete", change.note), queueTurn: false };
    case "continue":
      if (goal.setAt !== change.setAt || !isGoalPursued(goal) || busy) return unchanged;
      if (goal.turns >= TEMPO_GOAL_MAX_TURNS) {
        return {
          goal: settle(
            goal,
            "paused",
            `Paused after ${TEMPO_GOAL_MAX_TURNS} turns in a row. Resume to keep going.`,
          ),
          queueTurn: false,
        };
      }
      return { goal: { ...settle(goal, "active"), turns: goal.turns + 1 }, queueTurn: true };
    case "halt":
      if (goal.setAt !== change.setAt || goal.status !== "active") return unchanged;
      return { goal: settle(goal, change.status, change.note), queueTurn: false };
  }
}

/**
 * Stopping a turn, settling or archiving pauses the goal, so the stopped turn's
 * end does not start another and the goal does not read as pursued.
 */
export function pauseGoal(thread: { readonly tempoGoal?: TempoGoal | null | undefined }): {
  readonly tempoGoal?: TempoGoal;
} {
  return isGoalPursued(thread.tempoGoal) ? { tempoGoal: settle(thread.tempoGoal, "paused") } : {};
}

/** Forking a thread starts a new conversation, which does not inherit the goal. */
export function dropGoal(thread: { readonly tempoGoal?: TempoGoal | null | undefined }): {
  readonly tempoGoal?: null;
} {
  return thread.tempoGoal == null ? {} : { tempoGoal: null };
}
