import * as Schema from "effect/Schema";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";

/**
 * Tempo: an Undo window holds an action back from the server, and a window that closes takes the
 * timer with it. These records outlive the window, so the action still happens when one opens again.
 */
const PENDING_UNDO_COMMITS_KEY = "tempo:pending-undo-commits:v1";

const PendingUndoCommit = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("delete-thread"),
    environmentId: Schema.String,
    threadId: Schema.String,
    at: Schema.Number,
  }),
  Schema.Struct({
    kind: Schema.Literal("close-terminal"),
    environmentId: Schema.String,
    threadId: Schema.String,
    terminalId: Schema.String,
    at: Schema.Number,
  }),
]);
export type PendingUndoCommit = typeof PendingUndoCommit.Type;
const PendingUndoCommits = Schema.Array(PendingUndoCommit);

export function readPendingUndoCommits(): ReadonlyArray<PendingUndoCommit> {
  try {
    return getLocalStorageItem(PENDING_UNDO_COMMITS_KEY, PendingUndoCommits) ?? [];
  } catch {
    return [];
  }
}

function writePendingUndoCommits(commits: ReadonlyArray<PendingUndoCommit>) {
  try {
    setLocalStorageItem(PENDING_UNDO_COMMITS_KEY, commits, PendingUndoCommits);
  } catch (error) {
    console.error("Could not save an action waiting out its Undo window.", error);
  }
}

const sameCommit = (a: PendingUndoCommit, b: PendingUndoCommit) =>
  a.kind === b.kind &&
  a.environmentId === b.environmentId &&
  a.threadId === b.threadId &&
  a.at === b.at &&
  (a.kind !== "close-terminal" || b.kind !== "close-terminal" || a.terminalId === b.terminalId);

export function forgetPendingUndoCommit(commit: PendingUndoCommit) {
  writePendingUndoCommits(readPendingUndoCommits().filter((other) => !sameCommit(other, commit)));
}

/** Saves an action until the returned function says it was undone or has run. */
export function rememberPendingUndoCommit(commit: PendingUndoCommit): () => void {
  writePendingUndoCommits([...readPendingUndoCommits(), commit]);
  return () => forgetPendingUndoCommit(commit);
}
