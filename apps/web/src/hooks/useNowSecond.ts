import { secondTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

export function useNowSecond(): number {
  return useSyncExternalStore(secondTick.subscribe, secondTick.getSnapshot, secondTick.getSnapshot);
}

/**
 * tempo: the shared tick as the text `format` makes of it. The caller re-renders only when that text
 * changes, so a label that reads in minutes repaints once a minute.
 */
export function useNowSecondLabel(format: (nowMs: number) => string): string {
  const read = () => format(secondTick.getSnapshot());
  return useSyncExternalStore(secondTick.subscribe, read, read);
}
