import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useTempoLook } from "~/tempo/look/useTempoLook";
import type { RightPanelSurface } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";

const NO_PAGES: ReadonlySet<string> = new Set();

/**
 * tempo: a thread's page tabs opened from a click. In the tempo look the side panel shows such a
 * page at least at the page width (usePreviewPanelInlineSize), until the person resizes the panel.
 * Never saved: their saved width stays theirs, and the page width follows the window it opens in.
 */
const pageRoomAtom = Atom.family((threadKey: string) =>
  Atom.make(NO_PAGES).pipe(Atom.keepAlive, Atom.withLabel(`tempo:page-room:${threadKey}`)),
);

/** Call before the panel opens the tab, so it opens at its final width. */
export function makeRoomForPage(threadRef: ScopedThreadRef, tabId: string): void {
  appAtomRegistry.update(pageRoomAtom(scopedThreadKey(threadRef)), (tabIds) =>
    new Set(tabIds).add(tabId),
  );
}

export interface PageRoom {
  /** The panel shows a page that asked for room. */
  readonly shown: boolean;
  /** A resize gives the panel back the width the person set. */
  readonly release: () => void;
}

export function usePageRoom(
  threadRef: ScopedThreadRef,
  surface: RightPanelSurface | undefined,
): PageRoom {
  const atom = pageRoomAtom(scopedThreadKey(threadRef));
  const tabIds = useAtomValue(atom);
  const look = useTempoLook();
  return {
    shown:
      look === "tempo" &&
      surface?.kind === "preview" &&
      surface.resourceId !== null &&
      tabIds.has(surface.resourceId),
    release: () => appAtomRegistry.set(atom, NO_PAGES),
  };
}
