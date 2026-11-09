/**
 * tempo: thread goals on clients (`tempoGoal.ts` in contracts). `/goal <objective>` goes out as a
 * message the server turns into the goal's first turn; pausing, resuming and clearing are the
 * `tempo.goal.update` command, so they leave no message behind. Web and mobile each build the command
 * on their own connection runtime.
 */
import {
  TEMPO_GOAL_WS_METHODS,
  parseTempoGoalCommand,
  type TempoGoalAction,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand } from "../state/runtime.ts";

/**
 * What a composer does with `text` on a server that owns goals: a goal action
 * to run instead of sending, `show` for a bare `/goal` (the goal banner shows
 * it), or null to send the text as usual.
 */
export function goalComposerAction(text: string): TempoGoalAction | "show" | null {
  const command = parseTempoGoalCommand(text);
  return command === null || command.type === "set" ? null : command.type;
}

export function createGoalCommand<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return createEnvironmentRpcCommand(runtime, {
    label: "environment-command:tempo-goal:update",
    tag: TEMPO_GOAL_WS_METHODS.update,
  });
}
