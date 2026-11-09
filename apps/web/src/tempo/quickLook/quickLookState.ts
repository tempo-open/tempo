import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { registerThreadOverlay } from "~/components/chat/threadOverlayRetention";
import { isMarkdownPreviewFile } from "~/components/files/filePreviewMode";
import { useRightPanelStore } from "~/rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";

export interface QuickLookFile {
  /** Workspace relative, or an absolute host path, as the side panel takes it. */
  readonly path: string;
  readonly line?: number | undefined;
}

export interface QuickLookRequest {
  readonly threadKey: string;
  readonly threadRef: ScopedThreadRef;
  /** The markdown files linked beside the one clicked, which the arrow keys step through. */
  readonly files: ReadonlyArray<QuickLookFile>;
  readonly index: number;
  /** Viewport point the card zooms out of and back into, the clicked link's center. */
  readonly origin: { readonly x: number; readonly y: number } | null;
  readonly id: number;
}

const quickLookAtom = Atom.make<QuickLookRequest | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tempo:quick-look"),
);

let nextRequestId = 1;

export function readQuickLookAtom() {
  return quickLookAtom;
}

export function closeQuickLook(): void {
  appAtomRegistry.set(quickLookAtom, null);
}

function originOf(element: Element | null | undefined): QuickLookRequest["origin"] {
  if (!element?.isConnected) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

/**
 * tempo: markdown opens in the centered reading card; every other file opens in
 * the side panel as before. `from` is the element clicked, for the zoom.
 */
export function openFileForReading(
  threadRef: ScopedThreadRef,
  path: string,
  options: {
    readonly line?: number | undefined;
    readonly from?: Element | null | undefined;
    readonly siblings?: ReadonlyArray<QuickLookFile> | undefined;
  } = {},
): void {
  if (!isMarkdownPreviewFile(path)) {
    useRightPanelStore.getState().openFile(threadRef, path, options.line);
    return;
  }
  const opened: QuickLookFile = { path, line: options.line };
  const siblings = (options.siblings ?? []).filter((file) => isMarkdownPreviewFile(file.path));
  const at = siblings.findIndex((file) => file.path === path);
  const files = at >= 0 ? siblings.map((file, i) => (i === at ? opened : file)) : [opened];
  appAtomRegistry.set(quickLookAtom, {
    threadKey: scopedThreadKey(threadRef),
    threadRef,
    files,
    index: Math.max(at, 0),
    origin: originOf(options.from),
    id: nextRequestId++,
  });
}

// Leaving the thread drops its card, like the other chat overlays.
registerThreadOverlay((threadKey) => {
  const current = appAtomRegistry.get(quickLookAtom);
  if (current !== null && current.threadKey !== threadKey) closeQuickLook();
});
