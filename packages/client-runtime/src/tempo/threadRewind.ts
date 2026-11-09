import type {
  CommandId,
  MessageId,
  OrchestrationV2Checkpoint,
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
  OrchestrationV2UserMessageInputIntent,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { ThreadCheckpointSummary } from "../state/threadCheckpoints.ts";

/**
 * Edit from here, shared by web and mobile: rewinding a thread to before a sent message so
 * that message can be edited and sent again. On a working thread the server stops the turn
 * first.
 */

export function findRevertCheckpoint(
  checkpoints: ReadonlyArray<OrchestrationV2Checkpoint>,
  turnCount: number,
): OrchestrationV2Checkpoint | undefined {
  return checkpoints.findLast(
    (checkpoint) =>
      // A checkpoint with no saved files, the thread start's included, still rewinds the chat.
      (checkpoint.status === "ready" || checkpoint.status === "missing") &&
      (turnCount === 0
        ? checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null
        : checkpoint.appRunOrdinal === turnCount),
  );
}

/**
 * Run ordinals the conversation can be reverted to: those whose provider turn belongs to the
 * active provider thread, plus 0 for the thread start. Empty without a live provider session
 * on the thread's selected instance.
 */
export function deriveAvailableRevertTurnCounts(
  projection:
    | (Pick<
        OrchestrationV2ThreadProjection,
        "providerThreads" | "attempts" | "providerTurns" | "runs"
      > & {
        readonly thread: Pick<
          OrchestrationV2ThreadProjection["thread"],
          "activeProviderThreadId" | "modelSelection"
        >;
      })
    | null,
): Set<number> {
  const available = new Set<number>();
  const providerThread = projection?.providerThreads.find(
    (candidate) => candidate.id === projection.thread.activeProviderThreadId,
  );
  if (
    !providerThread?.providerSessionId ||
    providerThread.providerInstanceId !== projection?.thread.modelSelection.instanceId
  )
    return available;
  available.add(0);
  const attemptsById = new Map(projection.attempts.map((attempt) => [attempt.id, attempt]));
  const providerTurnsById = new Map<
    OrchestrationV2ProviderTurn["id"],
    OrchestrationV2ProviderTurn
  >();
  const latestTurnByAttempt = new Map<RunAttemptId, OrchestrationV2ProviderTurn>();
  for (const turn of projection.providerTurns) {
    providerTurnsById.set(turn.id, turn);
    if (turn.runAttemptId === null) continue;
    const latest = latestTurnByAttempt.get(turn.runAttemptId);
    if (latest === undefined || turn.ordinal > latest.ordinal) {
      latestTurnByAttempt.set(turn.runAttemptId, turn);
    }
  }
  for (const run of projection.runs) {
    if (run.activeAttemptId === null) continue;
    const attempt = attemptsById.get(run.activeAttemptId);
    const providerTurn =
      latestTurnByAttempt.get(run.activeAttemptId) ??
      (attempt?.providerTurnId == null ? undefined : providerTurnsById.get(attempt.providerTurnId));
    // A ready file checkpoint alone cannot restore the provider conversation.
    if (providerTurn?.providerThreadId === providerThread.id) available.add(run.ordinal);
  }
  return available;
}

/** A timeline row that belongs to a run, in display order. */
export interface RevertTimelineRow {
  readonly runId: RunId;
  /** History a fork inherited belongs to its source thread, not this thread's checkpoints. */
  readonly inherited: boolean;
  readonly userMessage?: {
    readonly id: MessageId;
    readonly inputIntent: OrchestrationV2UserMessageInputIntent | undefined;
  };
}

/**
 * The turn count each editable user message rewinds to: the checkpoint of the visible run
 * before it. Run ordinals keep increasing after a rewind, so only visible local runs define
 * predecessors. A running turn is editable too; the server stops it before rewinding.
 */
export function deriveRevertTurnCounts(input: {
  readonly rows: Iterable<RevertTimelineRow>;
  readonly checkpoints: ReadonlyArray<
    Pick<ThreadCheckpointSummary, "runId" | "checkpointTurnCount" | "status">
  >;
  readonly threadStartCheckpointReady: boolean;
  readonly availableRevertTurnCounts?: ReadonlySet<number> | undefined;
}): Map<MessageId, number> {
  const readyTurnCountByRunId = new Map<RunId, number>();
  for (const checkpoint of input.checkpoints) {
    // A turn with no saved files (a folder that is not a Git repository) still rewinds the chat.
    if (checkpoint.status === "ready" || checkpoint.status === "missing") {
      readyTurnCountByRunId.set(checkpoint.runId, checkpoint.checkpointTurnCount);
    }
  }
  const targetByRunId = new Map<RunId, number | undefined>();
  const byUserMessageId = new Map<MessageId, number>();
  let previousRunId: RunId | null = null;
  for (const row of input.rows) {
    if (row.inherited) continue;
    if (!targetByRunId.has(row.runId)) {
      targetByRunId.set(
        row.runId,
        previousRunId === null
          ? input.threadStartCheckpointReady
            ? 0
            : undefined
          : readyTurnCountByRunId.get(previousRunId),
      );
      previousRunId = row.runId;
    }
    const message = row.userMessage;
    if (message === undefined) continue;
    if (message.inputIntent !== "turn_start" && message.inputIntent !== "queued_turn") continue;
    const target = targetByRunId.get(row.runId);
    if (
      target !== undefined &&
      (input.availableRevertTurnCounts === undefined || input.availableRevertTurnCounts.has(target))
    )
      byUserMessageId.set(message.id, target);
  }
  return byUserMessageId;
}

/**
 * Whether "Revert files too" applies: the edited turn saved files. A turn still running has
 * saved no checkpoint yet, so the restore point answers for it.
 */
export function rewindRestoresFiles(input: {
  readonly runId: RunId | null;
  readonly checkpointSummaries: ReadonlyArray<Pick<ThreadCheckpointSummary, "runId" | "status">>;
  readonly target: Pick<OrchestrationV2Checkpoint, "status"> | undefined;
}): boolean {
  const ownCheckpoint = input.checkpointSummaries.find((summary) => summary.runId === input.runId);
  return (ownCheckpoint ?? input.target)?.status === "ready";
}

type RewindProjection = Pick<
  OrchestrationV2ThreadProjection,
  "thread" | "providerThreads" | "runs"
>;

/**
 * Runs `revert` and resolves once the thread has rewound to `turnCount`, or rejects with the
 * server's reason. A run still working counts: the rewind stops it, then rolls it back.
 */
export function waitForThreadRewind(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly stateAtom: Atom.Atom<{ readonly data: Option.Option<RewindProjection> }>;
  readonly turnCount: number;
  readonly requestId: CommandId;
  readonly revert: () => Promise<void>;
  readonly timeoutMs?: number;
}): Promise<void> {
  const { registry, stateAtom, turnCount, requestId } = input;
  const readProjection = () => Option.getOrNull(registry.get(stateAtom).data);
  const initial = readProjection();
  const providerThreadId = initial?.thread.activeProviderThreadId;
  const initialProviderThread = initial?.providerThreads.find(
    (providerThread) => providerThread.id === providerThreadId,
  );
  const initialProviderThreadIds = new Set(initial?.providerThreads.map((thread) => thread.id));
  // Paging can omit the source run. Rollback commits the entire settled suffix atomically.
  const witness = initial?.runs.reduce<(typeof initial.runs)[number] | undefined>((latest, run) => {
    if (run.ordinal <= turnCount || run.status === "queued" || run.status === "rolled_back")
      return latest;
    return latest === undefined || run.ordinal > latest.ordinal ? run : latest;
  }, undefined);
  if (witness === undefined) {
    return Promise.reject(new Error("The thread has changed. Select a message to rewind again."));
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let accepted = false;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) globalThis.clearTimeout(timeout);
      unsubscribe();
      if (error !== undefined) reject(error);
      else resolve();
    };
    const inspect = () => {
      const thread = readProjection();
      if (!thread) return;
      const failure = thread.thread.rollbackFailure;
      if (failure?.requestId === requestId) {
        finish(new Error(failure.message));
        return;
      }
      if (
        accepted &&
        thread.providerThreads.some(
          (providerThread) =>
            (providerThread.id === providerThreadId ||
              // Claude resets to a fresh root session when rewinding to thread start.
              (turnCount === 0 &&
                providerThread.ownerNodeId === null &&
                providerThread.appThreadId === initial?.thread.id &&
                providerThread.providerInstanceId === initialProviderThread?.providerInstanceId &&
                !initialProviderThreadIds.has(providerThread.id))) &&
            providerThread.lastRunOrdinal === (turnCount === 0 ? null : turnCount),
        ) &&
        thread.runs.some((run) => run.id === witness.id && run.status === "rolled_back")
      )
        finish();
    };
    unsubscribe = registry.subscribe(stateAtom, inspect);
    // @effect-diagnostics-next-line globalTimers:off - Clients await the rewind as a promise, outside an Effect runtime.
    timeout = globalThis.setTimeout(() => {
      finish(new Error("Timed out waiting for the thread to rewind."));
    }, input.timeoutMs ?? 120_000);
    Promise.resolve()
      .then(input.revert)
      .then(() => {
        accepted = true;
        inspect();
      }, finish);
  });
}
