import {
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
} from "../../components/Sidebar.logic";

/** The thread fields the sidebar reads to decide whether a chat needs the user. */
export type SidebarNeedInput = Parameters<typeof resolveThreadStatusPill>[0]["thread"] &
  Parameters<typeof resolveSidebarThreadStatus>[0];

/** Why a chat needs the user, in the order the row shows it when several apply. */
export type SidebarNeedKind = "approval" | "input" | "plan" | "failed" | "limited" | "done";

export const SIDEBAR_NEED_LABEL: Readonly<Record<SidebarNeedKind, string>> = {
  approval: "Approval",
  input: "Question",
  plan: "Plan",
  failed: "Failed",
  limited: "Limit",
  done: "Done",
};

/**
 * What the chat is waiting on the user for, or null. A subagent's approval or question counts
 * for its parent, because `resolveSidebarThreadStatus` already folds `pendingSubagentRequest`
 * in. A running chat never needs the user unless it is blocked on a request.
 */
export function resolveSidebarNeed(
  thread: SidebarNeedInput,
  lastVisitedAt: string | undefined,
): SidebarNeedKind | null {
  const status = resolveSidebarThreadStatus(thread);
  if (status === "approval") return "approval";
  if (status === "input") return "input";
  if (status === "working") return null;
  if (status === "failed") return "failed";
  if (status === "limited") return "limited";
  // The pill already orders plan-ready ahead of an unseen completion, and an unseen completion
  // ahead of the subagents and watchers a thread still waits on.
  const label = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } })?.label;
  if (label === "Plan Ready") return "plan";
  return label === "Completed" ? "done" : null;
}

/** Whether a run is going, which is what ends a Done hold: the chat no longer waits on the user. */
export function isSidebarThreadRunning(thread: SidebarNeedInput): boolean {
  return resolveSidebarThreadStatus(thread) === "working";
}

/**
 * What the sidebar remembers about the chat open in the route. Opening an unseen Done chat clears
 * its need at once, but it keeps its place until the route moves on or a new run starts, so one
 * whose watch still runs does not drop into the Waiting shelf while you read it, and "next thread"
 * and settle-and-advance start from the same spot.
 */
export type RouteNeedsHold = { readonly routeKey: string | null; readonly isDoneHeld: boolean };

export const EMPTY_ROUTE_NEEDS_HOLD: RouteNeedsHold = { routeKey: null, isDoneHeld: false };

/**
 * Re-decides when the route changes, from the need the chat had on arrival. On the same route the
 * hold only ends, and only when a follow-up starts a run: the chat is then working, not waiting.
 */
export function nextRouteNeedsHold(
  previous: RouteNeedsHold,
  routeKey: string | null,
  arrivalNeed: SidebarNeedKind | null,
  isRunning = false,
): RouteNeedsHold {
  if (previous.routeKey !== routeKey) return { routeKey, isDoneHeld: arrivalNeed === "done" };
  return previous.isDoneHeld && isRunning ? { routeKey, isDoneHeld: false } : previous;
}

/**
 * Whether the open chat still counts as needing the user. Its own completion is seen as it lands,
 * so a Done need never newly counts; a Done chat held on arrival counts until the route moves on.
 */
export function isNeedsYouWhileOpen(need: SidebarNeedKind | null, hold: RouteNeedsHold): boolean {
  if (need === "done" || need === null) return hold.isDoneHeld;
  return true;
}

/**
 * Whether a chat stays in the list because it needs the user, instead of folding into the
 * Working or Waiting shelf. T3's sidebar has no such rule, so it never applies there.
 */
export function staysInSidebarList(input: {
  readonly isSidebarV2: boolean;
  readonly need: SidebarNeedKind | null;
  readonly isOpen: boolean;
  readonly hold: RouteNeedsHold;
}): boolean {
  if (!input.isSidebarV2) return false;
  return input.isOpen ? isNeedsYouWhileOpen(input.need, input.hold) : input.need !== null;
}
