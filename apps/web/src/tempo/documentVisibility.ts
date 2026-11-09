import * as Effect from "effect/Effect";
import { useSyncExternalStore } from "react";

/**
 * tempo: whether the window shows. A hidden window paints nothing, but its timers, sockets and
 * subscriptions keep running, so work that only matters on screen waits for this.
 */
export function isDocumentVisible(): boolean {
  return document.visibilityState === "visible";
}

/** Calls `listener` with the new state each time the window is shown or hidden. */
export function onDocumentVisibilityChange(listener: (visible: boolean) => void): () => void {
  const onChange = () => listener(isDocumentVisible());
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Completes at once while the window shows, otherwise as soon as it is shown. */
export const whenDocumentVisible: Effect.Effect<void> = Effect.callback<void>((resume) => {
  if (isDocumentVisible()) {
    resume(Effect.void);
    return;
  }
  const stop = onDocumentVisibilityChange((visible) => {
    if (!visible) return;
    stop();
    resume(Effect.void);
  });
  return Effect.sync(stop);
});

const subscribe = (onChange: () => void) => onDocumentVisibilityChange(onChange);

export function useDocumentVisible(): boolean {
  return useSyncExternalStore(subscribe, isDocumentVisible, () => true);
}
