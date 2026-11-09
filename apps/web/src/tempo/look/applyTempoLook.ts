import type { TempoLook } from "@t3tools/contracts";

import {
  getClientSettings,
  isClientSettingsHydrated,
  subscribeClientSettings,
  subscribeClientSettingsHydration,
} from "~/hooks/useSettings";
import { syncBrowserChromeTheme } from "~/hooks/useTheme";

/**
 * Read by the boot script in apps/web/index.html to paint the look's ground before React mounts.
 * Builds that defaulted to classic stored it under `tempo:look` as a default, not a choice.
 */
const LOOK_STORAGE_KEY = "tempo:look:v2";

/** The saved look once client settings arrive; until then the look the boot script painted. */
export function getTempoLook(): TempoLook {
  if (isClientSettingsHydrated()) return getClientSettings().tempoLook;
  return document.documentElement.dataset.look === "classic" ? "classic" : "tempo";
}

export function subscribeTempoLook(listener: () => void): () => void {
  const unsubscribeSettings = subscribeClientSettings(listener);
  const unsubscribeHydration = subscribeClientSettingsHydration(listener);
  return () => {
    unsubscribeSettings();
    unsubscribeHydration();
  };
}

export function applyTempoLook(root: HTMLElement, look: TempoLook): void {
  root.dataset.look = look;
  try {
    window.localStorage.setItem(LOOK_STORAGE_KEY, look);
  } catch {
    // Without storage the next launch paints the tempo ground until the settings arrive.
  }
  syncBrowserChromeTheme();
}
