import { usePrimarySettings } from "../../hooks/useSettings";

/**
 * Whether this install opted in to the compact sidebar (one-line rows with each chat's project and
 * provider, and sub chats; `tempoSidebarV2Enabled`, a server setting). Off by default, so an install
 * keeps T3's sidebar until it turns the new one on.
 */
export function useSidebarV2Enabled(): boolean {
  return usePrimarySettings((settings) => settings.tempoSidebarV2Enabled);
}
