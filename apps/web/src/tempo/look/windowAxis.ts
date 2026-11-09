import { createStore } from "zustand";

/**
 * The tempo look's axis on a wide window. The conversation moves from the middle of its canvas
 * toward the middle of the window, and the thread header, the minimap and the title bar's search
 * line up with it.
 */
export interface ChatAxis {
  /** How far the conversation has moved toward `center`: 0 up to an 1800 px window, 1 from 2600. */
  readonly weight: number;
  /** The window's middle in canvas coordinates, or the canvas's own middle beside a side panel. */
  readonly center: number;
  /** The canvas's left edge in the window. */
  readonly canvasLeft: number;
}

export function resolveChatAxis(input: {
  readonly windowWidth: number;
  readonly canvasLeft: number;
  readonly canvasWidth: number;
  /** False while a side panel stands beside the canvas, which then centers in its own space. */
  readonly centerOnWindow: boolean;
}): ChatAxis | null {
  const weight = Math.min(1, Math.max(0, (input.windowWidth - 1800) / 800));
  // A maximized side panel leaves the canvas no width, and so no column to line up with.
  if (weight === 0 || input.canvasWidth <= 0) return null;
  return {
    weight,
    center: input.centerOnWindow ? input.windowWidth / 2 - input.canvasLeft : input.canvasWidth / 2,
    canvasLeft: input.canvasLeft,
  };
}

/**
 * Where the conversation's column sits while the axis is on, for the chrome outside its canvas:
 * its text's left edge in the sheet (the thread header) and its middle in the window (the title
 * bar's search).
 */
export interface ChatColumnPlace {
  readonly start: number;
  readonly middle: number;
}

export const chatColumnPlaceStore = createStore<{ readonly place: ChatColumnPlace | null }>()(
  () => ({ place: null }),
);
