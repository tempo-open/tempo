import { botLauncherName } from "@t3tools/client-runtime/tempo/bot-launch";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  formatWorkingDurationLabel,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { memo, useState, useSyncExternalStore } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  ReactNode,
  SyntheticEvent,
} from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { BotIcon } from "lucide-react";

import { Spinner } from "~/components/ui/spinner";
import { cn } from "~/lib/utils";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { useUiStateStore } from "../../uiStateStore";
import { resolveThreadLastVisitedAt } from "../../components/Sidebar.logic";
import type { SidebarNeedKind } from "./needsYou.logic";
import { elapsedLabelTickDelayMs, resolveSidebarRowTrailing } from "./rowTrailing.logic";
import {
  isSubagentChildFinished,
  shareSubagentTrees,
  type SubagentTreeNode,
} from "./subagentTree.logic";

export type SidebarSubagentNodes = readonly SubagentTreeNode<EnvironmentThreadShell>[];

const NEED_CHIP_TONE: Record<SidebarNeedKind, string> = {
  approval: "bg-warning/10 text-warning-foreground",
  input: "bg-indigo-500/10 text-indigo-600 dark:text-indigo-300",
  plan: "bg-violet-500/10 text-violet-600 dark:text-violet-300",
  failed: "bg-error/10 text-error",
  limited: "bg-warning/10 text-warning",
  done: "bg-success/10 text-success",
};

// Self-ticking so only this span re-renders, not the whole row: each second under a minute, then
// once a minute, when the label actually changes. The label is the store's snapshot, so the React
// Compiler cannot cache a stale one.
function ElapsedLabel(props: { startedAt: string | null }) {
  const startedMs = props.startedAt !== null ? Date.parse(props.startedAt) : Number.NaN;
  const subscribe = (onChange: () => void) => {
    if (Number.isNaN(startedMs)) return () => {};
    let timer: number | undefined;
    const schedule = () => {
      timer = window.setTimeout(
        () => {
          onChange();
          schedule();
        },
        elapsedLabelTickDelayMs(Date.now() - startedMs),
      );
    };
    schedule();
    return () => window.clearTimeout(timer);
  };
  const getSnapshot = () =>
    Number.isNaN(startedMs) ? null : formatWorkingDurationLabel(Date.now() - startedMs);
  const label = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return label === null ? null : <span>{label}</span>;
}

function compactTimeLabel(label: string): string {
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

// The minute tick is the formatter's clock, so the label keeps counting under the React Compiler.
function ThreadTimeLabel(props: {
  thread: Pick<EnvironmentThreadShell, "latestUserMessageAt" | "updatedAt">;
}) {
  const nowMinute = useNowMinute();
  return compactTimeLabel(
    formatRelativeTimeLabel(
      props.thread.latestUserMessageAt ?? props.thread.updatedAt,
      Date.parse(`${nowMinute}:00.000Z`),
    ),
  );
}

/** Names the bot outside Tempo that launched the chat, beside its title; nothing for other chats. */
export function SidebarBotLabel(props: { thread: Parameters<typeof botLauncherName>[0] }) {
  const name = botLauncherName(props.thread);
  if (name === null) return null;
  return (
    <span
      data-testid="sidebar-row-bot-label"
      className="inline-flex h-5 max-w-28 shrink-0 items-center gap-1 rounded-sm bg-info/10 px-1.5 text-2xs font-medium text-info-foreground"
    >
      <BotIcon aria-hidden className="size-3 shrink-0" />
      <span className="truncate">
        <span className="sr-only">Started by </span>
        {name}
      </span>
    </span>
  );
}

/** The tempo look's bot mark: the glyph alone, as the hover card names the bot. */
export function SidebarBotMark(props: { thread: Parameters<typeof botLauncherName>[0] }) {
  const name = botLauncherName(props.thread);
  if (name === null) return null;
  return (
    <span data-testid="sidebar-row-bot-label" className="inline-flex shrink-0">
      <BotIcon aria-hidden className="size-[13px]" />
      <span className="sr-only">Started by {name}</span>
    </span>
  );
}

/** The one thing a one-line row shows on its right: a need chip, a running spinner with elapsed time, or the time. */
export function SidebarRowTrailing(props: {
  thread: Parameters<typeof resolveSidebarRowTrailing>[0];
  lastVisitedAt: string | undefined;
  timeLabel: ReactNode;
}) {
  const trailing = resolveSidebarRowTrailing(props.thread, props.lastVisitedAt);
  if (trailing.kind === "chip") {
    return (
      <span
        data-testid="sidebar-row-need-chip"
        className={cn(
          "inline-flex h-5 items-center rounded-sm px-1.5 text-2xs font-medium",
          NEED_CHIP_TONE[trailing.need],
        )}
      >
        {trailing.label}
      </span>
    );
  }
  if (trailing.kind === "running") {
    return (
      <span
        data-testid="sidebar-row-running"
        className="inline-flex items-center gap-1 text-xs tabular-nums text-info"
      >
        <Spinner size="xs" aria-label="Working" />
        {/* The spinner is the live label; a role="status" around the ticking time would be announced every second. */}
        <span aria-hidden>
          <ElapsedLabel startedAt={trailing.startedAt} />
        </span>
      </span>
    );
  }
  return <span className="text-xs">{props.timeLabel}</span>;
}

// These controls live inside the sortable <li>; without this a press on them could start its drag.
const stopPropagation = (event: SyntheticEvent) => event.stopPropagation();
const stopActivationKeys = (event: ReactKeyboardEvent) => {
  if (event.key === "Enter" || event.key === " ") event.stopPropagation();
};

// The parent <li> takes file drops for its own chat; a sub chat inside it must not feed them to it.
const stopFileDrag = (event: ReactDragEvent) => {
  event.preventDefault();
  event.stopPropagation();
};
const stopFileDragOver = (event: ReactDragEvent) => {
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = "none";
};

const SubagentChildRow = memo(function SubagentChildRow(props: {
  thread: EnvironmentThreadShell;
  threadKey: string;
  isActive: boolean;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onContextDragStart: (threadRef: ScopedThreadRef, event: PointerEvent) => void;
}) {
  const { thread, threadKey, onThreadActivate, onContextMenu, onContextDragStart } = props;
  const threadRef = scopeThreadRef(thread.environmentId, thread.id);
  const localLastVisitedAt = useUiStateStore((state) => state.threadLastVisitedAtById[threadKey]);
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const isFinished = isSubagentChildFinished(thread);
  // A nested row only navigates: modifier clicks must not add rows the selection cannot see.
  const handleClick = () => onThreadActivate(threadRef);
  const handleContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    onContextMenu(threadRef, { x: event.clientX, y: event.clientY });
  };
  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onThreadActivate(threadRef);
  };
  // Dragged out of the sidebar, a sub chat becomes a mention in the chat it is dropped on.
  const handlePointerDown = (event: ReactPointerEvent) => {
    if (!event.isPrimary || event.button !== 0) return;
    onContextDragStart(threadRef, event.nativeEvent);
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-current={props.isActive ? "page" : undefined}
      data-testid="sidebar-subagent-row"
      data-finished={isFinished ? "" : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      onContextMenu={handleContextMenu}
      onPointerDown={handlePointerDown}
      className={cn(
        "flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-xs outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        props.isActive
          ? "bg-sidebar-row-active text-sidebar-foreground"
          : "hover:bg-sidebar-row-hover hover:text-sidebar-foreground",
        !props.isActive &&
          (isFinished ? "text-sidebar-muted-foreground/70" : "text-sidebar-foreground"),
      )}
    >
      <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      <SidebarRowTrailing
        thread={thread}
        lastVisitedAt={lastVisitedAt}
        timeLabel={<ThreadTimeLabel thread={thread} />}
      />
    </div>
  );
});

/** Every sub chat below a chat's row, always open, inside the row's <li>. */
export const SubagentTreeLevel = memo(function SubagentTreeLevel(props: {
  nodes: SidebarSubagentNodes;
  activeChildKey: string | null;
  onThreadActivate: (threadRef: ScopedThreadRef) => void;
  onContextMenu: (threadRef: ScopedThreadRef, position: { x: number; y: number }) => void;
  onContextDragStart: (threadRef: ScopedThreadRef, event: PointerEvent) => void;
}) {
  return (
    <ul
      role="presentation"
      onPointerDown={stopPropagation}
      onKeyDown={stopActivationKeys}
      onDragEnter={stopFileDrag}
      onDragOver={stopFileDragOver}
      onDrop={stopFileDrag}
      className="ml-3 flex flex-col gap-px border-l border-border/60 pl-1"
    >
      {props.nodes.map((node) => (
        <li key={node.key} className="list-none">
          <SubagentChildRow
            thread={node.thread}
            threadKey={node.key}
            isActive={props.activeChildKey === node.key}
            onThreadActivate={props.onThreadActivate}
            onContextMenu={props.onContextMenu}
            onContextDragStart={props.onContextDragStart}
          />
          {node.children.length > 0 ? (
            <SubagentTreeLevel
              nodes={node.children}
              activeChildKey={props.activeChildKey}
              onThreadActivate={props.onThreadActivate}
              onContextMenu={props.onContextMenu}
              onContextDragStart={props.onContextDragStart}
            />
          ) : null}
        </li>
      ))}
    </ul>
  );
});

type SubagentTreeMap = ReadonlyMap<string, SidebarSubagentNodes>;

/** A host chat keeps its previous tree array while its sub chat shells are unchanged. */
export function useSharedSubagentTrees(next: SubagentTreeMap): SubagentTreeMap {
  // State adjusted during render, not a ref: the React Compiler forbids reading refs in render.
  // The sidebar rebuilds `next` on every render, so state changes only when sharing returns a
  // new map; keying it on `next` itself would set state on every render and loop forever.
  const [trees, setTrees] = useState(() => shareSubagentTrees(null, next));
  const shared = shareSubagentTrees(trees, next);
  if (shared !== trees) setTrees(shared);
  return shared;
}
