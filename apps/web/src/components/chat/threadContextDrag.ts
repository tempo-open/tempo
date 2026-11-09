import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from "react";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ScopedThreadRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to thread-context drop events and marks old drops inactive
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ScopedThreadRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
// tempo: a drop anywhere on a zone, such as a chat's timeline, goes to the drop target inside it.
const DROP_ZONE_ATTRIBUTE = "data-thread-context-drop-zone";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragGhost {
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

// tempo: a target takes the dragged threads other than its own, so a chat ignores itself. An inert
// target (a composer that is rewinding or saving) takes nothing, as when it is hit directly.
function findDropTarget(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): { target: HTMLElement; threads: ReadonlyArray<ScopedThreadRef> } | null {
  const hit = document.elementFromPoint(point.x, point.y);
  const target =
    hit?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ??
    hit
      ?.closest(`[${DROP_ZONE_ATTRIBUTE}]`)
      ?.querySelector<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ??
    null;
  if (!target || target.closest("[inert]")) return null;
  const own = target.getAttribute(DROP_TARGET_ATTRIBUTE);
  const taken = threads.filter((thread) => scopedThreadKey(thread) !== own);
  return taken.length === 0 ? null : { target, threads: taken };
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
  title: string,
) {
  const target = findDropTarget(point, threads)?.target ?? null;
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  setGhost({ x: point.x, y: point.y, title, count: threads.length });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ScopedThreadRef>,
): boolean {
  const drop = findDropTarget(point, threads);
  if (!drop) return false;
  drop.target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: drop.threads }));
  return true;
}

// tempo: a target names its own thread, which it does not take; a zone hands its drops to the target
// inside it.
export function threadContextDropTargetProps(thread: ScopedThreadRef) {
  return { [DROP_TARGET_ATTRIBUTE]: scopedThreadKey(thread) } as const;
}

export function threadContextDropZoneProps() {
  return { [DROP_ZONE_ATTRIBUTE]: "true" } as const;
}
