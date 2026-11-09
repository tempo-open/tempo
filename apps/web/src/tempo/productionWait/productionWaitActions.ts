import {
  createProductionWaitCommand,
  productionWaitAction,
} from "@t3tools/client-runtime/tempo/production-wait";
import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  AuthOrchestrationOperateScope,
  type ContextMenuItem,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope } from "../../state/session";

const productionWaitCommand = createProductionWaitCommand(connectionAtomRuntime);

/** Whether the environment's server can hold a production wait. */
function readEnvironmentSupportsProductionWait(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .tempoProductionWait === true
  );
}

/** The production wait action `thread`'s menus offer, or null when its server has none. */
export function readProductionWaitAction(thread: EnvironmentThreadShell): "start" | "stop" | null {
  return readEnvironmentSupportsProductionWait(thread.environmentId)
    ? productionWaitAction(thread)
    : null;
}

type ProductionWaitMenuId = "tempo-production-wait:start" | "tempo-production-wait:stop";

export function isProductionWaitMenuId(id: string): id is ProductionWaitMenuId {
  return id === "tempo-production-wait:start" || id === "tempo-production-wait:stop";
}

/** Whether a clicked production wait item starts waiting (true) or stops (false). */
export function productionWaitMenuStarts(id: ProductionWaitMenuId): boolean {
  return id === "tempo-production-wait:start";
}

/** A context menu, or one another Tempo wrapper already extended with its own item ids. */
interface ThreadContextMenu<Extra extends string> {
  readonly show: <T extends string>(
    items: ReadonlyArray<ContextMenuItem<T>>,
    position?: { x: number; y: number },
  ) => Promise<T | Extra | null>;
}

/**
 * Wraps a context menu's `show` so a thread's menu also offers "Wait for
 * production" or "Stop waiting for production" among the lifecycle actions,
 * right before Rename.
 */
export function withProductionWaitMenuItem<Extra extends string>(
  contextMenu: ThreadContextMenu<Extra>,
  thread: EnvironmentThreadShell,
): ThreadContextMenu<Extra | ProductionWaitMenuId> {
  return {
    show: <T extends string>(
      items: ReadonlyArray<ContextMenuItem<T>>,
      position?: { x: number; y: number },
    ) => {
      const action = readProductionWaitAction(thread);
      if (action === null) return contextMenu.show(items, position);
      const item: ContextMenuItem<ProductionWaitMenuId> = {
        id: action === "start" ? "tempo-production-wait:start" : "tempo-production-wait:stop",
        label: action === "start" ? "Wait for production" : "Stop waiting for production",
        icon: "rocket",
        disabled: !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
      };
      const at = items.findIndex((candidate) => candidate.id === "rename");
      return contextMenu.show<T | ProductionWaitMenuId>(
        at === -1 ? [...items, item] : [...items.slice(0, at), item, ...items.slice(at)],
        position,
      );
    },
  };
}

/** Starts or stops a thread's wait for production, with a toast saying what happened. */
export async function setProductionWait(threadRef: ScopedThreadRef, waiting: boolean) {
  const result = await runAtomCommand(
    appAtomRegistry,
    productionWaitCommand,
    { environmentId: threadRef.environmentId, input: { threadId: threadRef.threadId, waiting } },
    { reportFailure: false },
  );
  if (result._tag === "Success") {
    if (waiting) {
      toastManager.add(
        stackedThreadToast({
          type: "success",
          title: "Waiting for production",
          description: "The thread continues once staging is promoted to production.",
        }),
      );
    }
    return;
  }
  if (isAtomCommandInterrupted(result)) return;
  const error = squashAtomCommandFailure(result);
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title: waiting ? "Could not wait for production" : "Could not stop waiting for production",
      description: error instanceof Error ? error.message : "An error occurred.",
    }),
  );
}
