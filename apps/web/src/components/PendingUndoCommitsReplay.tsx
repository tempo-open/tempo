import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect } from "react";

import {
  type PendingUndoCommit,
  forgetPendingUndoCommit,
  readPendingUndoCommits,
} from "../hooks/pendingUndoCommits";
import { THREAD_UNDO_WINDOW_MS } from "../hooks/showThreadUndoNotice";
import { useStableCallback } from "../hooks/useStableCallback";
import { hideThreadPendingDelete, useThreadActions } from "../hooks/useThreadActions";
import { useAllEnvironmentShellsBootstrapped } from "../state/entities";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";

/**
 * Tempo: runs what an Undo window was holding back when its window closed. A record that is still
 * inside its Undo window may belong to another open window, so it waits that out and looks again.
 */
export function PendingUndoCommitsReplay() {
  const ready = useAllEnvironmentShellsBootstrapped();
  const { deleteThread } = useThreadActions();
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });

  const run = useStableCallback(async (commit: PendingUndoCommit) => {
    const environmentId = EnvironmentId.make(commit.environmentId);
    const threadId = ThreadId.make(commit.threadId);
    if (commit.kind === "close-terminal") {
      await closeTerminal({
        environmentId,
        input: { threadId, terminalId: commit.terminalId, deleteHistory: true },
      });
    } else {
      const target = { environmentId, threadId };
      const hidden = hideThreadPendingDelete(target);
      const result = await deleteThread(target, { askAboutWorktree: false });
      if (result._tag === "Success") hidden.releaseOnceGone();
      else hidden.release();
    }
    forgetPendingUndoCommit(commit);
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- runs saved actions once the threads are known, which is not derived state
  useEffect(() => {
    if (!ready) return;
    const timers = readPendingUndoCommits().map((commit) =>
      setTimeout(
        () => {
          const stillPending = readPendingUndoCommits().some(
            (other) => JSON.stringify(other) === JSON.stringify(commit),
          );
          if (stillPending) void run(commit);
        },
        Math.max(0, commit.at + THREAD_UNDO_WINDOW_MS + 1_000 - Date.now()),
      ),
    );
    return () => {
      for (const timer of timers) clearTimeout(timer);
    };
  }, [ready, run]);

  return null;
}
