import { describe, expect, it } from "vite-plus/test";

import {
  activeSubagentChildKey,
  flattenSubagentTree,
  isSubagentChildFinished,
  orderKeysWithSubChats,
  resolveSubChatNesting,
  shareSubagentTrees,
  subagentThreadKey,
  type SubagentTreeThread,
} from "./subagentTree.logic";

type Node = SubagentTreeThread & { readonly title: string };

function node(
  id: string,
  options: {
    /** delegate_task or Agent-tool child: lineage subagent, never a sub chat. */
    subagentOf?: string;
    /** launched or created by this chat. */
    createdBy?: string;
    relationship?: "fork";
    parent?: string;
    createdAt?: string;
    archivedAt?: string | null;
    environmentId?: string;
  } = {},
): Node {
  const parent = options.subagentOf ?? options.parent ?? null;
  return {
    environmentId: (options.environmentId ?? "env-1") as never,
    id: id as never,
    title: id,
    archivedAt: options.archivedAt ?? null,
    createdAt: options.createdAt ?? "2026-10-16T10:00:00.000Z",
    lineage: {
      parentThreadId: parent as never,
      relationshipToParent:
        options.subagentOf !== undefined
          ? "subagent"
          : options.relationship !== undefined && parent !== null
            ? options.relationship
            : null,
      rootThreadId: (parent ?? id) as never,
    },
    source:
      options.createdBy === undefined ? {} : { tempoCreatedByThreadId: options.createdBy as never },
  };
}

const key = (id: string, environmentId = "env-1") =>
  subagentThreadKey({ environmentId: environmentId as never, id: id as never });

const hosts = (...ids: string[]) => new Set(ids.map((id) => key(id)));

const idsOf = (nodes: Parameters<typeof flattenSubagentTree<Node>>[0] | undefined) =>
  flattenSubagentTree(nodes ?? []).map((entry) => entry.thread.id);

describe("resolveSubChatNesting", () => {
  it("never nests or folds a subagent, and a chat one launched stays top-level", () => {
    const threads = [
      node("parent"),
      node("delegate", { subagentOf: "parent", createdBy: "parent" }),
      node("delegate-grandchild", { subagentOf: "delegate" }),
      node("launched-by-delegate", { createdBy: "delegate" }),
    ];
    for (const drawn of [hosts("parent"), hosts()]) {
      const { trees, nestedKeys, foldedRowAncestors } = resolveSubChatNesting(threads, drawn);
      expect(nestedKeys.size).toBe(0);
      expect(trees.size).toBe(0);
      expect(foldedRowAncestors.size).toBe(0);
    }
  });

  it("nests a launched or created chat under the chat that started it", () => {
    const { trees, nestedKeys } = resolveSubChatNesting(
      [node("creator"), node("launched", { createdBy: "creator" })],
      hosts("creator", "launched"),
    );
    expect(idsOf(trees.get(key("creator")))).toEqual(["launched"]);
    expect(nestedKeys.has(key("launched"))).toBe(true);
  });

  it("orders sub chats oldest first", () => {
    const { trees } = resolveSubChatNesting(
      [
        node("creator"),
        node("late", { createdBy: "creator", createdAt: "2026-10-16T12:00:00.000Z" }),
        node("early", { createdBy: "creator", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      hosts("creator"),
    );
    expect(idsOf(trees.get(key("creator")))).toEqual(["early", "late"]);
  });

  it("folds sub chats away with a creator whose row is not drawn, such as one in folded Working", () => {
    const { trees, nestedKeys, foldedRowAncestors } = resolveSubChatNesting(
      [node("creator"), node("launched", { createdBy: "creator" })],
      hosts(),
    );
    expect(nestedKeys.size).toBe(0);
    expect(trees.size).toBe(0);
    expect(foldedRowAncestors).toEqual(new Map([[key("launched"), key("creator")]]));
  });

  it("nests sub chats under a creator in an expanded shelf that draws its row", () => {
    const { trees, foldedRowAncestors } = resolveSubChatNesting(
      [node("settled-creator"), node("launched", { createdBy: "settled-creator" })],
      hosts("settled-creator"),
    );
    expect(idsOf(trees.get(key("settled-creator")))).toEqual(["launched"]);
    expect(foldedRowAncestors.size).toBe(0);
  });

  it("keeps a sub chat top-level when its creator is archived or filtered out", () => {
    const archived = resolveSubChatNesting(
      [
        node("creator", { archivedAt: "2026-10-16T12:00:00.000Z" }),
        node("child", { createdBy: "creator" }),
      ],
      hosts("creator"),
    );
    expect(archived.nestedKeys.size).toBe(0);
    expect(archived.foldedRowAncestors.size).toBe(0);
    const filteredOut = resolveSubChatNesting([node("child", { createdBy: "creator" })], hosts());
    expect(filteredOut.nestedKeys.size).toBe(0);
    expect(filteredOut.foldedRowAncestors.size).toBe(0);
  });

  it("never lists an archived sub chat", () => {
    const { nestedKeys } = resolveSubChatNesting(
      [
        node("creator"),
        node("gone", { createdBy: "creator", archivedAt: "2026-10-16T12:00:00.000Z" }),
      ],
      hosts("creator"),
    );
    expect(nestedKeys.size).toBe(0);
  });

  it("does not attach a sub chat to a creator in another environment", () => {
    const { nestedKeys } = resolveSubChatNesting(
      [
        node("creator", { environmentId: "env-1" }),
        node("child", { createdBy: "creator", environmentId: "env-2" }),
      ],
      hosts("creator"),
    );
    expect(nestedKeys.size).toBe(0);
  });

  it("leaves forks out", () => {
    const { nestedKeys } = resolveSubChatNesting(
      [node("parent"), node("fork", { parent: "parent", relationship: "fork" })],
      hosts("parent"),
    );
    expect(nestedKeys.size).toBe(0);
  });

  it("nests grandchildren under the sub chat that started them, to any depth", () => {
    const chain = [node("t0")];
    for (let depth = 1; depth <= 12; depth += 1) {
      chain.push(node(`t${depth}`, { createdBy: `t${depth - 1}` }));
    }
    const { trees, nestedKeys } = resolveSubChatNesting(chain, hosts("t0"));
    const rootTree = trees.get(key("t0"))!;
    expect(rootTree).toHaveLength(1);
    expect(rootTree[0]!.children[0]!.thread.id).toBe("t2");
    expect(Math.max(...flattenSubagentTree(rootTree).map((entry) => entry.depth))).toBe(12);
    expect(nestedKeys.size).toBe(12);
    expect([...trees.keys()]).toEqual([key("t0")]);
  });

  it("shows a nested chat's own sub chats even though it is no host", () => {
    const { trees, nestedKeys } = resolveSubChatNesting(
      [node("root"), node("mid", { createdBy: "root" }), node("leaf", { createdBy: "mid" })],
      hosts("root"),
    );
    expect(idsOf(trees.get(key("root")))).toEqual(["mid", "leaf"]);
    expect(nestedKeys.has(key("leaf"))).toBe(true);
  });

  it("folds a whole chain under a hidden root into that root, even where a lower chat would host", () => {
    const { trees, nestedKeys, foldedRowAncestors } = resolveSubChatNesting(
      [node("root"), node("mid", { createdBy: "root" }), node("leaf", { createdBy: "mid" })],
      hosts("mid"),
    );
    expect(nestedKeys.size).toBe(0);
    expect(trees.size).toBe(0);
    expect(foldedRowAncestors.get(key("mid"))).toBe(key("root"));
    expect(foldedRowAncestors.get(key("leaf"))).toBe(key("root"));
  });

  it("maps a folded chat to the nearest ancestor that is drawn, nested or not", () => {
    const { foldedRowAncestors } = resolveSubChatNesting(
      [
        node("root"),
        node("needy", { createdBy: "root" }),
        node("under-needy", { createdBy: "needy" }),
      ],
      hosts(),
      hosts("needy"),
    );
    expect(foldedRowAncestors.has(key("needy"))).toBe(false);
    expect(foldedRowAncestors.get(key("under-needy"))).toBe(key("needy"));
  });

  it("keeps a launched chat that needs you under the chat that started it while that row shows", () => {
    const threads = [
      node("root"),
      node("needy", { createdBy: "root" }),
      node("under-needy", { createdBy: "needy" }),
      node("calm", { createdBy: "root" }),
    ];
    const { trees, nestedKeys } = resolveSubChatNesting(
      threads,
      hosts("root", "needy"),
      hosts("needy"),
    );
    expect(nestedKeys.has(key("needy"))).toBe(true);
    expect(idsOf(trees.get(key("root")))).toEqual(["calm", "needy", "under-needy"]);
  });

  it("gives a launched chat that needs you its own row when the chat that started it is folded", () => {
    const threads = [
      node("root"),
      node("needy", { createdBy: "root" }),
      node("under-needy", { createdBy: "needy" }),
      node("calm", { createdBy: "root" }),
    ];
    const { trees, nestedKeys, foldedRowAncestors } = resolveSubChatNesting(
      threads,
      hosts("needy"),
      hosts("needy"),
    );
    expect(foldedRowAncestors).toEqual(new Map([[key("calm"), key("root")]]));
    expect(nestedKeys).toEqual(new Set([key("under-needy")]));
    expect(idsOf(trees.get(key("needy")))).toEqual(["under-needy"]);
  });

  it("gives a needy chat under a folded chain its own row and folds the rest to the root", () => {
    const { nestedKeys, foldedRowAncestors } = resolveSubChatNesting(
      [
        node("root"),
        node("mid", { createdBy: "root" }),
        node("asking", { createdBy: "mid" }),
        node("leaf", { createdBy: "asking" }),
      ],
      hosts("asking"),
      hosts("asking"),
    );
    expect(foldedRowAncestors).toEqual(new Map([[key("mid"), key("root")]]));
    expect(nestedKeys).toEqual(new Set([key("leaf")]));
  });

  it("hosts only the rows a capped shelf draws; its own sub chats take no place", () => {
    const threads = [
      node("s1"),
      node("s1-child", { createdBy: "s1" }),
      node("s2"),
      node("s2-child", { createdBy: "s2" }),
      node("s3"),
      node("s3-running", { createdBy: "s3" }),
      node("s3-asking", { createdBy: "s3" }),
    ];
    const shelf = { keys: ["s1", "s1-child", "s2", "s3"].map((id) => key(id)), count: 2 };
    const { trees, nestedKeys, foldedRowAncestors } = resolveSubChatNesting(
      threads,
      hosts("s3-asking"),
      hosts("s3-asking"),
      shelf,
    );
    expect(idsOf(trees.get(key("s1")))).toEqual(["s1-child"]);
    expect(idsOf(trees.get(key("s2")))).toEqual(["s2-child"]);
    expect(trees.has(key("s3"))).toBe(false);
    expect(nestedKeys).toEqual(new Set([key("s1-child"), key("s2-child")]));
    expect(foldedRowAncestors).toEqual(new Map([[key("s3-running"), key("s3")]]));

    // Once Show more draws s3, the chat asking nests under it again.
    const shownMore = resolveSubChatNesting(threads, hosts(), hosts("s3-asking"), {
      ...shelf,
      count: 3,
    });
    expect(idsOf(shownMore.trees.get(key("s3")))).toEqual(["s3-asking", "s3-running"]);
  });

  it("survives a creator cycle by leaving its oldest chat top-level", () => {
    const { trees, nestedKeys } = resolveSubChatNesting(
      [
        node("a", { createdBy: "b", createdAt: "2026-10-16T10:00:00.000Z" }),
        node("b", { createdBy: "a", createdAt: "2026-10-16T11:00:00.000Z" }),
      ],
      hosts("a", "b"),
    );
    expect([...nestedKeys]).toEqual([key("b")]);
    expect(idsOf(trees.get(key("a")))).toEqual(["b"]);
    expect(trees.has(key("b"))).toBe(false);
  });

  it("survives a chat that created itself", () => {
    const own = resolveSubChatNesting([node("self", { createdBy: "self" })], hosts("self"));
    expect(own.nestedKeys.size).toBe(0);
  });
});

describe("activeSubagentChildKey", () => {
  const { trees } = resolveSubChatNesting(
    [
      node("root"),
      node("child", { createdBy: "root" }),
      node("grandchild", { createdBy: "child" }),
    ],
    hosts("root"),
  );

  it("finds a nested descendant that is the open route", () => {
    expect(activeSubagentChildKey(trees.get(key("root")), key("grandchild"))).toBe(
      key("grandchild"),
    );
  });

  it("is null for the parent itself, another thread or no route", () => {
    expect(activeSubagentChildKey(trees.get(key("root")), key("root"))).toBeNull();
    expect(activeSubagentChildKey(trees.get(key("root")), key("elsewhere"))).toBeNull();
    expect(activeSubagentChildKey(trees.get(key("root")), null)).toBeNull();
    expect(activeSubagentChildKey(undefined, key("child"))).toBeNull();
  });
});

describe("shareSubagentTrees", () => {
  const nest = (threads: Node[]) => resolveSubChatNesting(threads, hosts("root")).trees;

  it("keeps the previous tree when the child shells are the same objects", () => {
    const threads = [node("root"), node("child", { createdBy: "root" })];
    const first = nest(threads);
    const second = shareSubagentTrees(first, nest([...threads, node("other")]));
    expect(second).toBe(first);
  });

  it("replaces a tree whose child changed", () => {
    const root = node("root");
    const first = nest([root, node("child", { createdBy: "root" })]);
    const second = shareSubagentTrees(first, nest([root, node("child", { createdBy: "root" })]));
    expect(second).not.toBe(first);
    expect(second.get(key("root"))).not.toBe(first.get(key("root")));
  });

  it("returns the next map when there is no previous one", () => {
    const next = nest([node("root"), node("child", { createdBy: "root" })]);
    expect(shareSubagentTrees(null, next)).toBe(next);
  });
});

describe("isSubagentChildFinished", () => {
  const idle = {
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    runtime: null,
  };
  const runtime = (status: "running" | "idle" | "failed" | "queued") => ({
    status,
    activeRunId: null,
    providerInstanceId: "codex" as never,
    providerName: "Codex",
    lastError: null,
    updatedAt: "2026-10-16T10:05:00.000Z",
  });

  it("is finished when nothing is running or pending", () => {
    expect(isSubagentChildFinished(idle)).toBe(true);
    expect(isSubagentChildFinished({ ...idle, runtime: runtime("failed") })).toBe(true);
  });

  it("is active while the child is running or queued", () => {
    expect(isSubagentChildFinished({ ...idle, runtime: runtime("running") })).toBe(false);
    expect(isSubagentChildFinished({ ...idle, runtime: runtime("queued") })).toBe(false);
  });

  it("is active while the child holds background work", () => {
    expect(isSubagentChildFinished({ ...idle, runtime: runtime("idle") })).toBe(false);
  });

  it("is active while the child waits on an approval, a question or its own subagent", () => {
    expect(isSubagentChildFinished({ ...idle, hasPendingApprovals: true })).toBe(false);
    expect(isSubagentChildFinished({ ...idle, hasPendingUserInput: true })).toBe(false);
    expect(isSubagentChildFinished({ ...idle, pendingSubagentRequest: "approval" })).toBe(false);
  });
});

describe("orderKeysWithSubChats", () => {
  it("puts each host's flattened subtree right after it", () => {
    const { trees } = resolveSubChatNesting(
      [
        node("a"),
        node("a1", { createdBy: "a", createdAt: "2026-10-16T10:01:00.000Z" }),
        node("a1x", { createdBy: "a1" }),
        node("a2", { createdBy: "a", createdAt: "2026-10-16T10:02:00.000Z" }),
        node("b"),
      ],
      hosts("a", "b"),
    );
    expect(orderKeysWithSubChats([key("a"), key("b")], trees)).toEqual(
      ["a", "a1", "a1x", "a2", "b"].map((id) => key(id)),
    );
  });

  it("is the host order when nothing nests", () => {
    expect(orderKeysWithSubChats(["x", "y"], new Map())).toEqual(["x", "y"]);
  });
});
