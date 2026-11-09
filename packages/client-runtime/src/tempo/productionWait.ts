/**
 * tempo: Waiting for Production on clients. Which threads sit on the shelf, which
 * can start waiting, and the command that starts or stops a wait. Shared by
 * web and mobile; each builds the command on its own connection runtime.
 */
import {
  TEMPO_PRODUCTION_WAIT_WS_METHODS,
  tempoProductionWaitRefusal,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { threadRuntimeIsActive, type EnvironmentThreadShell } from "../state/models.ts";
import { createEnvironmentRpcCommand } from "../state/runtime.ts";

/** The server shell fields a wait reads; clients keep the whole shell as `source`. */
interface ProductionWaitSource {
  readonly source: Pick<OrchestrationV2ThreadShell, "waitingForProductionSince" | "movedTo">;
}

/** When the thread started waiting for production; null while it does not wait. */
export function productionWaitSince(thread: ProductionWaitSource): string | null {
  return thread.source.waitingForProductionSince ?? null;
}

/**
 * Whether a thread belongs on the Waiting for Production shelf: it waits and
 * nothing needs the user. A running thread still reads as working, and one
 * asking for an approval or an answer, its own or a subagent's, stays in the
 * inbox. Snooze outranks the shelf, so callers classify snoozed threads first.
 */
export function onProductionWaitShelf(
  thread: ProductionWaitSource &
    Pick<
      EnvironmentThreadShell,
      "runtime" | "hasPendingApprovals" | "hasPendingUserInput" | "pendingSubagentRequest"
    >,
): boolean {
  return (
    productionWaitSince(thread) !== null &&
    !threadRuntimeIsActive(thread.runtime) &&
    !thread.hasPendingApprovals &&
    !thread.hasPendingUserInput &&
    thread.pendingSubagentRequest == null
  );
}

/**
 * The production wait action a thread's menu offers: stop for a waiting
 * thread, start for one that may wait (not settled, archived, a subagent or a
 * moved-away stub), or none.
 */
export function productionWaitAction(
  thread: ProductionWaitSource &
    Pick<
      EnvironmentThreadShell,
      "deletedAt" | "archivedAt" | "settledOverride" | "settledAt" | "lineage"
    >,
): "start" | "stop" | null {
  if (productionWaitSince(thread) !== null) return "stop";
  return tempoProductionWaitRefusal({ ...thread, movedTo: thread.source.movedTo }) === null
    ? "start"
    : null;
}

export function createProductionWaitCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentRpcCommand(runtime, {
    label: "environment-command:tempo-production-wait:set",
    tag: TEMPO_PRODUCTION_WAIT_WS_METHODS.set,
  });
}
