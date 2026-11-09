import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The chat that started this one: the sender of its first user message. A chat launched or
 * created through Tempo's tools is born from a message that names the launching chat, and no other
 * record links them. Earlier means lower `createdAt`, then lower id, the order the shell SQL uses.
 */
export function firstUserMessageSender(
  messages: ReadonlyArray<
    Pick<OrchestrationV2ConversationMessage, "id" | "role" | "createdAt" | "senderThreadId">
  >,
): ThreadId | null {
  let first: (typeof messages)[number] | null = null;
  for (const message of messages) {
    if (message.role !== "user") continue;
    if (first === null) {
      first = message;
      continue;
    }
    const byTime =
      DateTime.toEpochMillis(message.createdAt) - DateTime.toEpochMillis(first.createdAt);
    if (byTime < 0 || (byTime === 0 && message.id.localeCompare(first.id) < 0)) first = message;
  }
  return first?.senderThreadId ?? null;
}

/**
 * The edges under a chat, at any depth, from each chat's subagent parent and creator: what the
 * sidebar draws under it. Each edge appears once; a chat under two parents has two. Edges keep the
 * input's order, and a creator loop ends where it comes back around.
 */
export function subThreadEdgesUnder(
  rootThreadId: ThreadId,
  threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly subagentParentThreadId: string | null;
    readonly createdByThreadId: string | null;
  }>,
): ReadonlyArray<{ readonly parentThreadId: ThreadId; readonly threadId: ThreadId }> {
  const childrenOf = new Map<string, Array<ThreadId>>();
  for (const thread of threads) {
    for (const parent of new Set([thread.subagentParentThreadId, thread.createdByThreadId])) {
      if (parent === null || parent === thread.threadId) continue;
      const siblings = childrenOf.get(parent);
      if (siblings === undefined) childrenOf.set(parent, [thread.threadId]);
      else siblings.push(thread.threadId);
    }
  }
  const edges: Array<{ readonly parentThreadId: ThreadId; readonly threadId: ThreadId }> = [];
  const reached = new Set<string>([rootThreadId]);
  const pending: Array<ThreadId> = [rootThreadId];
  for (let parent = pending.shift(); parent !== undefined; parent = pending.shift()) {
    for (const child of childrenOf.get(parent) ?? []) {
      edges.push({ parentThreadId: parent, threadId: child });
      if (reached.has(child)) continue;
      reached.add(child);
      pending.push(child);
    }
  }
  return edges;
}

/** The shell field, left out when nothing started this chat or the sender is the chat itself. */
export function tempoCreatedByShellFields(
  threadId: ThreadId,
  senderThreadId: string | null | undefined,
): Pick<OrchestrationV2ThreadShell, "tempoCreatedByThreadId"> {
  return senderThreadId == null || senderThreadId === threadId
    ? {}
    : { tempoCreatedByThreadId: senderThreadId as ThreadId };
}
