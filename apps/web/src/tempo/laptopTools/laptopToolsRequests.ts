import type {
  DesktopLaptopToolsBridge,
  TempoLaptopPasskeyStatus,
  EnvironmentId,
  LaptopPasskeyRequest,
  LaptopToolHostId,
  LaptopToolsOutcome,
  LaptopToolsResponse,
  LaptopToolsStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

export interface LaptopToolsRequestRelay {
  /** Takes one event from the environment's stream. */
  readonly relay: (event: LaptopToolsStreamEvent) => void;
  /**
   * Stops relaying and cancels every request still running on the desktop:
   * the environment already failed them when this registration went away.
   */
  readonly dispose: () => void;
}

/**
 * Forwards one environment's laptop tool requests to the desktop and sends the
 * answers back. The renderer only relays: the desktop asks the person, runs
 * the tool and decides the outcome; the environment checks the answer.
 */
export function createLaptopToolsRequestRelay(options: {
  readonly hostId: LaptopToolHostId;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: () => string;
  readonly bridge: Pick<DesktopLaptopToolsBridge, "handleRequest" | "cancelRequest">;
  readonly respond: (response: LaptopToolsResponse) => Promise<unknown>;
  /**
   * tempo passkeys: a passkey request this Mac could not run (`unavailable`),
   * while the environment still waited for it. The environment then falls back
   * to the profile's saved passkeys; this is the person's chance to learn why.
   */
  readonly onPasskeyUnavailable?: (notice: {
    readonly request: LaptopPasskeyRequest;
    readonly status: TempoLaptopPasskeyStatus;
    readonly environmentLabel: string;
  }) => void;
}): LaptopToolsRequestRelay {
  const seen = new Set<string>();
  /** Requests handed to the desktop and not answered yet, with their connection. */
  const outstanding = new Map<string, string>();
  let disposed = false;

  const cancel = (requestId: string) => {
    outstanding.delete(requestId);
    void options.bridge
      .cancelRequest({ environmentId: options.environmentId, requestId })
      .catch(() => undefined);
  };

  const relay = (event: LaptopToolsStreamEvent) => {
    if (disposed) return;
    if (event.type === "connected") {
      // A new registration retired the old one, and with it the old one's calls.
      for (const [requestId, connectionId] of outstanding) {
        if (connectionId !== event.connectionId) cancel(requestId);
      }
      return;
    }
    // A stream that restarts can show the same event again.
    const key = `${event.type}\u0000${event.connectionId}\u0000${event.requestId}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (seen.size > 2_000) seen.delete(seen.values().next().value as string);
    if (event.type === "cancel") {
      cancel(event.requestId);
      return;
    }
    outstanding.set(event.requestId, event.connectionId);
    const environmentLabel = options.environmentLabel().slice(0, 200);
    void options.bridge
      .handleRequest({
        environmentId: options.environmentId,
        environmentLabel,
        requestId: event.requestId,
        request: event.request,
      })
      .catch((error: unknown): LaptopToolsOutcome => ({
        _tag: "failure",
        code: "failed",
        message: `The desktop app could not run the tool: ${
          error instanceof Error ? error.message : String(error)
        }`.slice(0, 500),
      }))
      .then((outcome) => {
        // Cancelled or retired: the environment no longer waits for this answer.
        if (outstanding.get(event.requestId) !== event.connectionId) return;
        outstanding.delete(event.requestId);
        const responded = options.respond({
          hostId: options.hostId,
          connectionId: event.connectionId,
          requestId: event.requestId,
          outcome,
        });
        if (
          event.request._tag === "passkey" &&
          outcome._tag === "passkey" &&
          outcome.result._tag === "unavailable"
        ) {
          options.onPasskeyUnavailable?.({
            request: event.request,
            status: outcome.result.status,
            environmentLabel,
          });
        }
        return responded;
      })
      .catch(() => undefined);
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const requestId of outstanding.keys()) cancel(requestId);
  };

  return { relay, dispose };
}

/**
 * Hands every event of the stream to `relay`, one at a time. These events
 * are commands, so they must not go through a latest-value atom, which keeps
 * only the last event of each batch the transport delivers.
 */
export const relayLaptopToolsEvents = <E, R>(
  stream: Stream.Stream<LaptopToolsStreamEvent, E, R>,
  relay: (event: LaptopToolsStreamEvent) => void,
): Stream.Stream<never, E, R> =>
  stream.pipe(
    Stream.tap((event) => Effect.sync(() => relay(event))),
    Stream.drain,
  );
