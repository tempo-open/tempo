import type { OrchestrationV2ConversationMessage } from "@t3tools/contracts";

/**
 * tempo: a restart's hold is on the user's own messages. Wakes from watchers, PR
 * watches, delegates and schedules are not the user's, so they keep flowing.
 */
export function typedByUser(
  message: Pick<OrchestrationV2ConversationMessage, "createdBy" | "scheduledTaskId">,
): boolean {
  return message.createdBy === "user" && message.scheduledTaskId === undefined;
}
