import type { EnvironmentId, ThreadContextRecord } from "@t3tools/contracts";
import { collectInlineContextIds } from "../../lib/composerContextReferences";

/** Attached threads the prompt still links to; replacing linked text leaves stale records. */
export function referencedThreadContexts(draft: {
  readonly prompt: string;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
}): ReadonlyArray<ThreadContextRecord> {
  if (draft.threadContexts.length === 0) return [];
  const referenced = new Set(collectInlineContextIds(draft.prompt));
  return draft.threadContexts.filter((record) => referenced.has(record.contextId));
}

/** Why a send waits for the user to pick a machine when no machine was chosen automatically. */
export function loadBalancingSendWarning(input: {
  readonly pending: boolean;
  readonly threadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly candidateEnvironmentIds: ReadonlyArray<EnvironmentId>;
}) {
  if (input.pending) {
    return {
      title: "Checking machine resources",
      description: "Resource checks are still running. You can choose a machine in the composer.",
    };
  }
  const noMachineReadsEveryThread =
    input.threadContexts.length > 0 &&
    !input.candidateEnvironmentIds.some((environmentId) =>
      input.threadContexts.every((record) => record.environmentId === environmentId),
    );
  return {
    title: "Choose a machine to continue",
    description: noMachineReadsEveryThread
      ? "No machine can read every attached thread. Choose a machine in the composer or remove the threads."
      : "No eligible machine has available resources. Choose a machine in the composer to override.",
  };
}

/**
 * Why a multiple-model send cannot start: the server predates worktree bootstrap, or the
 * draft is not a new thread on a Git branch with at least one model.
 */
export function multipleModelSendBlock(input: {
  readonly selectionCount: number;
  readonly serverSupportsWorktreeBootstrap: boolean;
  readonly isLocalDraftThread: boolean;
  readonly isGitRepo: boolean;
  readonly branch: string | null;
}): "server-outdated" | "needs-new-git-thread" | null {
  if (!input.serverSupportsWorktreeBootstrap) return "server-outdated";
  if (
    !input.isLocalDraftThread ||
    !input.isGitRepo ||
    !input.branch ||
    input.selectionCount === 0
  ) {
    return "needs-new-git-thread";
  }
  return null;
}

/** Why a message sent over pending approvals did not go out, or null to stop quietly. */
export function approvalRedirectNotice(input: {
  readonly draftChanged: boolean;
  readonly declined: boolean;
  readonly approvalResponding: boolean;
  readonly approvalArrived: boolean;
}): string | null {
  if (input.draftChanged) {
    return input.declined
      ? "Approval declined. Your message changed, so it wasn't sent."
      : "Your message changed, so it wasn't sent.";
  }
  if (input.approvalResponding) {
    return "An approval is already being answered, so your message wasn't sent.";
  }
  if (input.declined && input.approvalArrived) {
    return "Another approval arrived, so your message wasn't sent.";
  }
  return null;
}

export interface ComposerDispatchLine {
  pending: number;
  /** A send owns the composer's content until it clears the composer. */
  held: boolean;
  /** A failed send was put back into the composer while it was held. */
  heldDisturbed: boolean;
  /** True once every send in the line reached the server. */
  tail: Promise<boolean>;
}

export function emptyComposerDispatchLine(): ComposerDispatchLine {
  return { pending: 0, held: false, heldDisturbed: false, tail: Promise.resolve(true) };
}

/**
 * tempo: whether a send queues behind an earlier one instead of being dropped. On a server thread
 * that is a composer send that cleared the composer but has not reached the server, or a
 * composer send the server has not confirmed yet.
 */
export function followsPendingComposerSend(input: {
  readonly isServerThread: boolean;
  readonly line: ComposerDispatchLine;
  readonly composerSendConfirming: boolean;
}): boolean {
  return input.isServerThread && (input.line.pending > 0 || input.composerSendConfirming);
}

/**
 * Joins the thread's dispatch line. `previous` resolves once every earlier send has settled,
 * true only if all of them reached the server. `settle` records this send's outcome, lets the
 * next one go, and calls `onIdle` when the line empties.
 */
export function joinComposerDispatchLine(line: ComposerDispatchLine, onIdle: () => void) {
  const previous = line.tail;
  let release: (sent: boolean) => void = () => {};
  const own = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  // A send that settles early must not let a later one pass an earlier one still dispatching.
  line.tail = Promise.all([previous, own]).then(([before, sent]) => before && sent);
  line.pending += 1;
  let settled = false;
  return {
    previous,
    settle: (sent: boolean) => {
      if (settled) return;
      settled = true;
      release(sent);
      line.pending -= 1;
      if (line.pending > 0) return;
      // A failure only holds back sends queued behind it, not the next send after the line empties.
      line.tail = Promise.resolve(true);
      onIdle();
    },
  };
}
