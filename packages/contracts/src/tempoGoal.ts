/**
 * tempo: thread goals. While a `/goal` is active, each turn that ends starts another until the agent
 * marks it complete or blocked (`update_goal`), the user pauses or clears it, a turn is stopped or
 * fails, or `TEMPO_GOAL_MAX_TURNS` ran in a row. Tempo owns `/goal` on every provider in place of Codex's
 * and Claude Code's; it is stored as `tempoGoal` and reaches clients as the thread shell's `goal`.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { OrchestrationV2ProviderGoal } from "./orchestrationV2.ts";
import type { ServerProviderSlashCommand } from "./server.ts";

export const TempoGoalStatus = Schema.Literals([
  "active",
  "paused",
  "blocked",
  "usage_limited",
  "complete",
]);
export type TempoGoalStatus = typeof TempoGoalStatus.Type;

export const TempoGoal = Schema.Struct({
  objective: TrimmedNonEmptyString,
  status: TempoGoalStatus,
  /** Why the goal is blocked or paused, or what finished it; shown with the goal. */
  note: Schema.optional(TrimmedNonEmptyString),
  /** Turns Tempo started toward the goal since it was set or last resumed. */
  turns: NonNegativeInt,
  /** When the goal was set. The reactor names it, so a reaction to a replaced goal changes nothing. */
  setAt: IsoDateTime,
});
export type TempoGoal = typeof TempoGoal.Type;

/** After this many turns in a row that Tempo started, the goal pauses until resumed. */
export const TEMPO_GOAL_MAX_TURNS = 50;

/** A change to a thread's goal. `continue` and `halt` are the reactor's, after a run ended. */
export const TempoGoalChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("set"), objective: TrimmedNonEmptyString }),
  Schema.Struct({ type: Schema.Literal("pause") }),
  Schema.Struct({ type: Schema.Literal("resume") }),
  Schema.Struct({ type: Schema.Literal("clear") }),
  Schema.Struct({ type: Schema.Literal("block"), note: Schema.optional(TrimmedNonEmptyString) }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    note: Schema.optional(TrimmedNonEmptyString),
  }),
  Schema.Struct({ type: Schema.Literal("continue"), setAt: IsoDateTime }),
  Schema.Struct({
    type: Schema.Literal("halt"),
    setAt: IsoDateTime,
    status: Schema.Literals(["paused", "usage_limited"]),
    note: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type TempoGoalChange = typeof TempoGoalChange.Type;

export type TempoGoalCommand =
  | { readonly type: "show" }
  | { readonly type: "pause" }
  | { readonly type: "resume" }
  | { readonly type: "clear" }
  | { readonly type: "set"; readonly objective: string };

/** Reads `/goal`, `/goal pause|resume|clear` and `/goal <objective>`; null for any other text. */
export function parseTempoGoalCommand(text: string): TempoGoalCommand | null {
  const match = /^\/goal(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (match === null) return null;
  const argument = (match[1] ?? "").trim();
  switch (argument.toLowerCase()) {
    case "":
      return { type: "show" };
    case "pause":
      return { type: "pause" };
    case "resume":
      return { type: "resume" };
    case "clear":
      return { type: "clear" };
    default:
      return { type: "set", objective: argument };
  }
}

/** The thread shell's `goal` for a Tempo goal: the shape the goal banner, sidebar and mobile read. */
export function tempoGoalForShell(
  goal: TempoGoal | null | undefined,
): OrchestrationV2ProviderGoal | null {
  if (goal == null) return null;
  return {
    objective: goal.objective,
    status: goal.status,
    ...(goal.note === undefined ? {} : { lastCheck: goal.note }),
  };
}

/** Tempo's `/goal`, listed for every provider in place of the provider's own. */
export const TEMPO_GOAL_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "goal",
  description: "Set a goal the agent keeps working toward until it is done",
  input: { hint: "Objective, or pause, resume, clear" },
};

/** Why a goal change is refused. */
export const TempoGoalRefusal = Schema.Literals(["notFound", "movedAway", "noGoal", "complete"]);
export type TempoGoalRefusal = typeof TempoGoalRefusal.Type;

const REFUSAL_MESSAGES: Record<TempoGoalRefusal, string> = {
  notFound: "This thread no longer exists.",
  movedAway: "This thread moved to another machine. Change its goal from its copy there.",
  noGoal: "This thread has no goal. Set one with /goal and what to get done.",
  complete: "The goal is complete. Set a new one with /goal and what to get done.",
};

export function tempoGoalRefusalMessage(reason: TempoGoalRefusal): string {
  return REFUSAL_MESSAGES[reason];
}

/** Why `change` cannot apply to a thread with `goal`, or null when it can. */
export function tempoGoalRefusal(
  goal: TempoGoal | null | undefined,
  change: TempoGoalChange,
): TempoGoalRefusal | null {
  if (change.type === "set" || change.type === "clear") return null;
  if (goal == null) return "noGoal";
  if (change.type === "resume" && goal.status === "complete") return "complete";
  return null;
}

/** What a client can do to a goal itself; setting one is a `/goal <objective>` message. */
export const TempoGoalAction = Schema.Literals(["pause", "resume", "clear"]);
export type TempoGoalAction = typeof TempoGoalAction.Type;

export const TempoGoalUpdateInput = Schema.Struct({
  threadId: ThreadId,
  action: TempoGoalAction,
});
export type TempoGoalUpdateInput = typeof TempoGoalUpdateInput.Type;

export const TempoGoalUpdateResult = Schema.Struct({
  goal: Schema.NullOr(TempoGoal),
});
export type TempoGoalUpdateResult = typeof TempoGoalUpdateResult.Type;

export class TempoGoalRefusedError extends Schema.TaggedError<TempoGoalRefusedError>()(
  "TempoGoalRefusedError",
  { threadId: ThreadId, reason: TempoGoalRefusal },
) {
  override get message(): string {
    return tempoGoalRefusalMessage(this.reason);
  }
}

export class TempoGoalFailedError extends Schema.TaggedError<TempoGoalFailedError>()(
  "TempoGoalFailedError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not change this thread's goal. Try again.";
  }
}

export const TempoGoalError = Schema.Union([TempoGoalRefusedError, TempoGoalFailedError]);
export type TempoGoalError = typeof TempoGoalError.Type;

export const TEMPO_GOAL_WS_METHODS = {
  update: "tempo.goal.update",
} as const;

export const TempoGoalUpdateRpc = Rpc.make(TEMPO_GOAL_WS_METHODS.update, {
  payload: TempoGoalUpdateInput,
  success: TempoGoalUpdateResult,
  error: Schema.Union([TempoGoalError, EnvironmentAuthorizationError]),
});
