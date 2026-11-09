import type { ThreadPanelPresentation } from "../../rightPanelLayout";

/**
 * tempo: which of a thread's panel flags shows its details card. T3 opens the card wherever it fits
 * inline. With Settings → General → Open thread details automatically off (the default), the
 * inline card follows the popover's flag instead: closed until its button opens it, and closed
 * again after a reload.
 */
export function threadPanelStatePresentation(
  presentation: ThreadPanelPresentation,
  autoOpen: boolean,
): ThreadPanelPresentation {
  return autoOpen ? presentation : "popover";
}
