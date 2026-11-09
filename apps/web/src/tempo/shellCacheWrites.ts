import * as Effect from "effect/Effect";

import { onDocumentVisibilityChange } from "./documentVisibility";

/**
 * tempo: what the shell cache waits for after a write. Each write encodes the whole shell into
 * IndexedDB and a running agent changes the shell several times a second, so writes come at most
 * once a minute. Hiding or closing the window ends the wait, so the newest shell is written then.
 */
export const shellCacheWritePause: Effect.Effect<void> = Effect.callback<void>((resume) => {
  const stop = () => {
    stopWatchingVisibility();
    window.removeEventListener("pagehide", done);
    window.removeEventListener("beforeunload", done);
  };
  const done = () => {
    stop();
    resume(Effect.void);
  };
  const stopWatchingVisibility = onDocumentVisibilityChange((visible) => {
    if (!visible) done();
  });
  window.addEventListener("pagehide", done);
  window.addEventListener("beforeunload", done);
  return Effect.sync(stop);
}).pipe(Effect.timeoutOrElse({ duration: "1 minute", orElse: () => Effect.void }));
