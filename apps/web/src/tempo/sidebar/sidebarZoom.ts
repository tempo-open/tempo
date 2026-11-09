import type { ClientRect, MeasuringConfiguration } from "@dnd-kit/core";
import type { Transform } from "@dnd-kit/utilities";

/*
 * The tempo look zooms the sidebar on a wide window (look/wide.css). dnd-kit measures on the
 * screen, while a transform counts the row's own pixels, which the zoom then scales.
 */

/** dnd-kit's translate for a sidebar row, in the row's own pixels. */
export function sidebarTranslate(transform: Transform | null): string | undefined {
  if (!transform) return undefined;
  const length = (value: number) => `calc(${Math.round(value)}px / var(--tempo-sidebar-zoom))`;
  return `translate3d(${length(transform.x)}, ${length(transform.y)}, 0)`;
}

/** A row's rect on the screen without its translate, which dnd-kit's own measure takes unzoomed. */
function measureUntranslated(element: HTMLElement): ClientRect {
  const rect = element.getBoundingClientRect();
  const { m41, m42 } = new DOMMatrixReadOnly(getComputedStyle(element).transform);
  const left = rect.left - m41 * element.currentCSSZoom;
  const top = rect.top - m42 * element.currentCSSZoom;
  return {
    left,
    top,
    width: rect.width,
    height: rect.height,
    right: left + rect.width,
    bottom: top + rect.height,
  };
}

export const SIDEBAR_DND_MEASURING: MeasuringConfiguration = {
  draggable: { measure: measureUntranslated },
  droppable: { measure: measureUntranslated },
};
