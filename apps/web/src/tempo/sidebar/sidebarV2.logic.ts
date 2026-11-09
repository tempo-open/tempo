import { onProductionWaitShelf } from "@t3tools/client-runtime/tempo/production-wait";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  hasUnseenCompletion,
  resolveSidebarInboxSection,
  resolveSidebarThreadSection,
  type SidebarListItem,
  type SidebarSection,
} from "../../components/Sidebar.logic";
import { resolveSidebarNeed, staysInSidebarList, type RouteNeedsHold } from "./needsYou.logic";

/**
 * The opt-in sidebar (`tempoSidebarV2Enabled`). Every difference from T3's sidebar goes through the
 * helpers here, so an install with the setting off sees what upstream renders.
 */

/**
 * T3 shows its live sections as cards; the opt-in sidebar shows them as one line each, and the
 * tempo look shows every thread as one line.
 */
export function resolveSidebarRowVariant(
  section: SidebarSection,
  isSidebarV2: boolean,
  isTempoLook: boolean,
): "card" | "slim" | "line" {
  if (isTempoLook) return "line";
  const isLive =
    section === "active" ||
    section === "pinned" ||
    section === "working" ||
    section === "background";
  if (!isLive) return "slim";
  return isSidebarV2 ? "line" : "card";
}

type SidebarListSectionInput = {
  readonly thread: EnvironmentThreadShell;
  readonly isSidebarV2: boolean;
  readonly workingShelfEnabled: boolean;
  /** The Working shelf's hold, past its exit grace (`createInboxReturnTracker`); else live status. */
  readonly isWorking?: boolean | undefined;
  readonly lastVisitedAt: string | undefined;
  /** Whether the chat is the one open in the route, which `hold` keeps in place. */
  readonly isOpen: boolean;
  readonly hold: RouteNeedsHold;
};

type SidebarPlacement<Section extends SidebarSection = SidebarSection> = {
  readonly section: Section;
  /** Kept in the list because it needs you, so its sub chats never fold away either. */
  readonly needsYou: boolean;
};

/**
 * Where a chat outside Pinned and the parked shelves goes: the list or, with the Working section
 * on, Working or Waiting. The opt-in sidebar keeps a chat that needs you in the list, at its
 * usual place and with its chip, instead of folding it into either shelf.
 */
export function resolveSidebarListSection(
  input: SidebarListSectionInput,
): SidebarPlacement<"active" | "working" | "background"> {
  const { thread, isSidebarV2, lastVisitedAt } = input;
  const need = isSidebarV2 ? resolveSidebarNeed(thread, lastVisitedAt) : null;
  if (staysInSidebarList({ isSidebarV2, need, isOpen: input.isOpen, hold: input.hold })) {
    return { section: "active", needsYou: true };
  }
  // A Done row stays out of the Waiting shelf until its reply is read.
  const isUnread = hasUnseenCompletion({ ...thread, lastVisitedAt });
  return {
    section: resolveSidebarInboxSection(
      thread,
      input.workingShelfEnabled,
      isUnread,
      input.isWorking,
    ),
    needsYou: false,
  };
}

/**
 * The section a chat's row sits in. Snoozed, Waiting for Production, Settled and Pinned keep their
 * chats whatever they need, in both sidebars; with the Waiting for Production section off, a
 * waiting chat sits where it otherwise would. The rest go to `resolveSidebarListSection`.
 */
export function resolveSidebarRowSection(
  input: SidebarListSectionInput & {
    readonly snoozed: boolean;
    readonly settled: boolean;
    readonly productionWaitShelfEnabled: boolean;
  },
): SidebarPlacement {
  const section = resolveSidebarThreadSection({
    snoozed: input.snoozed,
    // Only servers that hold production waits set the field, so it needs no capability gate.
    waiting: input.productionWaitShelfEnabled && onProductionWaitShelf(input.thread),
    settled: input.settled,
    pinned: input.thread.pinnedAt != null,
  });
  return section === "active" ? resolveSidebarListSection(input) : { section, needsYou: false };
}

/** The shelves the tempo look docks at the bottom of the sidebar, above its footer. */
export function isDockedSidebarItem(item: SidebarListItem): boolean {
  return item.kind === "thread"
    ? item.section === "working" ||
        item.section === "background" ||
        item.section === "waiting" ||
        item.section === "snoozed"
    : item.marker === "working-header" ||
        item.marker === "background-header" ||
        item.marker === "waiting-header" ||
        item.marker === "snoozed-header";
}

/**
 * Whether a rule sits between the pinned rows and the rest of the list at rest. T3's Pinned
 * label shows only mid-drag; its cards set pinned chats apart, one-line rows need the rule.
 */
export function shouldRulePinnedRows(input: {
  readonly isSidebarV2: boolean;
  readonly hasPinnedThreads: boolean;
  readonly hasActiveThreads: boolean;
}): boolean {
  return input.isSidebarV2 && input.hasPinnedThreads && input.hasActiveThreads;
}

/** One line (36px) plus 28px for each nested subagent row, the height an unpainted row reserves. */
const SIDEBAR_LINE_ROW_HEIGHT_PX = 36;
const SIDEBAR_SUBAGENT_ROW_HEIGHT_PX = 28;
/** The tempo look's one-line row, and its group labels (Pinned, Open) at rest and mid drag. */
export const TEMPO_ROW_HEIGHT_PX = 30;
export const TEMPO_GROUP_LABEL_HEIGHT_PX = 32;

export function estimateSidebarRowHeight(input: {
  readonly variant: "card" | "slim" | "line";
  readonly nestedRowCount: number;
  readonly isTempoLook: boolean;
}): number | null {
  // Slim rows (Snoozed, Waiting for Production, Settled) draw nested rows too.
  if (input.variant === "card") return null;
  const lineHeight = input.isTempoLook ? TEMPO_ROW_HEIGHT_PX : SIDEBAR_LINE_ROW_HEIGHT_PX;
  return lineHeight + SIDEBAR_SUBAGENT_ROW_HEIGHT_PX * input.nestedRowCount;
}
