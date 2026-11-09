import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../../test/render";
import { SubagentTreeLevel, useSharedSubagentTrees } from "./SidebarLineParts";

// Sharing compares shells by identity, so a shell needs no fields.
const shell = (): EnvironmentThreadShell => ({}) as never;

const objectIds = new WeakMap<object, number>();
let lastObjectId = 0;
function objectId(value: object): number {
  const known = objectIds.get(value);
  if (known !== undefined) return known;
  lastObjectId += 1;
  objectIds.set(value, lastObjectId);
  return lastObjectId;
}

// The sidebar hands the hook a newly built map of sub chat trees, as each render here does.
function HostTrees(props: { readonly subChats: readonly EnvironmentThreadShell[] }) {
  const next = new Map([
    [
      "host",
      props.subChats.map((thread, index) => ({
        thread,
        key: `child-${index}`,
        depth: 1,
        children: [],
      })),
    ],
  ]);
  const trees = useSharedSubagentTrees(next);
  return <output>{`${objectId(trees)}:${objectId(trees.get("host") ?? [])}`}</output>;
}

describe("useSharedSubagentTrees", () => {
  it("keeps one map while the sub chats are unchanged, though a new one comes in", async () => {
    const subChats = [shell(), shell()];
    await using screen = await render(<HostTrees subChats={subChats} />);
    const first = screen.container.textContent;
    expect(first).toMatch(/^\d+:\d+$/);

    await screen.rerender(<HostTrees subChats={[...subChats]} />);
    expect(screen.container.textContent).toBe(first);
  });

  it("hands out a new tree once a sub chat changes", async () => {
    const kept = shell();
    await using screen = await render(<HostTrees subChats={[kept, shell()]} />);
    const [mapBefore, hostBefore] = screen.container.textContent!.split(":");

    await screen.rerender(<HostTrees subChats={[kept, shell()]} />);
    const [mapAfter, hostAfter] = screen.container.textContent!.split(":");
    expect(mapAfter).not.toBe(mapBefore);
    expect(hostAfter).not.toBe(hostBefore);
  });
});

describe("SubagentTreeLevel", () => {
  const startedAt = "2026-10-20T05:00:00.000Z";
  const subChat = (title: string, status: "running" | "completed"): EnvironmentThreadShell =>
    ({
      environmentId: "env-1",
      id: title,
      title,
      hasActionableProposedPlan: false,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      pendingSubagentRequest: null,
      interactionMode: "default",
      latestRun: {
        runId: `${title}-run`,
        status,
        requestedAt: startedAt,
        startedAt,
        completedAt: status === "completed" ? "2026-10-20T05:00:02.000Z" : null,
        assistantMessageId: null,
      },
      runtime: {
        status: status === "running" ? "running" : "idle",
        activeRunId: status === "running" ? `${title}-run` : null,
        providerInstanceId: "codex",
        providerName: "Codex",
        lastError: null,
        updatedAt: startedAt,
        activityStartedAt: startedAt,
      },
      lastVisitedAt: "2026-10-20T05:01:00.000Z",
      latestUserMessageAt: startedAt,
      updatedAt: startedAt,
    }) as never;

  it("draws nested sub chats, and a running one counts up", async () => {
    using _timers = fakeTimers();
    vi.setSystemTime(new Date("2026-10-20T05:00:05.000Z"));
    const nodes = [
      {
        thread: subChat("Running child", "running"),
        key: "running",
        depth: 1,
        children: [
          {
            thread: subChat("Finished grandchild", "completed"),
            key: "done",
            depth: 2,
            children: [],
          },
        ],
      },
    ];
    await using screen = await render(
      <SubagentTreeLevel
        nodes={nodes}
        activeChildKey={null}
        onThreadActivate={() => {}}
        onContextMenu={() => {}}
        onContextDragStart={() => {}}
      />,
    );
    const rows = [...screen.container.querySelectorAll('[data-testid="sidebar-subagent-row"]')];
    expect(rows.map((row) => row.firstElementChild?.textContent)).toEqual([
      "Running child",
      "Finished grandchild",
    ]);
    const running = () =>
      screen.container.querySelector('[data-testid="sidebar-row-running"]')?.textContent ?? null;
    expect(running()).toBe("5s");

    await act(async () => vi.advanceTimersByTime(1_000));
    expect(running()).toBe("6s");
  });
});
