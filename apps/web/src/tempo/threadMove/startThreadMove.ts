import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createThreadMoveEnvironmentAtoms,
  isThreadMoveRefusal,
  runThreadMove,
  threadMoveCallsFromAtoms,
  threadMoveTargets,
  transferThreadMoveArchive,
  type ThreadMoveEnvironment,
  type ThreadMoveFinalizeOutcome,
  type ThreadMoveStep,
} from "@t3tools/client-runtime/tempo/thread-move";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  threadRuntimeIsActive,
  type ThreadRuntimeSummary,
} from "@t3tools/client-runtime/state/models";
import {
  TEMPO_THREAD_MOVE_SOURCE_SCOPES,
  TEMPO_THREAD_MOVE_TARGET_SCOPES,
  TempoThreadMoveFolderUnavailableError,
  TempoThreadMoveProjectNotFoundError,
  TempoThreadMoveRepositoryRequiredError,
  EnvironmentId,
  isTempoThreadMovedAway,
  type AuthEnvironmentScope,
  type ContextMenuItem,
  type TempoThreadMoveLink,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { APP_BASE_NAME } from "../../branding";
import { toastManager } from "../../components/ui/toast";
import { stackedThreadToast } from "../../components/ui/toastHelpers";
import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentPresentations } from "../../state/presentation";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { environmentServerConfigsAtom } from "../../state/server";
import { readEnvironmentScope, readPreparedConnection } from "../../state/session";

const threadMoveCommands = createThreadMoveEnvironmentAtoms(connectionAtomRuntime);

// Defined `actionProps` that hide a previous toast's button on `toastManager.update`; passing
// `actionProps: undefined` is a no-op because updates omit undefined keys.
const hiddenToastActionProps = { children: null } as const;

/** Context menu ids: the "Move to" parent and `tempo-move:<environmentId>` for each machine. */
export type ThreadMoveMenuId = "tempo-move" | `tempo-move:${string}`;
const THREAD_MOVE_MENU_PREFIX = "tempo-move:";

export function isThreadMoveMenuId(id: string): id is ThreadMoveMenuId {
  return id === "tempo-move" || id.startsWith(THREAD_MOVE_MENU_PREFIX);
}

/** The machine a clicked move item names; null for the "Move to" parent. */
export function threadMoveMenuTarget(id: ThreadMoveMenuId): EnvironmentId | null {
  return id === "tempo-move" ? null : EnvironmentId.make(id.slice(THREAD_MOVE_MENU_PREFIX.length));
}

function readCapabilities(environmentId: EnvironmentId) {
  return appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment
    .capabilities;
}

/** Whether this client may run one end of a move on `environmentId`, and its server can. */
function canMoveOn(environmentId: EnvironmentId, scopes: ReadonlyArray<AuthEnvironmentScope>) {
  return (
    readCapabilities(environmentId)?.tempoThreadMove === true &&
    scopes.every((scope) => readEnvironmentScope(environmentId, scope))
  );
}

function readEnvironments(): ReadonlyArray<
  ThreadMoveEnvironment & { readonly connected: boolean }
> {
  const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
  return [...presentations].map(([environmentId, presentation]) => ({
    environmentId,
    label: presentation.entry.target.label,
    connected:
      presentation.connection.phase === "connected" &&
      canMoveOn(environmentId, TEMPO_THREAD_MOVE_TARGET_SCOPES),
  }));
}

function readEnvironmentLabel(environmentId: EnvironmentId): string {
  return (
    readEnvironments().find((environment) => environment.environmentId === environmentId)?.label ??
    "another machine"
  );
}

/** Machines a thread can move to now: connected, and both ends can and may run a move. */
export function readThreadMoveTargets(
  sourceEnvironmentId: EnvironmentId,
): ReadonlyArray<ThreadMoveEnvironment> {
  if (!canMoveOn(sourceEnvironmentId, TEMPO_THREAD_MOVE_SOURCE_SCOPES)) return [];
  return threadMoveTargets(sourceEnvironmentId, readEnvironments());
}

/**
 * A "Move to" submenu listing every machine the thread can go to, "Here" (the
 * machine this client runs on) first. Empty when the thread already moved or
 * no other machine is connected; disabled while a run is active, which the
 * source refuses to move.
 */
function buildThreadMoveMenuItems(thread: {
  readonly environmentId: EnvironmentId;
  readonly source: { readonly movedTo?: TempoThreadMoveLink | null | undefined };
  readonly runtime: ThreadRuntimeSummary | null;
}): ReadonlyArray<ContextMenuItem<ThreadMoveMenuId>> {
  if (isTempoThreadMovedAway(thread.source)) return [];
  const targets = readThreadMoveTargets(thread.environmentId);
  if (targets.length === 0) return [];
  const here = appAtomRegistry.get(primaryEnvironmentIdAtom);
  const isHere = (target: ThreadMoveEnvironment) => target.environmentId === here;
  return [
    {
      id: "tempo-move",
      label: "Move to",
      separatorBefore: true,
      disabled: threadRuntimeIsActive(thread.runtime),
      children: [...targets.filter(isHere), ...targets.filter((target) => !isHere(target))].map(
        (target) => ({
          id: `${THREAD_MOVE_MENU_PREFIX}${target.environmentId}` as const,
          label: isHere(target) ? "Here" : target.label,
        }),
      ),
    },
  ];
}

/**
 * Wraps a context menu's `show` so a thread's menu also offers Move to,
 * placed before Archive (or Delete, in menus without Archive).
 */
export function withThreadMoveMenuItems(
  contextMenu: {
    readonly show: <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>;
  },
  thread: Parameters<typeof buildThreadMoveMenuItems>[0],
) {
  return {
    show: <T extends string>(
      items: ReadonlyArray<ContextMenuItem<T>>,
      position?: { x: number; y: number },
    ): Promise<T | ThreadMoveMenuId | null> => {
      const moveItems = buildThreadMoveMenuItems(thread);
      const anchorIndex = items.findIndex((item) => item.id === "archive" || item.id === "delete");
      const at = anchorIndex === -1 ? items.length : anchorIndex;
      return contextMenu.show<T | ThreadMoveMenuId>(
        [...items.slice(0, at), ...moveItems, ...items.slice(at)],
        position,
      );
    },
  };
}

// A thread with no Git remote carries its folder, so these fit both kinds of move.
const STEP_DESCRIPTIONS: Record<ThreadMoveStep, (target: string) => string> = {
  prepare: () => "Packing the conversation and its work…",
  transfer: (target) => `Copying to ${target}…`,
  import: (target) => `Setting it up on ${target}…`,
  finalize: () => "Leaving a link behind…",
};

const isProjectNotFound = Schema.is(TempoThreadMoveProjectNotFoundError);
const isFolderUnavailable = Schema.is(TempoThreadMoveFolderUnavailableError);
const isRepositoryRequired = Schema.is(TempoThreadMoveRepositoryRequiredError);

interface ThreadMoveEnds {
  readonly source: ThreadMoveEnvironment;
  readonly target: ThreadMoveEnvironment;
  /** Whether the target takes a thread with no Git remote as a copy of its folder. */
  readonly allowFolder: boolean;
}

function errorMessage(error: unknown, ends: ThreadMoveEnds): string {
  // The target raises these, but the user reads them from wherever they started the move.
  if (isProjectNotFound(error)) {
    return `Open ${error.repository} as a project on ${ends.target.label} first.`;
  }
  if (isFolderUnavailable(error)) {
    return `This thread has no Git remote, so it moves into a new folder, and ${ends.target.label} cannot make folders for threads without a project.`;
  }
  // Asked without allowFolder, the source refuses because the target cannot take the folder;
  // asked with it, because the source predates folder moves.
  if (isRepositoryRequired(error)) {
    const outdated = ends.allowFolder ? ends.source : ends.target;
    return `This thread has no Git remote, so it moves as a copy of its folder. Update ${APP_BASE_NAME} on ${outdated.label} to move it.`;
  }
  return error instanceof Error && error.message.length > 0
    ? error.message
    : "Something went wrong while moving the thread.";
}

function movedTitle(target: ThreadMoveEnvironment, copiedFolder: boolean): string {
  return copiedFolder ? `Moved to ${target.label} into a new folder` : `Moved to ${target.label}`;
}

function pausedTasksNote(count: number, target: ThreadMoveEnvironment): ReadonlyArray<string> {
  if (count === 0) return [];
  const tasks = count === 1 ? "1 scheduled task" : `${count} scheduled tasks`;
  return [`Paused ${tasks} that posted into this thread; recreate them on ${target.label}.`];
}

/**
 * Tells the user the source is still a live copy, with a button that asks it
 * again to become a stub until it does. A source that refused, for example
 * because it took a new turn during the move, would only refuse again.
 */
function showUnmarkedSource(input: {
  readonly toastId: ReturnType<typeof toastManager.add>;
  readonly ends: ThreadMoveEnds;
  readonly title: string;
  readonly notes: ReadonlyArray<string>;
  readonly finalized: Extract<ThreadMoveFinalizeOutcome, { readonly ok: false }>;
  readonly retryFinalize: () => Promise<ThreadMoveFinalizeOutcome>;
}): void {
  const { toastId, title } = input;
  const { source, target } = input.ends;
  const description = [
    `The copy on ${source.label} is still live: ${errorMessage(input.finalized.error, input.ends)}`,
    ...input.notes,
  ].join(" ");
  if (isThreadMoveRefusal(input.finalized.error)) {
    toastManager.update(
      toastId,
      stackedThreadToast({
        type: "warning",
        title,
        description,
        timeout: 0,
        actionProps: hiddenToastActionProps,
        data: { hideCopyButton: true },
      }),
    );
    return;
  }
  toastManager.update(
    toastId,
    stackedThreadToast({
      type: "warning",
      title,
      description,
      timeout: 0,
      data: { hideCopyButton: true },
      actionProps: {
        children: "Try again",
        onClick: () => {
          toastManager.update(toastId, {
            type: "loading",
            description: STEP_DESCRIPTIONS.finalize(target.label),
            actionProps: hiddenToastActionProps,
          });
          void input.retryFinalize().then((finalized) => {
            if (finalized.ok) {
              const notes = [
                ...input.notes,
                ...pausedTasksNote(finalized.pausedScheduledTasks, target),
              ];
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "success",
                  title,
                  ...(notes.length === 0 ? {} : { description: notes.join(" ") }),
                  timeout: 8_000,
                  actionProps: hiddenToastActionProps,
                  data: { hideCopyButton: true },
                }),
              );
            } else {
              showUnmarkedSource({ ...input, finalized });
            }
          });
        },
      },
    }),
  );
}

/**
 * Moves a thread to `targetEnvironmentId` with a progress toast, then opens
 * it there. The thread stays where it was if any step before the import fails.
 */
export async function startThreadMove(input: {
  readonly threadId: ThreadId;
  readonly sourceEnvironmentId: EnvironmentId;
  readonly targetEnvironmentId: EnvironmentId;
  readonly onMoved: (threadRef: ScopedThreadRef) => void;
}): Promise<void> {
  const source = {
    environmentId: input.sourceEnvironmentId,
    label: readEnvironmentLabel(input.sourceEnvironmentId),
  };
  const target = {
    environmentId: input.targetEnvironmentId,
    label: readEnvironmentLabel(input.targetEnvironmentId),
  };
  const ends: ThreadMoveEnds = {
    source,
    target,
    allowFolder: readCapabilities(target.environmentId)?.tempoThreadMoveFolders === true,
  };
  const toastId = toastManager.add(
    stackedThreadToast({
      type: "loading",
      title: `Moving to ${target.label}`,
      description: STEP_DESCRIPTIONS.prepare(target.label),
      timeout: 0,
      data: { hideCopyButton: true },
    }),
  );
  const outcome = await runThreadMove({
    calls: threadMoveCallsFromAtoms(appAtomRegistry, threadMoveCommands),
    threadId: input.threadId,
    source,
    target,
    allowFolder: ends.allowFolder,
    resolveHttpUrl: (environmentId, relativeUrl) => {
      const connection = readPreparedConnection(environmentId);
      return connection === null ? null : resolveAssetUrl(connection.httpBaseUrl, relativeUrl);
    },
    transfer: (urls) => transferThreadMoveArchive(urls),
    onStep: (step) =>
      toastManager.update(toastId, { description: STEP_DESCRIPTIONS[step](target.label) }),
  });
  if (outcome.status === "failed") {
    toastManager.update(
      toastId,
      stackedThreadToast({
        type: "error",
        title: `Could not move the thread to ${target.label}`,
        description: errorMessage(outcome.error, ends),
      }),
    );
    return;
  }
  input.onMoved(scopeThreadRef(outcome.environmentId, outcome.threadId));
  const title = movedTitle(target, outcome.copiedFolder);
  if (!outcome.finalized.ok) {
    showUnmarkedSource({
      toastId,
      ends,
      title,
      notes: outcome.notes,
      finalized: outcome.finalized,
      retryFinalize: outcome.retryFinalize,
    });
    return;
  }
  const notes = [
    ...outcome.notes,
    ...pausedTasksNote(outcome.finalized.pausedScheduledTasks, target),
  ];
  toastManager.update(
    toastId,
    stackedThreadToast({
      type: "success",
      title,
      ...(notes.length === 0 ? {} : { description: notes.join(" ") }),
      timeout: 8_000,
      data: { hideCopyButton: true },
    }),
  );
}
