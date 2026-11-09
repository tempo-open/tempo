// @effect-diagnostics globalTimers:off - the deadline must fire while Effect's own shutdown hangs.
/**
 * tempo: a stopping server exits within a bounded time. Effect's runMain exits only once every
 * finalizer has run, so one hung finalizer can keep a SIGTERMed server alive indefinitely, and a
 * service manager cannot start the next build.
 */

/** How long shutdown gets once it starts; a normal one takes about 20 seconds. */
const SHUTDOWN_DEADLINE_MS = 60_000;

interface SignalTarget {
  on(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export interface ShutdownDeadlineOptions {
  readonly deadlineMs?: number;
  readonly exit?: (code: number) => void;
  readonly report?: (message: string) => void;
  readonly activeResources?: () => ReadonlyArray<string>;
}

/** Handle types still open, counted, so a forced exit names what held shutdown up. */
export function summarizeActiveResources(resources: ReadonlyArray<string>): string {
  const counts = new Map<string, number>();
  for (const resource of resources) counts.set(resource, (counts.get(resource) ?? 0) + 1);
  if (counts.size === 0) return "nothing";
  return [...counts].map(([name, count]) => (count === 1 ? name : `${name} ×${count}`)).join(", ");
}

/**
 * Returns `start`, which begins the countdown once (later calls do nothing). The timer never
 * keeps the process up by itself: a shutdown that finishes exits as before.
 */
export function makeShutdownDeadline(options: ShutdownDeadlineOptions = {}): () => void {
  const deadlineMs = options.deadlineMs ?? SHUTDOWN_DEADLINE_MS;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const report = options.report ?? ((message: string) => void process.stderr.write(`${message}\n`));
  const activeResources = options.activeResources ?? (() => process.getActiveResourcesInfo());
  let started = false;
  return () => {
    if (started) return;
    started = true;
    const timer = setTimeout(() => {
      const open = summarizeActiveResources(activeResources());
      report(`Shutdown did not finish within ${deadlineMs / 1000} s; exiting. Still open: ${open}`);
      exit(1);
    }, deadlineMs);
    timer.unref();
  };
}

/** Calls `start` on SIGTERM or SIGINT; returns the function that stops listening. */
export function listenForShutdownSignals(start: () => void, target: SignalTarget = process) {
  target.on("SIGTERM", start);
  target.on("SIGINT", start);
  return () => {
    target.off("SIGTERM", start);
    target.off("SIGINT", start);
  };
}
