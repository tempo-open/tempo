import type { ThreadId } from "@t3tools/contracts";

/**
 * The threads that hold a live approval or question for one of their subagent descendants,
 * walked up the lineage like the client's `pendingSubagentRequestsByThread`. Provider-native
 * subagents ask on their parent, so callers leave them out of `askingThreadIds`.
 */
export function ancestorsOfAskingSubagents(
  subagents: ReadonlyArray<{
    readonly id: ThreadId;
    readonly parentThreadId: ThreadId | null;
  }>,
  askingThreadIds: ReadonlyArray<ThreadId>,
): ReadonlySet<ThreadId> {
  const parentById = new Map(subagents.map((thread) => [thread.id, thread.parentThreadId]));
  const ancestors = new Set<ThreadId>();
  for (const askingId of askingThreadIds) {
    const seen = new Set<ThreadId>([askingId]);
    let current: ThreadId = askingId;
    for (;;) {
      const parentId: ThreadId | null = parentById.get(current) ?? null;
      if (parentId === null || seen.has(parentId)) break;
      seen.add(parentId);
      ancestors.add(parentId);
      current = parentId;
    }
  }
  return ancestors;
}
