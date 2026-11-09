/**
 * tempo: the window event bus between the keybinding, the command palette
 * and the mounted composer's ultracode toggle. Kept free of connection state
 * so the composer's pickers can import it without the client runtime.
 */
const ULTRACODE_TOGGLE_EVENT = "tempo:ultracode-toggle";

/** The keybinding and the command palette both flip the active composer's toggle. */
export function requestUltracodeToggle(): void {
  window.dispatchEvent(new Event(ULTRACODE_TOGGLE_EVENT));
}

/**
 * Registers a mounted composer toggle that can flip ultracode right now; the
 * palette lists "Toggle ultracode" only while one can.
 */
export function subscribeUltracodeToggle(listener: () => void): () => void {
  window.addEventListener(ULTRACODE_TOGGLE_EVENT, listener);
  availableToggles.add(listener);
  return () => {
    window.removeEventListener(ULTRACODE_TOGGLE_EVENT, listener);
    availableToggles.delete(listener);
  };
}

const availableToggles = new Set<() => void>();

/** Whether the active composer's model and Claude instance offer ultracode. */
export function isUltracodeToggleAvailable(): boolean {
  return availableToggles.size > 0;
}
