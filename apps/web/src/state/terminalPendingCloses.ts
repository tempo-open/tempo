import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/**
 * Tempo: terminals waiting out a close's Undo window. Their sessions still run, so the server still
 * lists them, and nothing may adopt one: it would be killed when the window ends.
 */
export const useTerminalPendingCloses = create<{ keys: ReadonlySet<string> }>(() => ({
  keys: new Set(),
}));

export function terminalPendingCloseKey(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  terminalId: string,
): string {
  return `${scopedThreadKey(scopeThreadRef(environmentId, threadId))}:${terminalId}`;
}

export function addTerminalPendingClose(key: string) {
  useTerminalPendingCloses.setState(({ keys }) => ({ keys: new Set(keys).add(key) }));
}

export function removeTerminalPendingClose(key: string) {
  useTerminalPendingCloses.setState(({ keys }) => {
    const next = new Set(keys);
    next.delete(key);
    return { keys: next };
  });
}
