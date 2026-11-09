import { useSyncExternalStore } from "react";

/**
 * tempo: a request, from the browser panel's More menu, to open one profile's
 * extensions and passkeys in Settings. The settings dialog takes it on render.
 */
let requested: string | null = null;
const listeners = new Set<() => void>();

const publish = (profileId: string | null) => {
  requested = profileId;
  for (const listener of listeners) listener();
};

export const requestProfileExtras = (profileId: string) => publish(profileId);
export const clearProfileExtrasRequest = () => publish(null);

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const useRequestedProfileExtras = () => useSyncExternalStore(subscribe, () => requested);
