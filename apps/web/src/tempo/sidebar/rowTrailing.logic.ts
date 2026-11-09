import {
  resolveSidebarThreadStatus,
  resolveWorkingStartedAt,
} from "../../components/Sidebar.logic";
import {
  resolveSidebarNeed,
  SIDEBAR_NEED_LABEL,
  type SidebarNeedInput,
  type SidebarNeedKind,
} from "./needsYou.logic";

/** The one thing a one-line row shows on its right. */
export type SidebarRowTrailing =
  | { readonly kind: "chip"; readonly need: SidebarNeedKind; readonly label: string }
  | { readonly kind: "running"; readonly startedAt: string | null }
  | { readonly kind: "time" };

const SECOND_MS = 1_000;
const MINUTE_MS = 60_000;

/**
 * How long until a running row's elapsed label next reads differently: the next second while
 * it shows seconds, the next whole minute after that. Nothing repaints in between.
 */
export function elapsedLabelTickDelayMs(elapsedMs: number): number {
  const elapsed = Number.isFinite(elapsedMs) ? Math.max(0, elapsedMs) : 0;
  const step = elapsed < MINUTE_MS ? SECOND_MS : MINUTE_MS;
  return step - (elapsed % step);
}

/** A chip when the chat needs the user, else a spinner with elapsed time while it runs, else the time. */
export function resolveSidebarRowTrailing(
  thread: SidebarNeedInput,
  lastVisitedAt: string | undefined,
): SidebarRowTrailing {
  const need = resolveSidebarNeed(thread, lastVisitedAt);
  if (need !== null) {
    return { kind: "chip", need, label: SIDEBAR_NEED_LABEL[need] };
  }
  if (resolveSidebarThreadStatus(thread) === "working") {
    return { kind: "running", startedAt: resolveWorkingStartedAt(thread) };
  }
  return { kind: "time" };
}
