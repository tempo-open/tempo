import { describe, expect, it } from "vite-plus/test";
import { ProviderInstanceId, ProviderThreadId } from "@t3tools/contracts";
import {
  backgroundTaskEndsWithProviderProcess,
  backgroundWorkHoldsCompletion,
  derivePendingBackgroundWork,
  pendingBackgroundTurnItems,
} from "./orchestrationV2PendingBackgroundWork.ts";

describe("backgroundWorkHoldsCompletion", () => {
  it.each([
    ["a dev server", false, [{ taskId: "dev", kind: "command" }]],
    ["a dev server's watchdog monitor", false, [{ taskId: "watch", kind: "monitor" }]],
    ["a command the agent waits on", true, [{ taskId: "tests", kind: "command", awaited: true }]],
    ["a subagent", true, [{ taskId: "review", kind: "subagent" }]],
  ] as const)("with %s pending, holds completion: %s", (_case, holds, tasks) => {
    expect(backgroundWorkHoldsCompletion(tasks)).toBe(holds);
  });
});

describe("backgroundTaskEndsWithProviderProcess", () => {
  it("tempo: counts the agent's own work, not a watcher or a pull request watch", () => {
    const [watcher, watch] = derivePendingBackgroundWork({
      latestRun: null,
      providerThreads: [],
      turnItems: [],
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/repo",
          number: 7,
          url: "https://github.com/acme/repo/pull/7",
          source: "manual",
          watch: {},
          snapshot: null,
        },
      ] as never,
      scheduledWaits: [{ kind: "watcher", taskId: "task-1", title: "Build" }] as never,
    }).toReversed();
    expect(backgroundTaskEndsWithProviderProcess(watcher!)).toBe(false);
    expect(backgroundTaskEndsWithProviderProcess(watch!)).toBe(false);
    expect(backgroundTaskEndsWithProviderProcess({ taskId: "toolu_123" })).toBe(true);
  });
});

describe("derivePendingBackgroundWork", () => {
  it("takes each subagent item's instance from its joined owner", () => {
    const owner = ProviderInstanceId.make("claude-owner");
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems: [
        {
          id: "owned-item",
          owningProviderInstanceId: owner,
          type: "subagent",
          status: "running",
          title: null,
        },
        { id: "unknown-item", type: "subagent", status: "running", title: null },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "owned-item", kind: "subagent", providerInstanceId: owner },
      { taskId: "unknown-item", kind: "subagent" },
    ]);
  });

  it("takes a roster subagent's instance from its owning provider thread", () => {
    const owner = ProviderInstanceId.make("claude-owner");
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: ProviderThreadId.make("pt-owner"),
          providerInstanceId: owner,
          pendingBackgroundTasks: [
            {
              taskId: "roster-item",
              kind: "subagent",
              providerInstanceId: ProviderInstanceId.make("other"),
            },
          ],
        },
      ],
      turnItems: [],
    });
    expect(tasks).toEqual([{ taskId: "roster-item", kind: "subagent", providerInstanceId: owner }]);
  });

  it("returns empty while the latest run is not settled", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: null,
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("tempo: leaves Claude's ambient housekeeping out, while Stop still ends it", () => {
    const ambient = {
      id: "item-ambient",
      type: "subagent" as const,
      status: "running" as const,
      title: "Memory consolidation",
      nativeItemRef: { nativeId: "task-ambient" },
      ambient: true,
    };
    const input = {
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" as const },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "watch", description: "Watching the build", kind: "monitor" as const },
          ],
        },
      ],
      turnItems: [ambient],
    };
    // A monitor stays on the Waiting roster; the ambient subagent does not join it.
    expect(derivePendingBackgroundWork(input)).toEqual([
      { taskId: "watch", description: "Watching the build", kind: "monitor" },
    ]);
    expect(pendingBackgroundTurnItems(input)).toEqual([ambient]);
  });

  it("does not keep a settled parent waiting for an idle child", () => {
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [{ id: "idle-child", type: "subagent", status: "idle", title: "Review" }],
      }),
    ).toEqual([]);
  });

  it("returns pending work when the latest run is waiting (post-success, pre-checkpoint)", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "npm test", kind: "command" }]);
  });

  // tempo: watchers and other tasks bound to the thread.
  it("tempo: holds a thread on its watchers only while no turn runs, never on a recurring task", () => {
    const scheduledWaits = [
      { taskId: "scheduled-task:a" as never, title: "API recovers" as never, kind: "watcher" },
      { taskId: "scheduled-task:b" as never, title: "Daily summary" as never, kind: "schedule" },
    ] as const;
    const waiting = [
      {
        taskId: "scheduled-task:scheduled-task:a",
        description: "Watching: API recovers",
        kind: "monitor",
        awaited: true,
      },
    ] as const;
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [],
        scheduledWaits: [scheduledWaits[1]],
      }),
    ).toEqual([]);
    expect(
      derivePendingBackgroundWork({
        latestRun: null,
        providerThreads: [],
        turnItems: [],
        scheduledWaits,
      }),
    ).toEqual(waiting);
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [],
        scheduledWaits,
      }),
    ).toEqual(waiting);
    // The wake's own turn reads as working, not waiting.
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-2" as never, ordinal: 2, status: "running" },
        providerThreads: [],
        turnItems: [],
        scheduledWaits,
      }),
    ).toEqual([]);
    expect(backgroundWorkHoldsCompletion(waiting)).toBe(true);
  });

  it("excludes rolled_back items when the latest run is waiting", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "waiting" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
        { id: "run-2" as never, ordinal: 2, status: "waiting" },
      ],
      turnItems: [
        {
          id: "item-old" as never,
          type: "command_execution",
          status: "running",
          title: "from rolled-back run",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-old" },
          input: "sleep 99",
        },
        {
          id: "item-new" as never,
          type: "command_execution",
          status: "running",
          title: "still pending",
          runId: "run-2",
          nativeItemRef: { nativeId: "cmd-new" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-new",
        description: "still pending",
        kind: "command",
      },
    ]);
  });

  it("includes nonterminal turn items and excludes completed ones", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "npm test",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "npm test",
        },
        {
          id: "item-2" as never,
          type: "command_execution",
          status: "completed",
          title: "done",
          nativeItemRef: { nativeId: "cmd-2" },
          input: "echo done",
        },
      ],
    });
    expect(tasks).toEqual([{ taskId: "cmd-1", description: "npm test", kind: "command" }]);
  });

  it("dedupes roster entries against turn items by native task id", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "task-9", description: "Agent review", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Agent review",
          nativeItemRef: { nativeId: "task-9" },
          prompt: "review the plan",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "task-9", description: "Agent review", kind: "background_task" },
    ]);
  });

  it("excludes Grok persistent monitors", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      turnItems: [
        {
          id: "item-1" as never,
          type: "dynamic_tool",
          status: "running",
          title: "monitor logs",
          nativeItemRef: { nativeId: "mon-1" },
          input: { persistent: true, command: "tail -f" },
        },
        {
          id: "item-2" as never,
          type: "dynamic_tool",
          status: "running",
          title: "finite monitor",
          nativeItemRef: { nativeId: "mon-2" },
          input: { persistent: false, command: "sleep 5" },
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "mon-2", description: "finite monitor", kind: "background_task" },
    ]);
  });

  it("returns empty when the latest run is rolled_back even with a nonempty roster", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "rolled_back" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "bg-1", description: "sleep 20", kind: "command" }],
        },
      ],
      turnItems: [
        {
          id: "item-1" as never,
          type: "command_execution",
          status: "running",
          title: "abandoned",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-1" },
          input: "sleep 99",
        },
      ],
    });
    expect(tasks).toEqual([]);
  });

  it("does not reclassify an older active run as background work", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [{ taskId: "provider-task", kind: "background_task" }],
        },
      ],
      runs: [
        { id: "run-1" as never, ordinal: 1, status: "running" },
        { id: "run-2" as never, ordinal: 2, status: "cancelled" },
      ],
      turnItems: [
        {
          id: "item-active" as never,
          type: "command_execution",
          status: "running",
          title: "foreground work",
          runId: "run-1",
          nativeItemRef: { nativeId: "cmd-active" },
          input: "vp check",
        },
      ],
    });

    expect(tasks).toEqual([]);
  });

  it("keeps background work visible during idle compaction", () => {
    expect(
      derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        runs: [
          { id: "run-1" as never, ordinal: 1, status: "completed" },
          {
            id: "idle" as never,
            ordinal: 2,
            status: "running",
            idleCompactionOfRunId: "run-1" as never,
          },
        ],
        providerThreads: [
          {
            id: "pt-1" as never,
            pendingBackgroundTasks: [{ taskId: "review", kind: "monitor" }],
          },
        ],
        turnItems: [],
      }),
    ).toEqual([{ taskId: "review", kind: "monitor" }]);
  });

  it("includes items with a null run id even when runs list has rolled_back rows", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [{ id: "pt-1" as never }],
      runs: [{ id: "run-1" as never, ordinal: 1, status: "rolled_back" }],
      turnItems: [
        {
          id: "item-null-run" as never,
          type: "command_execution",
          status: "running",
          title: "orphan item",
          runId: null,
          nativeItemRef: { nativeId: "cmd-null" },
          input: "echo orphan",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "cmd-null",
        description: "orphan item",
        kind: "command",
      },
    ]);
  });
});

describe("derivePendingBackgroundWork kinds", () => {
  it("keeps the roster's kinds and names turn items by their type", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
      providerThreads: [
        {
          id: "pt-1" as never,
          pendingBackgroundTasks: [
            { taskId: "bash", kind: "command" },
            { taskId: "tests", kind: "command", awaited: true },
            { taskId: "watch", kind: "monitor" },
            { taskId: "workflow", kind: "background_task" },
          ],
        },
      ],
      turnItems: [
        {
          id: "item-sub" as never,
          type: "subagent",
          status: "running",
          title: "Review src/math.ts",
          nativeItemRef: { nativeId: "sub" },
          childThreadId: "thread:child" as never,
        },
        {
          id: "item-cmd" as never,
          type: "command_execution",
          status: "running",
          title: null,
          nativeItemRef: { nativeId: "cmd" },
          input: "npm test",
        },
      ],
    });
    expect(tasks).toEqual([
      { taskId: "bash", kind: "command" },
      { taskId: "tests", kind: "command", awaited: true },
      { taskId: "watch", kind: "monitor" },
      { taskId: "workflow", kind: "background_task" },
      {
        taskId: "sub",
        description: "Review src/math.ts",
        kind: "subagent",
        childThreadId: "thread:child",
      },
      { taskId: "cmd", description: "npm test", kind: "command" },
    ]);
  });

  describe("pull request watches", () => {
    const watch = {
      startedAt: "2026-10-05T00:00:00.000Z",
      headSha: null,
      failedChecks: [],
      passed: false,
      passedChecks: [],
      remarksThrough: "2026-10-05T00:00:00.000Z",
      remarkIds: [],
      conflicting: false,
      wakes: 0,
    };
    const link = (
      number: number,
      extra: {
        source?: "agent" | "stack-dismissed";
        watched?: boolean;
        state?: "open" | "closed" | "merged";
      },
    ) => ({
      host: "github.com",
      repository: "acme/app",
      number,
      url: `https://github.com/acme/app/pull/${number}`,
      source: extra.source ?? "agent",
      snapshot: extra.state === undefined ? null : { state: extra.state },
      ...(extra.watched === false ? {} : { watch }),
    });
    const pullRequests = [
      link(1, {}),
      link(2, { watched: false }),
      link(3, { source: "stack-dismissed" }),
      link(4, { state: "merged" }),
      link(5, { state: "closed" }),
    ];

    it("keeps a settled run waiting on each visible watch, as an awaited monitor", () => {
      const tasks = derivePendingBackgroundWork({
        latestRun: { id: "run-1" as never, ordinal: 1, status: "completed" },
        providerThreads: [],
        turnItems: [],
        pullRequests,
      });
      expect(tasks).toEqual([
        {
          taskId: "pull-request-watch:github.com/acme/app#1",
          description: "Watching pull request #1",
          kind: "monitor",
          awaited: true,
        },
        {
          taskId: "pull-request-watch:github.com/acme/app#5",
          description: "Watching pull request #5",
          kind: "monitor",
          awaited: true,
        },
      ]);
      expect(backgroundWorkHoldsCompletion(tasks)).toBe(true);
    });

    it("keeps a thread that never ran waiting on its watch", () => {
      expect(
        derivePendingBackgroundWork({
          latestRun: null,
          providerThreads: [],
          turnItems: [],
          pullRequests,
        }).map((task) => task.taskId),
      ).toEqual([
        "pull-request-watch:github.com/acme/app#1",
        "pull-request-watch:github.com/acme/app#5",
      ]);
    });

    it("lists no watch while a run is active", () => {
      expect(
        derivePendingBackgroundWork({
          latestRun: { id: "run-1" as never, ordinal: 1, status: "running" },
          providerThreads: [],
          turnItems: [],
          pullRequests,
        }),
      ).toEqual([]);
    });
  });
});
