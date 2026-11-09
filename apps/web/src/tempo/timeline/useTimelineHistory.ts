/**
 * tempo: the timeline's own history paging. Earlier turns load as the reader nears the top, the
 * minimap marks every message from the server's outline, and a mark that is not loaded yet loads
 * history through its message, then scrolls there.
 */
import {
  decideEarlierHistoryAutoLoad,
  INITIAL_EARLIER_HISTORY_AUTO_LOAD,
} from "@t3tools/client-runtime/tempo/earlier-history-auto-load";
import { selectEnvironmentQueryData } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type { ScopedThreadRef, ServerConfig } from "@t3tools/contracts";
import type { LegendListRef } from "@legendapp/list/react";
import { Atom } from "effect/reactivity";
import { useEffect, useEffectEvent, useRef, useState, type RefObject } from "react";

import type { MessagesTimelineHistoryControls } from "../../components/chat/MessagesTimeline";
import type { TimelineViewport } from "../../components/chat/timelineViewport";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuerySelector } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import {
  nextMinimapOutlineJumpStep,
  threadOutlineQuery,
  type MinimapOutlineJump,
} from "./threadOutline";

const NO_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null);
const servesThreadOutline = (config: ServerConfig | null) =>
  config?.environment.capabilities.tempoThreadOutline === true;

/**
 * Every user message of the thread, read once per thread view while older turns are not loaded.
 * Only pointers that can hover get the minimap, so touch screens never ask.
 */
export function useThreadMinimapOutline(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly history: MessagesTimelineHistoryControls | undefined;
}) {
  const { threadRef } = input;
  const minimapShown = useMediaQuery("(pointer: fine)");
  const served = useAtomValue(
    threadRef === null
      ? NO_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(threadRef.environmentId),
    servesThreadOutline,
  );
  const wanted = served && minimapShown && input.history?.hasMoreHistory === true;
  const outline = useEnvironmentQuerySelector(
    wanted && threadRef !== null
      ? threadOutlineQuery({
          environmentId: threadRef.environmentId,
          input: { threadId: threadRef.threadId },
        })
      : null,
    selectEnvironmentQueryData,
  );
  return wanted ? (outline?.entries ?? null) : null;
}

/**
 * Loads the next older page once the reader is within a screen of the top. Call the result on
 * every scroll and content resize; it also runs when a page lands or fails.
 */
export function useAutoLoadEarlierHistory(input: {
  readonly listRef: RefObject<LegendListRef | null>;
  readonly history: MessagesTimelineHistoryControls | undefined;
  readonly oldestEntryId: string;
  /** False while the list positions itself or another flow pages history. */
  readonly ready: boolean;
}): () => void {
  const stateRef = useRef(INITIAL_EARLIER_HISTORY_AUTO_LOAD);
  const check = useStableCallback(() => {
    const { history } = input;
    const list = input.listRef.current?.getState();
    if (!input.ready || history === undefined || list === undefined) return;
    const decision = decideEarlierHistoryAutoLoad(stateRef.current, {
      hasMoreHistory: history.hasMoreHistory,
      loading: history.loading,
      failed: history.error !== null,
      distanceFromStart: list.scroll,
      viewportLength: list.scrollLength,
      oldestEntryId: input.oldestEntryId,
    });
    stateRef.current = decision.state;
    if (decision.load) history.onLoadEarlier();
  });
  const { ready, oldestEntryId } = input;
  const loading = input.history?.loading;
  const hasMoreHistory = input.history?.hasMoreHistory;
  const error = input.history?.error;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the list's scroll position after a page lands or fails, which no scroll event reports when the content does not move
  useEffect(() => {
    check();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each of these can leave the reader near the top with a page still to load; check reads them itself
  }, [check, ready, oldestEntryId, loading, hasMoreHistory, error]);
  return check;
}

/** Jumps to a minimap mark, loading history through its message first when it is not loaded. */
export function useMinimapOutlineJump(input: {
  /** The thread the list shows; the same list shows the next thread, which drops the jump. */
  readonly identity: string;
  readonly rows: ReadonlyArray<{ readonly id: string }>;
  readonly history: MessagesTimelineHistoryControls | undefined;
  readonly oldestEntryId: string;
  readonly viewportRef: RefObject<TimelineViewport | null>;
  readonly onReach: (rowIndex: number) => void;
}) {
  const [jumpState, setJumpState] = useState<{
    readonly identity: string;
    readonly jump: MinimapOutlineJump | null;
  }>({ identity: input.identity, jump: null });
  const jump = jumpState.identity === input.identity ? jumpState.jump : null;
  const setJump = (next: MinimapOutlineJump | null) =>
    setJumpState({ identity: input.identity, jump: next });
  // A new object per arrival, so reaching the same row twice still scrolls.
  const [reached, setReached] = useState<{ readonly rowIndex: number } | null>(null);
  const step =
    jump === null
      ? null
      : nextMinimapOutlineJumpStep(jump, {
          rowIndex: input.rows.findIndex((row) => row.id === jump.messageId),
          loading: input.history?.loading ?? false,
          hasMoreHistory: input.history?.hasMoreHistory ?? false,
          oldestEntryId: input.oldestEntryId,
        });
  if (jump !== null && step !== null) {
    if (step.action === "scroll") {
      setJump(null);
      setReached({ rowIndex: step.rowIndex });
    } else if (step.action === "stop") {
      setJump(null);
    } else if (step.action === "load") {
      setJump({ ...jump, requestedFor: input.oldestEntryId, sawLoading: false });
    } else if (step.action === "loading" && !jump.sawLoading) {
      setJump({ ...jump, sawLoading: true });
    }
  }
  const requestedMessageId = jump?.requestedFor == null ? null : jump.messageId;
  const requestedFor = jump?.requestedFor ?? null;
  const loadThrough = useEffectEvent((messageId: string) => {
    input.history?.onLoadEarlier(messageId);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server for the next page toward the clicked message, once per page
  useEffect(() => {
    if (requestedMessageId !== null) loadThrough(requestedMessageId);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- a new oldest entry is the next page toward the same message
  }, [requestedMessageId, requestedFor]);
  const reach = useEffectEvent((rowIndex: number) => input.onReach(rowIndex));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the list to the message's row after the commit that renders it
  useEffect(() => {
    if (reached !== null) reach(reached.rowIndex);
  }, [reached]);
  const pending = jump !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the reader's own scrolling ends a jump that is still loading
  useEffect(() => {
    if (!pending) return;
    return input.viewportRef.current?.subscribe((navigation) => {
      if (navigation.source !== "command" && navigation.source !== "scroll") {
        setJumpState((current) => ({ ...current, jump: null }));
      }
    });
  }, [pending, input.viewportRef]);
  return {
    pending,
    jumpTo: (messageId: string) => setJump({ messageId, requestedFor: null, sawLoading: false }),
  };
}
