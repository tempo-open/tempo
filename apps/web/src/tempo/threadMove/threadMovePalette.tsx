import {
  isTempoThreadMovedAway,
  type TempoThreadMoveLink,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { MonitorUpIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { readThreadMoveTargets, startThreadMove } from "./startThreadMove";

/** "Move thread to <machine>" for each connected machine the open thread can go to. */
export function buildThreadMovePaletteItems(input: {
  readonly thread: {
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly source: { readonly movedTo?: TempoThreadMoveLink | null | undefined };
  };
  readonly onMoved: (threadRef: ScopedThreadRef) => void;
}): ReadonlyArray<CommandPaletteActionItem> {
  const { thread } = input;
  if (isTempoThreadMovedAway(thread.source)) return [];
  return readThreadMoveTargets(thread.environmentId).map((target) => ({
    kind: "action",
    value: `action:tempo-move:${target.environmentId}`,
    title: `Move thread to ${target.label}`,
    searchTerms: ["move", "machine", "environment", "bring here", "mac mini", target.label],
    icon: <MonitorUpIcon className={ITEM_ICON_CLASS} />,
    run: () =>
      startThreadMove({
        threadId: thread.id,
        sourceEnvironmentId: thread.environmentId,
        targetEnvironmentId: target.environmentId,
        onMoved: input.onMoved,
      }),
  }));
}
