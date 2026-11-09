import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";

export type ThreadNotificationKind = "input" | "completion";

export interface ThreadNotificationObservation {
  /** Run and status key while the thread needs attention, otherwise null. */
  readonly attention: string | null;
  /** The thread is idle and its latest run completed. */
  readonly settled: boolean;
  /** When the latest run completed, if it did. */
  readonly completedAt: number | null;
}

/**
 * Attention notifies at once. Completion waits out the Working shelf's exit grace,
 * because an orchestrator run can end moments before its continuation starts. Any
 * observation that is not settled during the wait cancels it.
 */
export function createThreadNotificationGate<Key>(
  notify: (key: Key, kind: ThreadNotificationKind) => void,
) {
  const pending = new Map<Key, { at: number; timer: ReturnType<typeof setTimeout> }>();
  // The newest completion already notified, or deliberately skipped.
  const handled = new Map<Key, number>();
  // The newest completion seen settled, kept while the thread works or waits.
  const lastSettled = new Map<Key, number>();
  const cancel = (key: Key) => {
    clearTimeout(pending.get(key)?.timer);
    pending.delete(key);
  };
  const skip = (key: Key, at: number | null) => {
    if (at !== null && at > (handled.get(key) ?? -Infinity)) handled.set(key, at);
  };
  return {
    observe(
      key: Key,
      prior: ThreadNotificationObservation | undefined,
      next: ThreadNotificationObservation,
      options: {
        readonly archived: boolean;
        readonly quiet: boolean;
        /** When these threads were last watched, so a first sighting can tell what is news. */
        readonly lastObservedAt?: number | null;
      },
    ): void {
      if (next.settled && next.completedAt !== null) lastSettled.set(key, next.completedAt);
      if (!next.settled || options.archived || options.quiet) cancel(key);
      // A first sighting is old news unless the run finished after they were last watched: the
      // window was reloaded or lost its connection while the thread ran.
      const oldNews =
        !prior &&
        (next.completedAt === null ||
          options.lastObservedAt == null ||
          next.completedAt <= options.lastObservedAt);
      // Old news, archived threads, and stopped or silent runs never notify completion.
      if (oldNews || options.archived || options.quiet) skip(key, next.completedAt);
      if (oldNews || options.archived) return;
      if (next.attention && next.attention !== prior?.attention) {
        // Attention replaces the completion before it, so that run must not notify later.
        skip(key, lastSettled.get(key) ?? null);
        cancel(key);
        notify(key, "input");
        return;
      }
      const at = next.completedAt;
      if (!next.settled || at === null || at <= (handled.get(key) ?? -Infinity)) return;
      if (pending.get(key)?.at === at) return;
      cancel(key);
      pending.set(key, {
        at,
        timer: setTimeout(() => {
          pending.delete(key);
          handled.set(key, at);
          notify(key, "completion");
        }, WORKING_EXIT_GRACE_MS),
      });
    },
    /** Forgets threads that left the snapshot. */
    retain(keys: ReadonlySet<Key>): void {
      for (const key of pending.keys()) if (!keys.has(key)) cancel(key);
      for (const key of handled.keys()) if (!keys.has(key)) handled.delete(key);
      for (const key of lastSettled.keys()) if (!keys.has(key)) lastSettled.delete(key);
    },
    clear(): void {
      for (const key of pending.keys()) cancel(key);
      handled.clear();
      lastSettled.clear();
    },
  };
}

const LAST_OBSERVED_KEY_PREFIX = "tempo:thread-notifications:last-observed:";

/** When this client last watched an environment's threads, from any earlier window. */
export function readThreadsLastObservedAt(environmentId: string): number | null {
  try {
    const saved = Number(localStorage.getItem(`${LAST_OBSERVED_KEY_PREFIX}${environmentId}`));
    return saved > 0 ? saved : null;
  } catch {
    return null;
  }
}

export function writeThreadsLastObservedAt(environmentId: string, at: number): void {
  try {
    localStorage.setItem(`${LAST_OBSERVED_KEY_PREFIX}${environmentId}`, String(at));
  } catch {
    // Without storage, a reloaded window treats what it first sees as old news.
  }
}
