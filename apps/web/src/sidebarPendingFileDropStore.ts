import { create } from "zustand";

import type { ScopedThreadRef } from "@t3tools/contracts";

/** Compare both ids; scopedThreadKey can collide when ids contain colons. */
export function isSameSidebarThreadRef(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

export interface SidebarPendingFileDrop {
  id: string;
  threadRef: ScopedThreadRef;
  files: File[];
}

interface SidebarPendingFileDropStoreState {
  pending: SidebarPendingFileDrop[];
  queuePendingFileDrop: (entry: Omit<SidebarPendingFileDrop, "id">) => string;
  clearPendingFileDrop: (id: string) => void;
  clearPendingFileDropsForThread: (threadRef: ScopedThreadRef) => void;
  consumePendingFileDrop: (threadRef: ScopedThreadRef) => File[] | null;
}

let nextPendingFileDropId = 0;

export const useSidebarPendingFileDropStore = create<SidebarPendingFileDropStoreState>()(
  (set, get) => ({
    pending: [],
    queuePendingFileDrop: (entry) => {
      const id = `sidebar-file-drop-${(nextPendingFileDropId += 1)}`;
      set((state) => ({ pending: [...state.pending, { ...entry, id }] }));
      return id;
    },
    clearPendingFileDrop: (id) => {
      set((state) => ({ pending: state.pending.filter((drop) => drop.id !== id) }));
    },
    clearPendingFileDropsForThread: (threadRef) => {
      set((state) => ({
        pending: state.pending.filter((drop) => !isSameSidebarThreadRef(drop.threadRef, threadRef)),
      }));
    },
    consumePendingFileDrop: (threadRef) => {
      const matches = get().pending.filter((drop) =>
        isSameSidebarThreadRef(drop.threadRef, threadRef),
      );
      if (matches.length === 0) {
        return null;
      }
      const matchedIds = new Set(matches.map((drop) => drop.id));
      set((state) => ({ pending: state.pending.filter((drop) => !matchedIds.has(drop.id)) }));
      return matches.flatMap((drop) => drop.files);
    },
  }),
);

/**
 * Hands files dropped on a thread's row to that thread's composer: they wait in the store while
 * `open` navigates there, and are dropped again when `open` fails or lands elsewhere.
 */
export async function openThreadWithDroppedFiles(input: {
  readonly drop: Omit<SidebarPendingFileDrop, "id">;
  readonly isOnThread: () => boolean;
  readonly open: () => Promise<unknown>;
}): Promise<void> {
  const { queuePendingFileDrop, clearPendingFileDrop } = useSidebarPendingFileDropStore.getState();
  const dropId = queuePendingFileDrop(input.drop);
  if (input.isOnThread()) return;
  try {
    await input.open();
  } catch (error) {
    clearPendingFileDrop(dropId);
    throw error;
  }
  if (!input.isOnThread()) clearPendingFileDrop(dropId);
}
