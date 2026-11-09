/**
 * tempo: the server browser has no take or release control. Any viewer that may operate a tab
 * drives it at any moment, and its deliberate input claims the tab from an agent or another
 * viewer. Hovering, probes, and automatic panel resizes never claim it, so watching a tab never
 * interrupts an agent. The server and every client share this rule.
 */

/** Whether a viewer's stream message claims the tab. Reads the untyped wire shape the server gets. */
export const claimsBrowserControl = (message: {
  readonly type?: unknown;
  readonly action?: unknown;
  readonly buttons?: unknown;
}): boolean => {
  switch (message.type) {
    case "mouse":
      // A move with a button held drags; one without hovers.
      return (
        message.action !== "move" || (typeof message.buttons === "number" && message.buttons > 0)
      );
    case "takeControl":
    case "dialog":
    case "wheel":
    case "key":
    case "text":
    case "viewport":
    case "navigate":
    case "history":
    case "reload":
      return true;
    default:
      return false;
  }
};
