import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import { useSyncExternalStore } from "react";

import { getTempoLook, subscribeTempoLook } from "./applyTempoLook";

const getDefaultLook = () => DEFAULT_CLIENT_SETTINGS.tempoLook;

/** The look to present, the one <html data-look> paints. Branch presentation on it, never behavior. */
export function useTempoLook() {
  return useSyncExternalStore(subscribeTempoLook, getTempoLook, getDefaultLook);
}
