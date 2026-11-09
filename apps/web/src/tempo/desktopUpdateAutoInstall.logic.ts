// A run that finished its provider turn and is "waiting" on background work is left out: a
// restart wakes it with a note (docs/user/updating.md, Continue threads after restarts).
const isRunning = (status: string) =>
  status === "preparing" || status === "queued" || status === "starting" || status === "running";

interface HostedEnvironmentThreads {
  /** The shell is subscribed and current; a cached or loading one may hide a running turn. */
  readonly live: boolean;
  readonly threads: ReadonlyArray<{ readonly status: string }>;
}

/** Agent turns running on these environments, or null while any of them is not live. */
export function countLocalTurns(
  environments: ReadonlyArray<HostedEnvironmentThreads>,
): number | null {
  let turns = 0;
  for (const environment of environments) {
    if (!environment.live) return null;
    turns += environment.threads.filter((thread) => isRunning(thread.status)).length;
  }
  return turns;
}

/**
 * What this window tells the desktop app it runs in, which installs a downloaded update by
 * itself only at zero. Null is "cannot tell": the environment list is still loading, or the
 * local environment this app starts has not joined it. With the local environment turned off,
 * nothing here runs agents, so nothing holds the update back.
 */
export function localTurnsReport(input: {
  readonly environmentsReady: boolean;
  readonly localEnvironmentOff: boolean;
  readonly hostedEnvironments: number;
  readonly turns: number | null;
}): number | null {
  if (!input.environmentsReady) return null;
  if (input.hostedEnvironments === 0) return input.localEnvironmentOff ? 0 : null;
  return input.turns;
}
