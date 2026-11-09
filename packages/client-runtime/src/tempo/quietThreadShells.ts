/**
 * tempo: the thread shell list without a new array for every streaming tick, which otherwise makes
 * each reader (the sidebar's sections, sorts and project order) redo its work several times a
 * second. It keeps a running thread's previous shell while nothing a list shows can differ;
 * anything that needs the streaming fields current reads `threadShellsAtom`.
 */
import { Atom } from "effect/reactivity";

import { arrayElementsEqual } from "../state/entities.ts";
import type { EnvironmentThreadShell } from "../state/models.ts";
import { sameApartFromStreaming } from "../state/threadShell.ts";

/**
 * Whether a list can keep showing `shown` for `next`. Lists show and sort a thread by
 * latestUserMessageAt, falling back to updatedAt only without a user message. A snoozed running
 * thread wakes at runtime.updatedAt only while it asks for something. Servers that send no
 * latestRunCompletedAt report a run's completion as updatedAt.
 */
function shellListCanKeep(shown: EnvironmentThreadShell, next: EnvironmentThreadShell): boolean {
  return (
    next.latestUserMessageAt !== null &&
    !next.hasPendingApprovals &&
    !next.hasPendingUserInput &&
    next.pendingSubagentRequest == null &&
    shown.latestRun?.completedAt === next.latestRun?.completedAt &&
    sameApartFromStreaming(shown, next)
  );
}

export function createQuietThreadShellsAtom(
  threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>,
) {
  let previous: ReadonlyArray<EnvironmentThreadShell> = [];
  return Atom.make((get) => {
    // A shell update keeps the thread's place, so the shell shown last sits at the same index
    // unless threads came or went, which needs a new list anyway.
    const next = get(threadShellsAtom).map((thread, index) => {
      const shown = previous[index];
      if (shown === undefined || shown === thread) return thread;
      return shown.id === thread.id &&
        shown.environmentId === thread.environmentId &&
        shellListCanKeep(shown, thread)
        ? shown
        : thread;
    });
    if (arrayElementsEqual(previous, next)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("tempo-quiet-thread-shell-list"));
}
