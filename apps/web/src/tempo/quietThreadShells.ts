import { useAtomValue } from "@effect/atom-react";
import { createQuietThreadShellsAtom } from "@t3tools/client-runtime/tempo/quiet-thread-shells";

import { environmentThreadShells } from "../state/threads";

/**
 * tempo: every thread shell, keeping a running thread's previous shell through its streaming ticks
 * (see `createQuietThreadShellsAtom`). For readers that stay mounted, such as the sidebar.
 */
export const quietThreadShellsAtom = createQuietThreadShellsAtom(
  environmentThreadShells.threadShellsAtom,
);

export function useQuietThreadShells() {
  return useAtomValue(quietThreadShellsAtom);
}
