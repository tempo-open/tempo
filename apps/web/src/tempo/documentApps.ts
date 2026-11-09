import { useAtomValue } from "@effect/atom-react";
import type { TempoDocumentApps } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";

const NO_DOCUMENT_APPS: TempoDocumentApps = { browser: null };

/** tempo: this Mac's default browser, asked once at launch (appInit). */
export const documentAppsAtom = Atom.make(
  Effect.promise(
    () =>
      window.desktopBridge?.tempo?.documentApps?.().catch(() => NO_DOCUMENT_APPS) ??
      Promise.resolve(NO_DOCUMENT_APPS),
  ),
).pipe(Atom.keepAlive, Atom.withLabel("tempo:document-apps"));

export function useDocumentApps(): TempoDocumentApps {
  return AsyncResult.getOrElse(useAtomValue(documentAppsAtom), () => NO_DOCUMENT_APPS);
}

/** The default browser's name, such as Safari, or null where only the desktop app could tell. */
export function useDefaultBrowserName(): string | null {
  return useDocumentApps().browser;
}
