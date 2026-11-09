const AWAY_EVENTS = ["lock-screen", "unlock-screen", "suspend", "resume"] as const;
type AwayEvent = (typeof AWAY_EVENTS)[number];

/** Electron's `powerMonitor`, or an EventEmitter in tests. */
interface AwaySignals {
  on(event: AwayEvent, listener: () => void): unknown;
  removeListener(event: AwayEvent, listener: () => void): unknown;
}

/**
 * Runs a shortcut watcher, such as SnapShot's modifier-pair poller (20 wakeups a second), only
 * while someone could press it: stopped while the screen is locked or the Mac sleeps. A failure,
 * at a restart or while running, ends it and is reported once. Resolves after the first start to
 * the function that stops it for good.
 */
export async function pauseWhileAway(
  signals: AwaySignals,
  start: (onFailure: (error: Error) => void) => Promise<() => void>,
  onFailure: (error: Error) => void,
): Promise<() => void> {
  let ended = false;
  let locked = false;
  let asleep = false;
  let starting = false;
  let stop: (() => void) | undefined;

  const sync = () => {
    if (ended || locked || asleep) {
      stop?.();
      stop = undefined;
      return;
    }
    if (stop !== undefined || starting) return;
    starting = true;
    // A spawn that throws must not escape into the power monitor's listener.
    new Promise<() => void>((resolve) => resolve(start(fail))).then(
      (next) => {
        starting = false;
        stop = next;
        // Locked, asleep or stopped while it started.
        sync();
      },
      (error: unknown) => {
        starting = false;
        fail(error instanceof Error ? error : new Error(String(error)));
      },
    );
  };
  const listeners = AWAY_EVENTS.map(
    (event) =>
      [
        event,
        () => {
          if (event === "lock-screen" || event === "unlock-screen")
            locked = event === "lock-screen";
          else asleep = event === "suspend";
          sync();
        },
      ] as const,
  );
  const end = () => {
    if (ended) return;
    ended = true;
    for (const [event, listener] of listeners) signals.removeListener(event, listener);
    sync();
  };
  const fail = (error: Error) => {
    if (ended) return;
    end();
    onFailure(error);
  };

  stop = await start(fail);
  if (!ended) for (const [event, listener] of listeners) signals.on(event, listener);
  return end;
}
