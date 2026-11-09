import { createGoalCommand } from "@t3tools/client-runtime/tempo/goal";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { TempoGoalAction, EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";

const goalCommand = createGoalCommand(connectionAtomRuntime);

/** Whether the environment's server owns `/goal`; older ones pass it to the provider. */
export function readEnvironmentOwnsGoals(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .tempoGoal === true
  );
}

/** Pauses, resumes or clears a thread's goal. Resolves to what went wrong, or null. */
export async function updateThreadGoal(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly action: TempoGoalAction;
}): Promise<string | null> {
  const result = await runAtomCommand(
    appAtomRegistry,
    goalCommand,
    {
      environmentId: input.environmentId,
      input: { threadId: input.threadId, action: input.action },
    },
    { reportFailure: false },
  );
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Could not change the goal. Try again.";
}
