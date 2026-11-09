import {
  AuthPreviewOperateScope,
  type BrowserLinkTarget,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isWorkUrl } from "@t3tools/shared/tempoPageLinks";

import { ensureClientSettingsHydrated, getClientSettings } from "~/hooks/useSettings";
import { readEnvironmentScope } from "~/state/session";
import { isPreviewAvailableFor } from "./previewRuntime";

/** tempo: where the click happened: the chat or the terminal, or the side panel's pages and files. */
export type LinkOrigin = "chat" | "panel";

export interface ResolveLinkTargetInput {
  readonly url: string;
  readonly event?:
    | {
        readonly metaKey: boolean;
        readonly ctrlKey: boolean;
        readonly button?: number | undefined;
      }
    | undefined;
  readonly origin: LinkOrigin;
  readonly preference: BrowserLinkTarget;
  readonly canOpenInApp: boolean;
}

/** tempo: whether a link clicked in the chat or the terminal opens in the side panel. */
const OPENS_IN_PANEL: Readonly<Record<BrowserLinkTarget, (url: string) => boolean>> = {
  work: isWorkUrl,
  system: () => false,
  app: () => true,
};

/** "app" is a tab in the thread's side panel, "system" the default browser. */
export function resolveLinkTarget(input: ResolveLinkTargetInput): "system" | "app" {
  const event = input.event;
  if (event !== undefined && (event.metaKey || event.ctrlKey || event.button === 1)) {
    return "system";
  }
  if (!input.canOpenInApp || !isWebUrl(input.url)) return "system";
  if (input.origin === "panel") return "app";
  return OPENS_IN_PANEL[input.preference](input.url) ? "app" : "system";
}

function isWebUrl(url: string): boolean {
  try {
    const { protocol } = new URL(url);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** Before hydration, the default would ignore a saved link target. */
export async function resolveBrowserLinkTargetPreference(): Promise<BrowserLinkTarget> {
  await ensureClientSettingsHydrated();
  return getClientSettings().browserLinkTarget;
}

export function canOpenLinksInApp(threadRef: ScopedThreadRef | null | undefined): boolean {
  return (
    threadRef != null &&
    readEnvironmentScope(threadRef.environmentId, AuthPreviewOperateScope) &&
    isPreviewAvailableFor(threadRef.environmentId)
  );
}
