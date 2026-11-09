import {
  TempoThreadMoveAlreadyMovedError,
  type TempoThreadMoveLink,
  type OrchestrationV2ServerCommand,
  type ThreadId,
} from "@t3tools/contracts";

/**
 * Commands a moved-away stub refuses: each starts or revives work, or rewrites
 * the thread's history or checkout. Reading, archiving, settling, deleting and
 * forking a stub still work; a fork is how a stub continues on this machine.
 */
const STUB_REFUSED_COMMANDS: ReadonlySet<OrchestrationV2ServerCommand["type"]> = new Set([
  "message.dispatch",
  "prepared-run.retry",
  "prepared-run.release",
  "queue.resume",
  "queued-run.edit",
  "queued-message.promote-to-steer",
  "checkpoint.rollback",
  "thread.merge_back",
  "delegated_task.request",
  "provider.switch",
]);

export function stubRefusesCommand(type: OrchestrationV2ServerCommand["type"]): boolean {
  return STUB_REFUSED_COMMANDS.has(type);
}

/** Why a command must not run on `thread`, or null when the thread did not move away. */
export function movedAwayRefusal(thread: {
  readonly id: ThreadId;
  readonly movedTo?: TempoThreadMoveLink | null | undefined;
}): TempoThreadMoveAlreadyMovedError | null {
  return thread.movedTo == null
    ? null
    : new TempoThreadMoveAlreadyMovedError({
        threadId: thread.id,
        environmentLabel: thread.movedTo.environmentLabel,
      });
}
