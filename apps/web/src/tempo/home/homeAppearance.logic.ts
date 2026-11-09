import { TempoHomeWidget, type TempoHomeWidgets } from "@t3tools/contracts";

/**
 * The widgets after a press on one widget's chip, in their fixed order: two or three, never one or
 * four, so a press that would leave one or four changes nothing and returns null.
 */
export function toggleHomeWidget(
  widgets: TempoHomeWidgets,
  widget: TempoHomeWidget,
): TempoHomeWidgets | null {
  const shown = widgets.includes(widget);
  if (shown ? widgets.length <= 2 : widgets.length >= 3) return null;
  return TempoHomeWidget.literals.filter((candidate) =>
    candidate === widget ? !shown : widgets.includes(candidate),
  );
}
