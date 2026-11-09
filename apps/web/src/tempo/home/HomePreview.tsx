import type { ClientSettings } from "@t3tools/contracts/settings";
import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { SidebarTrigger } from "~/components/ui/sidebar";
import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { observeResize } from "~/lib/observeResize";
import { paintThemePalette, resolveThemeHalf, type ThemePreference } from "~/themePalette";

import { TempoTitleBar } from "../shell/TempoTitleBar";
import { HomeBackdrop } from "./HomeBackdrop";
import type { HomeTheme } from "./homeArt";
import { HomeDock, HomeWidgets } from "./HomeWidgets";
import { HomePreviewComposer } from "./HomePreviewComposer";
import { HomePreviewSidebar } from "./HomePreviewSidebar";

/** The mockup's window, which the preview draws whole and scales to its own width. */
const WINDOW_WIDTH = 1728;
const BLANK_DOCUMENT = "<!doctype html><html><head></head><body></body></html>";

const selectPreviewSettings = (settings: ClientSettings) => ({
  place: settings.tempoHomePlace,
  sidebarLight: settings.tempoSidebarLight,
});

/** The app's stylesheets, copied into the frame. */
function copyStylesheets(frameDocument: Document) {
  frameDocument.head.replaceChildren(
    ...[...document.head.querySelectorAll('style, link[rel="stylesheet"]')].map((sheet) =>
      sheet.cloneNode(true),
    ),
  );
}

/** The app's <html> attributes on the frame's, with the preview's theme and the frame's zoom. */
function mirrorRoot(frame: HTMLIFrameElement, theme: HomeTheme, palette: ThemePreference) {
  const root = frame.contentDocument?.documentElement;
  if (!root) return;
  for (const name of root.getAttributeNames()) root.removeAttribute(name);
  for (const { name, value } of document.documentElement.attributes) root.setAttribute(name, value);
  root.classList.toggle("dark", theme === "dark");
  root.style.colorScheme = theme;
  root.style.zoom = String(frame.clientWidth / WINDOW_WIDTH);
  paintThemePalette(root, palette, theme);
}

/** The window the home sits in, drawn small: the title bar, the sidebar and the home, all live. */
function PreviewWindow({ theme }: { readonly theme: HomeTheme }) {
  const { place, sidebarLight } = useClientSettings(selectPreviewSettings);
  return (
    <div data-tempo-home-preview-window="">
      <span data-tempo-home-preview-lights="">
        <i />
        <i />
        <i />
      </span>
      <TempoTitleBar
        ref={null}
        sidebarToggle={<SidebarTrigger variant="ghost-muted" aria-label="Toggle main sidebar" />}
        overArt={sidebarLight}
        hidden={false}
        theme={theme}
      />
      <HomePreviewSidebar />
      <div data-tempo-home-sheet="" data-tempo-home-preview-sheet="">
        <HomeBackdrop theme={theme} />
        <div data-tempo-home={place} className="absolute inset-0 flex flex-col justify-center">
          <div data-tempo-home-block="" className="w-full">
            <HomePreviewComposer />
            {place === "under" ? <HomeWidgets /> : null}
          </div>
          {place === "bottom" ? <HomeDock /> : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The home drawn small: the real art and widgets in a window of the mockup's size, scaled to fit.
 * It renders into a frame of its own, so it can show dark while the app shows light: the frame
 * takes the app's stylesheets and the attributes on <html>, with its own theme.
 */
export function HomePreview({ theme }: { readonly theme: HomeTheme }) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [body, setBody] = useState<HTMLElement | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- copies the app's stylesheets into the frame, again whenever the app adds or changes one
  useLayoutEffect(() => {
    const frameDocument = frameRef.current?.contentDocument;
    if (!body || !frameDocument) return;
    copyStylesheets(frameDocument);
    const observer = new MutationObserver(() => copyStylesheets(frameDocument));
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [body]);

  const appTheme = useTheme();
  const palette = resolveThemeHalf(appTheme.theme, appTheme.themeHalves, theme);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors <html>'s look, contrast and fonts into the frame with the preview's theme, and keeps them in step
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!body || !frame) return;
    const mirror = () => mirrorRoot(frame, theme, palette);
    mirror();
    const observer = new MutationObserver(mirror);
    observer.observe(document.documentElement, { attributes: true });
    const stopResize = observeResize(frame, mirror);
    return () => {
      observer.disconnect();
      stopResize();
    };
  }, [body, theme, palette]);

  return (
    <div data-tempo-home-preview="">
      {/* oxlint-disable-next-line react/iframe-missing-sandbox -- the frame is an empty document the app draws into; a sandbox without scripts shows a canvas's fallback instead of its art */}
      <iframe
        ref={frameRef}
        title="Preview of the home"
        srcDoc={BLANK_DOCUMENT}
        tabIndex={-1}
        aria-hidden
        inert
        onLoad={(event) => setBody(event.currentTarget.contentDocument?.body ?? null)}
      />
      {body ? createPortal(<PreviewWindow theme={theme} />, body) : null}
    </div>
  );
}
