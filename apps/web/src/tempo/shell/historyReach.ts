import type { RouterHistory } from "@tanstack/react-router";

export interface HistoryReach {
  readonly back: boolean;
  readonly forward: boolean;
}

/**
 * Whether Back and Forward lead anywhere. A push drops the entries ahead of it, so the deepest
 * entry still reachable is tracked from the history's own actions; entries ahead of the one this
 * page loaded on are unknown and count as none.
 */
export function createHistoryReach(history: RouterHistory) {
  let deepest = history.location.state.__TSR_index;
  const read = (): HistoryReach => {
    const index = history.location.state.__TSR_index;
    return { back: index > 0, forward: index < deepest };
  };
  let reach = read();
  return {
    subscribe: (onChange: () => void) =>
      history.subscribe(({ location, action }) => {
        const index = location.state.__TSR_index;
        deepest = action.type === "PUSH" ? index : Math.max(deepest, index);
        const next = read();
        if (next.back === reach.back && next.forward === reach.forward) return;
        reach = next;
        onChange();
      }),
    getSnapshot: () => reach,
  };
}
