import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { create } from "zustand";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { shortcutLabelForCommand } from "../keybindings";
import { announce, cancelAnnouncement } from "../lib/announce";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { primaryServerKeybindingsAtom } from "../state/server";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";

type UndoOptions = {
  action: "Settled" | "Snoozed" | "Unpinned" | "Archived" | "Discarded" | "Deleted" | "Closed";
  undo: () => Promise<AtomCommandResult<unknown, unknown>>;
  failureTitle: string;
  claim: ReturnType<typeof ThreadUndo.begin>;
  commit?: () => void;
};

type UndoNotice = {
  action: UndoOptions["action"];
  count: number;
  undo: () => Promise<void>;
};

export const THREAD_UNDO_WINDOW_MS = 5_000;

export const useThreadUndoNotice = create<{ notice: UndoNotice | null }>(() => ({ notice: null }));

/** Tempo: threads waiting out a delete's Undo window, so lists of archived threads can skip them. */
export const useThreadPendingDeletes = create<{ keys: ReadonlySet<string> }>(() => ({
  keys: new Set(),
}));

export function addThreadPendingDelete(threadKey: string) {
  useThreadPendingDeletes.setState(({ keys }) => ({ keys: new Set(keys).add(threadKey) }));
}

export function removeThreadPendingDelete(threadKey: string) {
  useThreadPendingDeletes.setState(({ keys }) => {
    const next = new Set(keys);
    next.delete(threadKey);
    return { keys: next };
  });
}

export function threadUndoNoticeSummary(notice: Pick<UndoNotice, "action" | "count">): string {
  const noun =
    notice.action === "Discarded" ? "draft" : notice.action === "Closed" ? "terminal" : "thread";
  return `${notice.action} ${notice.count} ${noun}${notice.count === 1 ? "" : "s"}`;
}

export function threadUndoLabel(keybindings: Parameters<typeof shortcutLabelForCommand>[0]) {
  const shortcut = shortcutLabelForCommand(keybindings, "thread.undo");
  return shortcut ? `${shortcut} to undo` : "Undo";
}

let announcedSummary: string | null = null;

// A live region that mounts already filled is skipped by screen readers, and settling
// usually moves focus to the next thread at the same moment, so the notice is announced
// separately from the alert that shows it.
function setNotice(notice: UndoNotice | null) {
  useThreadUndoNotice.setState({ notice });
  const summary = notice ? threadUndoNoticeSummary(notice) : null;
  if (summary === announcedSummary) return;
  announcedSummary = summary;
  if (summary) {
    const label = threadUndoLabel(appAtomRegistry.get(primaryServerKeybindingsAtom));
    announce(`${summary}, ${label}`, "thread-undo-notice");
  } else {
    cancelAnnouncement("thread-undo-notice");
  }
}

let liveUndos: UndoOptions[] = [];
let expiry: ReturnType<typeof setTimeout> | undefined;
// A new notice owns mod+z even inside a text field, until the user presses
// another key or edits text. After that, mod+z is the field's own undo again.
let shortcutClaimed = false;

function refreshNotice() {
  const stale = liveUndos.filter(({ claim }) => !claim.isCurrent());
  liveUndos = liveUndos.filter((entry) => !stale.includes(entry));
  for (const entry of stale) entry.commit?.();
  const latest = liveUndos.at(-1);
  if (!latest) {
    clearTimeout(expiry);
    setNotice(null);
    return;
  }
  const group: UndoOptions[] = [];
  for (let index = liveUndos.length - 1; index >= 0; index--) {
    const entry = liveUndos[index]!;
    if (entry.action !== latest.action) break;
    group.push(entry);
  }
  setNotice({
    action: latest.action,
    count: group.length,
    undo: async () => {
      const current = group.filter((entry) => liveUndos.includes(entry) && entry.claim.isCurrent());
      liveUndos = liveUndos.filter((entry) => !group.includes(entry));
      // Claim before awaiting to prevent repeated actions restoring a group twice.
      for (const entry of current) entry.claim.finish();
      refreshNotice();
      await Promise.all(
        current.map(async ({ undo, failureTitle }) => {
          const reportFailure = (error: unknown) => {
            toastManager.add(
              stackedThreadToast({
                type: "error",
                title: failureTitle,
                description: error instanceof Error ? error.message : "An error occurred.",
              }),
            );
          };
          try {
            const result = await undo();
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              reportFailure(squashAtomCommandFailure(result));
            }
          } catch (error) {
            reportFailure(error);
          }
        }),
      );
    },
  });
}

ThreadUndo.subscribe(refreshNotice);

export function undoLatestThreadAction(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  if (!notice) return false;
  void notice.undo();
  return true;
}

/** Whether mod+z should undo the notice's actions even while a text field is focused. */
export function threadUndoClaimsShortcut(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  // tempo: the sidebar hides Settled notices, so text fields keep their own undo.
  return shortcutClaimed && notice !== null && notice.action !== "Settled";
}

/** Whether a notice is on screen. tempo: the sidebar hides Settled notices. */
export function threadUndoNoticeShown(): boolean {
  const notice = useThreadUndoNotice.getState().notice;
  return notice !== null && notice.action !== "Settled";
}

/** Called on any other keypress or text edit; hands mod+z back to text fields. */
export function releaseThreadUndoShortcut() {
  shortcutClaimed = false;
}

/** Shows one compact confirmation for the currently undoable thread actions. */
export function showThreadUndoNotice(options: UndoOptions) {
  if (!options.claim.isCurrent()) return;
  liveUndos.push(options);
  shortcutClaimed = true;
  refreshNotice();
  clearTimeout(expiry);
  expiry = setTimeout(commitThreadUndosNow, THREAD_UNDO_WINDOW_MS);
}

/** Ends the Undo window: whatever it was holding back happens now. */
export function commitThreadUndosNow() {
  clearTimeout(expiry);
  const expired = liveUndos;
  liveUndos = [];
  for (const { claim, commit } of expired) {
    claim.finish();
    commit?.();
  }
  refreshNotice();
}

// Tempo: a window that closes takes the timer with it. What cannot finish in time runs from
// pendingUndoCommits when a window opens again.
if (typeof window !== "undefined") window.addEventListener("pagehide", commitThreadUndosNow);
