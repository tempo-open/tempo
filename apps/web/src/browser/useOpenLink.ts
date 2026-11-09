import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createContext, use } from "react";
import { recordVisitForThread } from "~/browserHistoryStore";
import { readLocalApi } from "~/localApi";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import {
  canOpenLinksInApp,
  type LinkOrigin,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";
import { BrowserSettingsReadError, openUrlInPreview } from "./openFileInPreview";

/** tempo: where the links rendered under it are clicked. The side panel's file view says "panel". */
export const LinkOriginContext = createContext<LinkOrigin>("chat");

/** Rejects on settings read failure without opening a browser, or if the system-browser fallback fails. */
export function useOpenLink(threadRef: ScopedThreadRef | null | undefined): (
  url: string,
  options?: {
    readonly event?: {
      readonly metaKey: boolean;
      readonly ctrlKey: boolean;
      readonly button?: number | undefined;
    };
    readonly threadRef?: ScopedThreadRef | undefined;
    /** tempo: defaults to the nearest LinkOriginContext. */
    readonly origin?: LinkOrigin;
  },
) => Promise<void> {
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });
  const linkOrigin = use(LinkOriginContext);
  return async (url, options = {}) => {
    const targetThreadRef = options.threadRef ?? threadRef;
    const target = resolveLinkTarget({
      url,
      event: options.event,
      origin: options.origin ?? linkOrigin,
      preference: await resolveBrowserLinkTargetPreference(),
      canOpenInApp: canOpenLinksInApp(targetThreadRef),
    });
    if (target === "app" && targetThreadRef) {
      const result = await openUrlInPreview({ threadRef: targetThreadRef, url, openPreview });
      if (isAtomCommandInterrupted(result)) return;
      if (result._tag === "Success") {
        recordVisitForThread(targetThreadRef, url);
        return;
      }
      const failure = squashAtomCommandFailure(result);
      if (failure instanceof BrowserSettingsReadError) throw failure;
      console.error(result.cause);
    }
    const api = readLocalApi();
    if (!api) throw new Error("Link opening is unavailable.");
    await api.shell.openExternal(url);
  };
}
