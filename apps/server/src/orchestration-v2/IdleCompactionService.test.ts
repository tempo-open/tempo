import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  TempoThreadMoveId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import { createOrchestrationV2TurnItemVisibility } from "@t3tools/shared/orchestrationV2Timeline";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerActivation from "../serverActivation.ts";
import {
  idleCompactionWindow,
  idleCompactionCandidate,
  PROMPT_CACHE_TTL_MS,
} from "./IdleCompaction.ts";
import * as IdleCompactionService from "./IdleCompactionService.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { resolveAutoSettlementAt } from "./ThreadSettlementService.ts";

const NOW_MS = Date.parse("2026-10-14T12:00:00.000Z");
const MINUTE_MS = 60_000;
const at = (offset = 0) => DateTime.makeUnsafe(NOW_MS + offset);

function projection(): {
  -readonly [Key in keyof OrchestrationV2ThreadProjection]: OrchestrationV2ThreadProjection[Key];
} {
  const threadId = ThreadId.make("idle-thread");
  const runId = RunId.make("normal-run");
  const messageId = MessageId.make("normal-message");
  const providerThreadId = ProviderThreadId.make("provider-thread");
  const instanceId = ProviderInstanceId.make("custom-codex");
  const nodeId = NodeId.make("root-node");
  const modelSelection = { instanceId, model: "gpt-5.4" };
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Idle thread",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThreadId,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdAt: at(-MINUTE_MS),
      updatedAt: at(),
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: at(),
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection,
        providerThreadId,
        userMessageId: messageId,
        rootNodeId: nodeId,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at(-MINUTE_MS),
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId,
        role: "user",
        text: "Explain this code",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: at(-MINUTE_MS),
        updatedAt: at(-MINUTE_MS),
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: instanceId,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: nodeId,
        nativeThreadRef: null,
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: 1,
        lastRunOrdinal: 1,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        contextUsage: { usedTokens: 20_000 },
        createdAt: at(-MINUTE_MS),
        updatedAt: at(),
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerTurns: [],
    runtimeRequests: [],
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: at(),
  };
}

describe("idle compaction eligibility", () => {
  it("is a setting and supports configured instances of each compacting driver", () => {
    // tempo: on by default (contracts settings.ts).
    expect(DEFAULT_SERVER_SETTINGS.compactIdleThreads).toBe(true);
    expect(idleCompactionCandidate(projection(), false, NOW_MS)).toBeNull();
    for (const driver of Object.keys(PROMPT_CACHE_TTL_MS)) {
      const value = projection();
      value.providerThreads = [
        { ...value.providerThreads[0]!, driver: ProviderDriverKind.make(driver) },
      ];
      expect(idleCompactionCandidate(value, true, NOW_MS)?.driver).toBe(driver);
    }
  });

  it("skips deleted, archived, settled, parked snoozes, and unsupported drivers", () => {
    for (const patch of [
      { deletedAt: at() },
      { archivedAt: at() },
      { settledOverride: "settled" as const },
      { settledAt: at() },
      { snoozedUntil: at(MINUTE_MS), snoozedAt: at() },
    ]) {
      const value = projection();
      value.thread = { ...value.thread, ...patch };
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    const value = projection();
    value.providerThreads = [
      { ...value.providerThreads[0]!, driver: ProviderDriverKind.make("acpRegistry") },
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.providerThreads = projection().providerThreads;
    value.thread = {
      ...value.thread,
      snoozedUntil: at(MINUTE_MS),
      snoozedAt: at(-1),
      pinnedAt: at(),
      settledOverride: "active",
      autoSettleDisabledAt: at(),
    };
    expect(idleCompactionCandidate(value, true, NOW_MS)).not.toBeNull();
  });

  it("requires normal completion and skips every live or queued run", () => {
    for (const status of [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      const value = projection();
      value.runs = [{ ...value.runs[0]!, status }];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    for (const patch of [{ completedAt: null }, { idleCompactionOfRunId: RunId.make("earlier") }]) {
      const value = projection();
      value.runs = [{ ...value.runs[0]!, ...patch }];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    const value = projection();
    value.messages = [{ ...value.messages[0]!, text: "/compact" }];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.messages = [{ ...value.messages[0]!, text: "new input", updatedAt: at(1) }];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.messages = projection().messages;
    value.runs = [
      ...value.runs,
      { ...value.runs[0]!, id: RunId.make("held"), ordinal: 0, status: "queued", queueHeld: true },
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
  });

  it("skips pending requests and any background work, including a dev server", () => {
    const value = projection();
    value.runtimeRequests = [
      { status: "pending" } as OrchestrationV2ThreadProjection["runtimeRequests"][number],
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    value.runtimeRequests = [];
    for (const kind of ["subagent", "monitor", "background_task", "command"] as const) {
      value.providerThreads = [
        { ...value.providerThreads[0]!, pendingBackgroundTasks: [{ taskId: "work", kind }] },
      ];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
  });

  it("requires measured occupancy, preferring current turn usage to cumulative accounting", () => {
    const value = projection();
    for (const usage of [null, { usedTokens: 19_999, totalProcessedTokens: 500_000 }]) {
      value.providerThreads = [{ ...value.providerThreads[0]!, contextUsage: usage }];
      expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
    }
    value.providerTurns = [
      {
        id: ProviderTurnId.make("provider-turn"),
        providerThreadId: value.providerThreads[0]!.id,
        nodeId: NodeId.make("root-node"),
        runAttemptId: null,
        nativeTurnRef: null,
        ordinal: 1,
        status: "completed",
        startedAt: at(-MINUTE_MS),
        completedAt: at(),
        tokenUsage: { usedTokens: 20_000, updatedAt: DateTime.formatIso(at()) },
      },
    ];
    expect(idleCompactionCandidate(value, true, NOW_MS)).not.toBeNull();
    value.thread = {
      ...value.thread,
      providerInstanceId: ProviderInstanceId.make("different-instance"),
    };
    expect(idleCompactionCandidate(value, true, NOW_MS)).toBeNull();
  });
});

describe("idle compaction timing", () => {
  it("fires in the last 10% of each provider's cache TTL and supports the dev override", () => {
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("claudeAgent"))).toEqual({
      startMs: NOW_MS + 54 * MINUTE_MS,
      endMs: NOW_MS + 60 * MINUTE_MS,
    });
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("codex"))).toEqual({
      startMs: NOW_MS + 27 * MINUTE_MS,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("future-driver"))).toEqual({
      startMs: NOW_MS + 27 * MINUTE_MS,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("codex"), MINUTE_MS)).toEqual({
      startMs: NOW_MS + MINUTE_MS,
      endMs: NOW_MS + 4 * MINUTE_MS,
    });
  });
});

const layerDatabase = SqlitePersistence.layerMemory;
const layerProjections = ProjectionStore.layer.pipe(Layer.provide(layerDatabase));

const seed = Effect.fn("seedIdleCompactionThread")(function* (
  value: OrchestrationV2ThreadProjection,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.apply({
    id: EventId.make("thread-created"),
    type: "thread.created",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.thread,
  });
  yield* store.apply({
    id: EventId.make("run.created"),
    type: "run.created",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.runs[0]!,
  });
  yield* store.apply({
    id: EventId.make("message.updated"),
    type: "message.updated",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.messages[0]!,
  });
  yield* store.apply({
    id: EventId.make("provider-thread.updated"),
    type: "provider-thread.updated",
    threadId: value.thread.id,
    occurredAt: at(),
    payload: value.providerThreads[0]!,
  });
});

it.effect.each([null, "fork", "subagent"] as const)(
  "keeps SQL and memory eligibility aligned for %s children",
  (relationshipToParent) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const value = projection();
      value.thread = {
        ...value.thread,
        lineage: {
          rootThreadId: ThreadId.make("root-thread"),
          parentThreadId: relationshipToParent === null ? null : ThreadId.make("parent-thread"),
          relationshipToParent,
        },
      };
      yield* seed(value);
      const persisted = yield* store.getThreadProjection(value.thread.id);
      const candidate = idleCompactionCandidate(persisted, true, NOW_MS);
      expect(candidate !== null).toBe(relationshipToParent !== "subagent");
      expect(yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) })).toEqual(
        candidate === null ? [] : [candidate],
      );
    }).pipe(Effect.provide(layerProjections)),
);

// tempo: a moved thread continues in the environment it moved to.
it.effect("skips a thread moved to another environment, in SQL and in memory", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const value = projection();
    value.thread = {
      ...value.thread,
      movedTo: {
        moveId: TempoThreadMoveId.make("move-1"),
        environmentId: EnvironmentId.make("laptop"),
        environmentLabel: "Laptop",
        threadId: ThreadId.make("thread-on-laptop"),
        movedAt: DateTime.formatIso(at()),
      },
    };
    yield* seed(value);
    const persisted = yield* store.getThreadProjection(value.thread.id);
    expect(persisted.thread.movedTo?.environmentLabel).toBe("Laptop");
    expect(idleCompactionCandidate(persisted, true, NOW_MS)).toBeNull();
    expect(yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) })).toEqual(
      [],
    );
  }).pipe(Effect.provide(layerProjections)),
);

it.effect("keeps the prior activity anchor and hides the system prompt after idle compaction", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const value = projection();
    yield* seed(value);
    expect(
      (yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) }))[0]?.runId,
    ).toBe(value.runs[0]!.id);
    const finished = {
      ...value.runs[0]!,
      id: RunId.make("idle-compaction"),
      ordinal: 2,
      userMessageId: MessageId.make("idle-prompt"),
      idleCompactionOfRunId: value.runs[0]!.id,
      requestedAt: at(MINUTE_MS),
      startedAt: at(MINUTE_MS),
      completedAt: at(2 * MINUTE_MS),
    };
    const prompt = {
      ...value.messages[0]!,
      id: finished.userMessageId,
      runId: finished.id,
      createdBy: "system" as const,
      creationSource: "server" as const,
      text: "/compact",
      createdAt: at(MINUTE_MS),
      updatedAt: at(MINUTE_MS),
    };
    yield* store.apply({
      id: EventId.make("idle-run"),
      type: "run.created",
      threadId: value.thread.id,
      occurredAt: at(MINUTE_MS),
      payload: finished,
    });
    yield* store.apply({
      id: EventId.make("idle-message"),
      type: "message.updated",
      threadId: value.thread.id,
      occurredAt: at(MINUTE_MS),
      payload: prompt,
    });
    expect(yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) })).toEqual(
      [],
    );
    const shell = (yield* store.getThreadShell(value.thread.id))!;
    const memoryShell = ProjectionStore.threadShellFromProjection(
      yield* store.getThreadProjection(value.thread.id),
    );
    for (const result of [shell, memoryShell]) {
      expect(result.latestRunId).toBe(value.runs[0]!.id);
      expect(result.latestRunCompletedAt).toEqual(at());
      expect(result.latestUserMessageAt).toEqual(at(-MINUTE_MS));
      expect(result.latestUserAuthoredMessageAt).toEqual(at(-MINUTE_MS));
    }
    const settlement = (yield* store.getSettlementCandidates())[0]!;
    expect(
      resolveAutoSettlementAt({
        thread: settlement,
        pullRequest: null,
        nowMs: NOW_MS + 3 * 86_400_000 + 1,
        autoSettleAfterDays: 3,
        autoSettleOnMerge: false,
      }),
    ).toEqual(at());
    const item = {
      type: "user_message" as const,
      runId: finished.id,
      nodeId: null,
      inputIntent: "turn_start" as const,
    };
    expect(
      createOrchestrationV2TurnItemVisibility({
        runs: [value.runs[0]!, finished],
        attempts: [],
        items: [item],
      })(item),
    ).toBe(false);
    for (const status of [
      "preparing",
      "starting",
      "running",
      "waiting",
      "completed",
      "failed",
      "interrupted",
      "cancelled",
      "rolled_back",
    ] as const) {
      yield* store.apply({
        id: EventId.make(`idle-${status}`),
        type: "run.updated",
        threadId: value.thread.id,
        occurredAt: at(2 * MINUTE_MS),
        payload: {
          ...finished,
          status,
          completedAt: ["preparing", "starting", "running", "waiting"].includes(status)
            ? null
            : finished.completedAt,
        },
      });
      const persisted = (yield* store.getThreadShell(value.thread.id))!;
      const derived = ProjectionStore.threadShellFromProjection(
        yield* store.getThreadProjection(value.thread.id),
      );
      for (const result of [persisted, derived]) {
        expect(result.status).toBe("completed");
        expect(result.latestRunId).toBe(value.runs[0]!.id);
        expect(result.latestRunCompletedAt).toEqual(at());
        expect(result.activityRunStatus).toBeNull();
        expect(result.activityRunStartedAt).toBeNull();
        expect(result.activeRunId).toBeNull();
      }
    }
  }).pipe(Effect.provide(layerProjections)),
);

it.effect("scans at the deadline and dispatches the system maintenance command once", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW_MS);
    const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const activation = yield* Deferred.make<void>();
    const candidateReads = yield* Queue.unbounded<void>();
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const value = projection();
    const settings = yield* Ref.make({
      ...DEFAULT_SERVER_SETTINGS,
      compactIdleThreads: true,
      providerInstances: {
        [value.thread.providerInstanceId]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
        },
      },
      projectSettingsOverrides: {
        [value.thread.projectId]: {
          providerInstances: { [value.thread.providerInstanceId]: { enabled: false } },
        },
      },
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        ...store,
        getIdleCompactionCandidates: (input) =>
          store
            .getIdleCompactionCandidates(input)
            .pipe(Effect.tap(() => Queue.offer(candidateReads, undefined))),
      }),
      Layer.succeed(ServerActivation.ServerActivation, Deferred.await(activation)),
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) => ({ ...config, idleCompactionDelayMs: MINUTE_MS })),
        ),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-idle-compaction-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            enabled: true,
            driverKind: ProviderDriverKind.make("codex"),
          } as ProviderInstance),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Ref.get(settings),
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.empty,
        dispatch: (command) =>
          Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      }),
    );
    yield* Effect.gen(function* () {
      yield* seed(value);
      const service = yield* IdleCompactionService.make;
      yield* service.start();
      yield* Deferred.succeed(activation, undefined);
      yield* Queue.take(candidateReads);
      yield* service.drain;
      expect(yield* Queue.size(commands)).toBe(0);
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(candidateReads);
      yield* service.drain;
      expect(yield* Queue.size(commands)).toBe(0);
      yield* Ref.update(settings, (current) => ({ ...current, projectSettingsOverrides: {} }));
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(candidateReads);
      const command = yield* Queue.take(commands);
      expect(command).toMatchObject({
        type: "message.dispatch",
        text: "/compact",
        createdBy: "system",
        creationSource: "server",
        idleCompactionOfRunId: value.runs[0]!.id,
        dispatchMode: { type: "start_immediately" },
      });
      yield* service.drain;
      // The real dispatcher persists this marker before the next sweep; prove
      // the same persisted candidate cannot compact itself after completion.
      const store = yield* ProjectionStore.ProjectionStoreV2;
      yield* store.apply({
        id: EventId.make("idle-finished"),
        type: "run.created",
        threadId: value.thread.id,
        occurredAt: at(MINUTE_MS),
        payload: {
          ...value.runs[0]!,
          id: RunId.make("compacted"),
          ordinal: 2,
          idleCompactionOfRunId: value.runs[0]!.id,
        },
      });
      yield* TestClock.adjust("1 minute");
      yield* Queue.take(candidateReads);
      yield* service.drain;
      expect(yield* Queue.size(commands)).toBe(0);
    }).pipe(Effect.provide(dependencies));
  }).pipe(Effect.provide(layerProjections), Effect.scoped),
);

// The default comes from compactIdleThreads until someone picks a mode; a Claude
// instance's own mode overrides it either way.
it.effect.each([
  { mode: "onReturn", compactIdleThreads: true, compacts: false },
  { mode: "beforeCacheExpires", compactIdleThreads: false, compacts: true },
] as const)(
  "follows a Claude instance set to $mode over the default",
  ({ mode, compactIdleThreads, compacts }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
      const candidateReads = yield* Queue.unbounded<void>();
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const instanceId = ProviderInstanceId.make("claude_second");
      const claude = ProviderDriverKind.make("claudeAgent");
      const value = projection();
      const modelSelection = { instanceId, model: "claude-opus-4-6" };
      value.thread = { ...value.thread, providerInstanceId: instanceId, modelSelection };
      value.runs = [{ ...value.runs[0]!, providerInstanceId: instanceId, modelSelection }];
      value.providerThreads = [
        { ...value.providerThreads[0]!, driver: claude, providerInstanceId: instanceId },
      ];
      const dependencies = Layer.mergeAll(
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          ...store,
          getIdleCompactionCandidates: (input) =>
            store
              .getIdleCompactionCandidates(input)
              .pipe(Effect.tap(() => Queue.offer(candidateReads, undefined))),
        }),
        Layer.succeed(ServerActivation.ServerActivation, Effect.void),
        Layer.effect(
          ServerConfig.ServerConfig,
          ServerConfig.ServerConfig.pipe(
            Effect.map((config) => ({ ...config, idleCompactionDelayMs: MINUTE_MS })),
          ),
        ).pipe(
          Layer.provide(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-idle-compaction-mode-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
        ),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: () =>
            Effect.succeed({ enabled: true, driverKind: claude } as ProviderInstance),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            compactIdleThreads,
            tempoCompactNearLimit: false,
            providerInstances: {
              [instanceId]: { driver: claude, enabled: true, config: { idleCompaction: mode } },
            },
          }),
          subscribeChanges: Effect.succeed(Stream.empty),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.empty,
          dispatch: (command) =>
            Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
        }),
      );
      yield* Effect.gen(function* () {
        yield* seed(value);
        const service = yield* IdleCompactionService.make;
        yield* service.start();
        yield* Queue.take(candidateReads);
        yield* service.drain;
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(candidateReads);
        yield* service.drain;
        expect(yield* Queue.size(commands)).toBe(compacts ? 1 : 0);
      }).pipe(Effect.provide(dependencies));
    }).pipe(Effect.provide(layerProjections), Effect.scoped),
);

// tempo: compaction near a provider's limit (apps/server/src/tempo/compaction).
describe("compaction near the provider's limit", () => {
  // Codex reports gpt-5's 272k window as 258,400 and compacts at 244,800; the margin is 25,000.
  const nearLimit = (usedTokens = 230_000) => {
    const value = projection();
    value.providerThreads = [
      { ...value.providerThreads[0]!, contextUsage: { usedTokens, maxTokens: 258_400 } },
    ];
    return value;
  };
  const pursuingGoal = () => {
    const value = nearLimit();
    value.thread = {
      ...value.thread,
      tempoGoal: {
        objective: "Ship it",
        status: "active",
        turns: 1,
        setAt: DateTime.formatIso(at()),
      },
    };
    return value;
  };

  it("has its own setting, on by default, and is due as soon as the turn completes", () => {
    expect(DEFAULT_SERVER_SETTINGS.tempoCompactNearLimit).toBe(true);
    expect(idleCompactionCandidate(nearLimit(219_800), false, NOW_MS, true)?.nearLimit).toBe(true);
    expect(idleCompactionCandidate(nearLimit(219_799), false, NOW_MS, true)).toBeNull();
    expect(idleCompactionCandidate(nearLimit(219_799), true, NOW_MS, true)?.nearLimit).toBe(false);
    expect(idleCompactionCandidate(nearLimit(), true, NOW_MS, false)?.nearLimit).toBe(false);
    expect(idleCompactionCandidate(nearLimit(), false, NOW_MS, false)).toBeNull();
    expect(idleCompactionWindow(at(), ProviderDriverKind.make("codex"), undefined, true)).toEqual({
      startMs: NOW_MS,
      endMs: NOW_MS + 30 * MINUTE_MS,
    });
  });

  it("skips busy, waiting, settled, parked and goal threads, but not a watcher's wait", () => {
    const skipped = (["running", "waiting"] as const).map((status) => {
      const value = nearLimit();
      value.runs = [
        ...value.runs,
        { ...value.runs[0]!, id: RunId.make(status), ordinal: 2, status, completedAt: null },
      ];
      return value;
    });
    const asking = nearLimit();
    asking.runtimeRequests = [
      { status: "pending" } as OrchestrationV2ThreadProjection["runtimeRequests"][number],
    ];
    skipped.push(asking, pursuingGoal());
    for (const patch of [{ settledAt: at() }, { snoozedUntil: at(MINUTE_MS), snoozedAt: at() }]) {
      const value = nearLimit();
      value.thread = { ...value.thread, ...patch };
      skipped.push(value);
    }
    for (const value of skipped) {
      expect(idleCompactionCandidate(value, false, NOW_MS, true)).toBeNull();
    }
    // A watcher's wake is an ordinary message, which waits behind a running compaction.
    const watching = nearLimit();
    watching.thread = {
      ...watching.thread,
      tempoScheduledWaits: [
        { taskId: ScheduledTaskId.make("watch-deploy"), title: "Deploy", kind: "watcher" },
      ],
    };
    expect(idleCompactionCandidate(watching, false, NOW_MS, true)?.nearLimit).toBe(true);
  });

  it.effect.each([
    { name: "near the limit", value: () => nearLimit() },
    { name: "below the margin", value: () => nearLimit(219_799) },
    { name: "working toward a goal", value: pursuingGoal },
  ])("keeps SQL and memory aligned for a thread $name", ({ value }) =>
    Effect.gen(function* () {
      const store = yield* ProjectionStore.ProjectionStoreV2;
      const seeded = value();
      yield* seed(seeded);
      const candidate = idleCompactionCandidate(
        yield* store.getThreadProjection(seeded.thread.id),
        true,
        NOW_MS,
      );
      expect(yield* store.getIdleCompactionCandidates({ completedAfter: at(-MINUTE_MS) })).toEqual(
        candidate === null ? [] : [candidate],
      );
    }).pipe(Effect.provide(layerProjections)),
  );

  // The real dispatcher records the compaction run before the next sweep.
  const recordCompaction = Effect.fn("recordNearLimitCompaction")(function* (
    value: OrchestrationV2ThreadProjection,
  ) {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    yield* store.apply({
      id: EventId.make("near-limit-compacted"),
      type: "run.created",
      threadId: value.thread.id,
      occurredAt: at(),
      payload: {
        ...value.runs[0]!,
        id: RunId.make("compacted"),
        ordinal: 2,
        idleCompactionOfRunId: value.runs[0]!.id,
      },
    });
  });

  const worker = Effect.fn("nearLimitWorker")(function* (input: {
    readonly compactIdleThreads: boolean;
    readonly tempoCompactNearLimit: boolean;
  }) {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const commands = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const candidateReads = yield* Queue.unbounded<void>();
    const instanceId = projection().thread.providerInstanceId;
    const dependencies = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        ...store,
        getIdleCompactionCandidates: (query) =>
          store
            .getIdleCompactionCandidates(query)
            .pipe(Effect.tap(() => Queue.offer(candidateReads, undefined))),
      }),
      Layer.succeed(ServerActivation.ServerActivation, Effect.void),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-near-limit-compaction-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: () =>
          Effect.succeed({
            enabled: true,
            driverKind: ProviderDriverKind.make("codex"),
          } as ProviderInstance),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          ...DEFAULT_SERVER_SETTINGS,
          ...input,
          providerInstances: {
            [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: true },
          },
        }),
        subscribeChanges: Effect.succeed(Stream.empty),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.fromQueue(events),
        dispatch: (command) =>
          Queue.offer(commands, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
      }),
    );
    // One server lifetime: start the worker, let its startup sweep finish, then run `body`.
    const lifetime = <E, R>(
      body: (service: { readonly drain: Effect.Effect<void> }) => Effect.Effect<void, E, R>,
    ) =>
      Effect.gen(function* () {
        const service = yield* IdleCompactionService.make;
        yield* service.start();
        yield* Queue.take(candidateReads);
        yield* service.drain;
        return yield* body(service);
      }).pipe(Effect.provide(dependencies), Effect.scoped);
    return { events, commands, candidateReads, lifetime };
  });

  it.effect("compacts as soon as a turn leaves the thread near the limit, and only once", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { events, commands, candidateReads, lifetime } = yield* worker({
        compactIdleThreads: false,
        tempoCompactNearLimit: true,
      });
      const value = nearLimit();
      yield* lifetime((service) =>
        Effect.gen(function* () {
          // The turn completes after startup; its completion alone starts the sweep.
          yield* seed(value);
          yield* Queue.offer(events, {
            id: EventId.make("turn-completed"),
            type: "run.updated",
            threadId: value.thread.id,
            occurredAt: at(),
            payload: value.runs[0]!,
          });
          yield* Queue.take(candidateReads);
          yield* service.drain;
          expect(yield* Queue.clear(commands)).toMatchObject([
            {
              type: "message.dispatch",
              commandId: `server:idle-compact:${value.thread.id}:${value.runs[0]!.id}`,
              text: "/compact",
              createdBy: "system",
              creationSource: "server",
              idleCompactionOfRunId: value.runs[0]!.id,
              dispatchMode: { type: "start_immediately" },
            },
          ]);
          yield* recordCompaction(value);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(candidateReads);
          yield* service.drain;
          expect(yield* Queue.size(commands)).toBe(0);
        }),
      );
    }).pipe(Effect.provide(layerProjections), Effect.scoped),
  );

  it.effect.each([
    { name: "below the margin", usedTokens: 219_799, tempoCompactNearLimit: true },
    { name: "with its setting off", usedTokens: 230_000, tempoCompactNearLimit: false },
  ])("leaves a thread $name to idle compaction", ({ usedTokens, tempoCompactNearLimit }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { commands, candidateReads, lifetime } = yield* worker({
        compactIdleThreads: true,
        tempoCompactNearLimit,
      });
      yield* seed(nearLimit(usedTokens));
      yield* lifetime((service) =>
        Effect.gen(function* () {
          expect(yield* Queue.size(commands)).toBe(0);
          yield* TestClock.adjust("1 minute");
          yield* Queue.take(candidateReads);
          yield* service.drain;
          expect(yield* Queue.size(commands)).toBe(0);
        }),
      );
    }).pipe(Effect.provide(layerProjections), Effect.scoped),
  );

  it.effect("sends one command id across a restart, and nothing once the compaction ran", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const { commands, lifetime } = yield* worker({
        compactIdleThreads: false,
        tempoCompactNearLimit: true,
      });
      const value = nearLimit();
      yield* seed(value);
      // A restart before the compaction is recorded sweeps the thread again, with the same
      // command id, which the orchestrator's command receipts accept only once.
      yield* lifetime(() => Effect.void);
      yield* lifetime(() => Effect.void);
      const dispatched = yield* Queue.clear(commands);
      expect(dispatched).toHaveLength(2);
      expect(dispatched[0]?.commandId).toBe(
        `server:idle-compact:${value.thread.id}:${value.runs[0]!.id}`,
      );
      expect(dispatched[1]).toEqual(dispatched[0]);
      yield* recordCompaction(value);
      yield* lifetime(() => Effect.void);
      expect(yield* Queue.size(commands)).toBe(0);
    }).pipe(Effect.provide(layerProjections), Effect.scoped),
  );
});
