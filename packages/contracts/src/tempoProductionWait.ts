/**
 * tempo: Waiting for Production. A thread whose work is merged to staging can wait for the next
 * production promotion of the repository the server's TEMPO_PRODUCTION_REPOSITORY names; the server then wakes every waiting thread with a message. The wait
 * is stored as the ISO time it started (`waitingForProductionSince`), so the persisted thread
 * JSON needs no codec of its own.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";
import type { TempoThreadMoveLink } from "./tempoThreadMove.ts";

/**
 * Why a thread cannot start waiting. Settling and archiving end a wait, so a
 * settled or archived thread never waits; a subagent reports to its parent
 * thread, which owns the work; a stub left by a move continues elsewhere. A
 * server that names no production repository holds no waits.
 */
export const TempoProductionWaitRefusal = Schema.Literals([
  "unconfigured",
  "notFound",
  "archived",
  "settled",
  "subagent",
  "movedAway",
]);
export type TempoProductionWaitRefusal = typeof TempoProductionWaitRefusal.Type;

const REFUSAL_MESSAGES: Record<TempoProductionWaitRefusal, string> = {
  unconfigured:
    "Waiting for production is off on this environment. Set TEMPO_PRODUCTION_REPOSITORY to the GitHub repository (owner/name) whose production deployments end a wait, where its server runs.",
  notFound: "This thread no longer exists.",
  archived: "An archived thread can't wait for production. Unarchive it first.",
  settled: "A settled thread can't wait for production. Un-settle it first.",
  subagent: "A subagent can't wait for production; its parent thread owns the work.",
  movedAway: "This thread moved to another machine. Wait for production from its copy there.",
};

export function tempoProductionWaitRefusalMessage(reason: TempoProductionWaitRefusal): string {
  return REFUSAL_MESSAGES[reason];
}

/** Why `thread` may not start waiting for production, or null when it may. */
export function tempoProductionWaitRefusal(thread: {
  readonly deletedAt: unknown;
  readonly archivedAt: unknown;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: unknown;
  readonly lineage: { readonly relationshipToParent: "fork" | "subagent" | null };
  readonly movedTo?: TempoThreadMoveLink | null | undefined;
}): TempoProductionWaitRefusal | null {
  if (thread.deletedAt !== null) return "notFound";
  if (thread.movedTo != null) return "movedAway";
  if (thread.archivedAt !== null) return "archived";
  if (thread.settledOverride === "settled" || thread.settledAt !== null) return "settled";
  if (thread.lineage.relationshipToParent === "subagent") return "subagent";
  return null;
}

/** The wait field a thread shell carries; omitted for threads that are not waiting. */
export function tempoProductionWaitShellFields(thread: {
  readonly waitingForProductionSince?: string | null | undefined;
}): { readonly waitingForProductionSince?: string } {
  return thread.waitingForProductionSince == null
    ? {}
    : { waitingForProductionSince: thread.waitingForProductionSince };
}

export const TempoProductionWaitSetInput = Schema.Struct({
  threadId: ThreadId,
  /** True starts waiting (keeping an earlier start), false stops. */
  waiting: Schema.Boolean,
});
export type TempoProductionWaitSetInput = typeof TempoProductionWaitSetInput.Type;

export const TempoProductionWaitSetResult = Schema.Struct({
  /** When the thread started waiting; null once it stopped. */
  waitingForProductionSince: Schema.NullOr(IsoDateTime),
});
export type TempoProductionWaitSetResult = typeof TempoProductionWaitSetResult.Type;

export class TempoProductionWaitRefusedError extends Schema.TaggedError<TempoProductionWaitRefusedError>()(
  "TempoProductionWaitRefusedError",
  { threadId: ThreadId, reason: TempoProductionWaitRefusal },
) {
  override get message(): string {
    return tempoProductionWaitRefusalMessage(this.reason);
  }
}

export class TempoProductionWaitFailedError extends Schema.TaggedError<TempoProductionWaitFailedError>()(
  "TempoProductionWaitFailedError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not change whether this thread waits for production. Try again.";
  }
}

export const TempoProductionWaitError = Schema.Union([
  TempoProductionWaitRefusedError,
  TempoProductionWaitFailedError,
]);
export type TempoProductionWaitError = typeof TempoProductionWaitError.Type;

export const TEMPO_PRODUCTION_WAIT_WS_METHODS = {
  set: "tempo.productionWait.set",
} as const;

export const TempoProductionWaitSetRpc = Rpc.make(TEMPO_PRODUCTION_WAIT_WS_METHODS.set, {
  payload: TempoProductionWaitSetInput,
  success: TempoProductionWaitSetResult,
  error: Schema.Union([TempoProductionWaitError, EnvironmentAuthorizationError]),
});
