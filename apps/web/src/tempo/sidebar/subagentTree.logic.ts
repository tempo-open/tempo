import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { resolveSidebarThreadStatus } from "../../components/Sidebar.logic";

// Sub chats are chats a chat launched or created, linked by the shell's `tempoCreatedByThreadId`.
// Subagents (delegate_task children and Claude's own background agents) are not sub chats: the
// sidebar lists none of them and they never reach this tree.
export type SubagentTreeThread = Pick<
  EnvironmentThreadShell,
  "environmentId" | "id" | "archivedAt" | "createdAt" | "lineage"
> & {
  readonly source: Pick<EnvironmentThreadShell["source"], "tempoCreatedByThreadId">;
};

export function subagentThreadKey(
  thread: Pick<SubagentTreeThread, "environmentId" | "id">,
): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/** The chat that sent this one's first message when it was launched or created; null for a chat the user started. */
function subChatCreatorKey(thread: SubagentTreeThread): string | null {
  const creatorId = thread.source.tempoCreatedByThreadId ?? null;
  return creatorId === null
    ? null
    : scopedThreadKey(scopeThreadRef(thread.environmentId, creatorId));
}

function compareOldestFirst<T extends SubagentTreeThread>(left: T, right: T): number {
  return (
    Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
    subagentThreadKey(left).localeCompare(subagentThreadKey(right))
  );
}

const EMPTY_KEYS: ReadonlySet<string> = new Set();

export interface SubagentTreeNode<T> {
  readonly thread: T;
  readonly key: string;
  readonly depth: number;
  readonly children: readonly SubagentTreeNode<T>[];
}

export interface SubChatNesting<T> {
  /** Host chat key to its sub chats, nested to any depth; only chats that draw their own row have one. */
  readonly trees: ReadonlyMap<string, readonly SubagentTreeNode<T>[]>;
  /** Chats drawn under their creator, which therefore leave every section. */
  readonly nestedKeys: ReadonlySet<string>;
  /**
   * Chats whose creator is listed but its row is not drawn (a folded section or shelf): they fold
   * away with it and leave every section too. Each maps to its nearest ancestor that is not
   * folded, the row that stands for it when it is open.
   */
  readonly foldedRowAncestors: ReadonlyMap<string, string>;
}

/**
 * A creator loop (A made B made A) cannot nest, so its oldest member loses its creator and
 * becomes a top-level chat; what remains is a forest.
 */
function cutCreatorCycles<T extends SubagentTreeThread>(
  creatorOf: Map<string, string>,
  byKey: ReadonlyMap<string, T>,
): void {
  const done = new Set<string>();
  // Deleting an entry mid-iteration is safe: a Map skips what it no longer holds.
  for (const start of creatorOf.keys()) {
    const path: string[] = [];
    const indexOnPath = new Map<string, number>();
    let current: string | undefined = start;
    while (current !== undefined && !done.has(current)) {
      const loopStart = indexOnPath.get(current);
      if (loopStart !== undefined) {
        const oldest = path
          .slice(loopStart)
          .toSorted((left, right) => compareOldestFirst(byKey.get(left)!, byKey.get(right)!))[0]!;
        creatorOf.delete(oldest);
        break;
      }
      indexOnPath.set(current, path.length);
      path.push(current);
      current = creatorOf.get(current);
    }
    for (const key of path) done.add(key);
  }
}

/** A shelf that draws only its first `count` rows until Show more, as Settled does. */
export interface CappedHostShelf {
  /** The shelf's chats in row order. */
  readonly keys: readonly string[];
  readonly count: number;
}

/**
 * Decides where each sub chat goes. It nests under a shown creator (a row in a section that draws
 * nested rows, `hostKeys` or the first rows of `cappedShelf`, or itself nested) and folds away with
 * one listed but not shown. Only an absent creator (archived, filtered out, not loaded) leaves its
 * sub chats as ordinary rows. Subagents and archived chats never take part.
 */
export function resolveSubChatNesting<T extends SubagentTreeThread>(
  threads: readonly T[],
  hostKeys: ReadonlySet<string>,
  // Chats that need the user never fold away: under a creator that is not shown they keep a row
  // of their own, so no parent hides a sub chat's request.
  needsYouKeys: ReadonlySet<string> = EMPTY_KEYS,
  cappedShelf: CappedHostShelf | null = null,
): SubChatNesting<T> {
  const byKey = new Map<string, T>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.lineage.relationshipToParent === "subagent") continue;
    byKey.set(subagentThreadKey(thread), thread);
  }
  const creatorOf = new Map<string, string>();
  for (const [key, thread] of byKey) {
    const creatorKey = subChatCreatorKey(thread);
    if (creatorKey !== null && creatorKey !== key && byKey.has(creatorKey)) {
      creatorOf.set(key, creatorKey);
    }
  }
  cutCreatorCycles(creatorOf, byKey);
  // A chat with a creator nests or folds, so only the others take the capped shelf's places.
  const drawnHostKeys =
    cappedShelf === null
      ? hostKeys
      : new Set([
          ...hostKeys,
          ...cappedShelf.keys.filter((key) => !creatorOf.has(key)).slice(0, cappedShelf.count),
        ]);

  const placements = new Map<string, "top" | "nested" | "folded">();
  const placementOf = (key: string): "top" | "nested" | "folded" => {
    const known = placements.get(key);
    if (known !== undefined) return known;
    const creatorKey = creatorOf.get(key);
    const result =
      creatorKey === undefined
        ? "top"
        : isShown(creatorKey)
          ? "nested"
          : needsYouKeys.has(key)
            ? "top"
            : "folded";
    placements.set(key, result);
    return result;
  };
  const isShown = (key: string): boolean => {
    const placement = placementOf(key);
    return placement === "nested" || (placement === "top" && drawnHostKeys.has(key));
  };

  const childrenOf = new Map<string, T[]>();
  const nestedKeys = new Set<string>();
  const foldedRowAncestors = new Map<string, string>();
  for (const [key, thread] of byKey) {
    const placement = placementOf(key);
    if (placement === "folded") {
      let ancestor = creatorOf.get(key)!;
      while (placementOf(ancestor) === "folded") ancestor = creatorOf.get(ancestor)!;
      foldedRowAncestors.set(key, ancestor);
    }
    if (placement !== "nested") continue;
    nestedKeys.add(key);
    const creatorKey = creatorOf.get(key)!;
    const siblings = childrenOf.get(creatorKey);
    if (siblings === undefined) {
      childrenOf.set(creatorKey, [thread]);
    } else {
      siblings.push(thread);
    }
  }
  for (const siblings of childrenOf.values()) siblings.sort(compareOldestFirst);

  const build = (key: string, depth: number): SubagentTreeNode<T>[] =>
    (childrenOf.get(key) ?? []).map((thread) => {
      const childKey = subagentThreadKey(thread);
      return { thread, key: childKey, depth, children: build(childKey, depth + 1) };
    });
  const trees = new Map<string, readonly SubagentTreeNode<T>[]>();
  for (const key of childrenOf.keys()) {
    if (!nestedKeys.has(key)) trees.set(key, build(key, 1));
  }
  return { trees, nestedKeys, foldedRowAncestors };
}

export function flattenSubagentTree<T>(
  nodes: readonly SubagentTreeNode<T>[],
): SubagentTreeNode<T>[] {
  return nodes.flatMap((node) => [node, ...flattenSubagentTree(node.children)]);
}

/**
 * The keys in row order with each host's nested sub chats right after it, so keyboard
 * next/previous, jump numbers, range select and park-and-advance can all land on a nested row.
 */
export function orderKeysWithSubChats<T>(
  hostKeys: readonly string[],
  trees: ReadonlyMap<string, readonly SubagentTreeNode<T>[]>,
): string[] {
  return hostKeys.flatMap((key) => [
    key,
    ...flattenSubagentTree(trees.get(key) ?? []).map((node) => node.key),
  ]);
}

function isSameSubagentTree<T>(
  left: readonly SubagentTreeNode<T>[],
  right: readonly SubagentTreeNode<T>[],
): boolean {
  return (
    left.length === right.length &&
    left.every((node, index) => {
      const other = right[index]!;
      return (
        node.thread === other.thread &&
        node.key === other.key &&
        isSameSubagentTree(node.children, other.children)
      );
    })
  );
}

/**
 * Keeps each parent's previous array when its child shells are the same objects, so memoised
 * rows do not re-render because some other thread changed.
 */
export function shareSubagentTrees<T>(
  previous: ReadonlyMap<string, readonly SubagentTreeNode<T>[]> | null,
  next: ReadonlyMap<string, readonly SubagentTreeNode<T>[]>,
): ReadonlyMap<string, readonly SubagentTreeNode<T>[]> {
  if (previous === null) return next;
  const shared = new Map(
    [...next].map(([parentKey, nodes]) => {
      const before = previous.get(parentKey);
      return [
        parentKey,
        before !== undefined && isSameSubagentTree(before, nodes) ? before : nodes,
      ];
    }),
  );
  // Same parents with the same arrays: keep the Map itself so memos keyed on it hold.
  const isUnchanged =
    shared.size === previous.size &&
    [...shared].every(([parentKey, nodes]) => previous.get(parentKey) === nodes);
  return isUnchanged ? previous : shared;
}

/** The route thread's key when it is one of these descendants, else null: that row is the highlighted one. */
export function activeSubagentChildKey<T>(
  nodes: readonly SubagentTreeNode<T>[] | undefined,
  routeKey: string | null,
): string | null {
  if (routeKey === null || nodes === undefined) return null;
  return flattenSubagentTree(nodes).some((node) => node.key === routeKey) ? routeKey : null;
}

/**
 * A finished child is neither running nor holding anything for the user: no active run, no
 * approval or question of its own or from one of its subagents.
 */
export function isSubagentChildFinished(
  thread: Parameters<typeof resolveSidebarThreadStatus>[0],
): boolean {
  const status = resolveSidebarThreadStatus(thread);
  return status === "ready" || status === "failed" || status === "limited";
}
