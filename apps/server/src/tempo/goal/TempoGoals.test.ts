import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as TempoGoals from "./TempoGoals.ts";
import { GOAL_CONTINUATION_NOTIFICATION, goalKickoffText } from "./tempoGoalDecision.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), { prefix: "tempo-goal-" });
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by goal tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerRuntime = RuntimeLayer.layer.pipe(
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provideMerge(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(
    Layer.mock(GitWorkflow.GitWorkflowService)({
      pruneWorktrees: () => Effect.void,
      createWorktree: () => Effect.succeed({} as never),
    }),
  ),
  Layer.provide(Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone })),
  Layer.provide(layerPlatformTest),
);

const layer = TempoGoals.layer.pipe(
  Layer.provideMerge(ProjectionStore.layer),
  Layer.provideMerge(layerRuntime),
  Layer.provide(NodeServices.layer),
);

const createThread = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:create`),
      threadId,
      projectId: ProjectId.make("tempo"),
      title: "Ship the router",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      // A turn runs in the thread's checkout; no project needs to be seeded.
      worktreePath: process.cwd(),
    }),
  );

const send = (threadId: ThreadId, key: string, text: string) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`${threadId}:${key}`),
      threadId,
      messageId: MessageId.make(`${threadId}:${key}`),
      text,
      attachments: [],
      modelSelection,
      dispatchMode: { type: "start_immediately" },
    }),
  );

const records = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.getThreadRecords(threadId, ["messages", "runs"]),
  );

const goalOf = (threadId: ThreadId) =>
  Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
    Effect.map(projections.getThread(threadId), (thread) => thread.tempoGoal ?? null),
  );

const shellGoalOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadShell(threadId), (shell) => shell?.goal ?? null),
  );

describe("TempoGoals", () => {
  it.effect("/goal sets the goal and sends the objective on as its first turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("goal-set");
      yield* createThread(threadId);
      yield* send(threadId, "set", "/goal Ship the router");

      assert.deepEqual(yield* shellGoalOf(threadId), {
        objective: "Ship the router",
        status: "active",
      });
      const { messages, runs } = yield* records(threadId);
      // The message keeps its id, so the composer's pending copy resolves, but no provider
      // reads `/goal`.
      assert.deepEqual(
        messages.map((message) => [message.id, message.text]),
        [[`${threadId}:set`, goalKickoffText("Ship the router")]],
      );
      assert.isTrue(runs.some((run) => run.userMessageId === `${threadId}:set`));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("pause, resume and clear change the goal; only a resume starts a turn", () =>
    Effect.gen(function* () {
      const goals = yield* TempoGoals.TempoGoals;
      const threadId = ThreadId.make("goal-controls");
      yield* createThread(threadId);
      // The agent's tool sets a goal mid-turn; its own turn's end starts the next.
      yield* goals.update({ threadId, change: { type: "set", objective: "Ship the router" } });

      yield* send(threadId, "pause", "/goal pause");
      assert.equal((yield* goalOf(threadId))?.status, "paused");
      assert.deepEqual((yield* records(threadId)).messages, []);

      const { goal } = yield* goals.update({ threadId, change: { type: "resume" } });
      assert.equal(goal?.status, "active");
      assert.equal(goal?.turns, 1);
      const { messages, runs } = yield* records(threadId);
      assert.equal(messages.length, 1);
      assert.deepEqual(messages[0]?.notification, GOAL_CONTINUATION_NOTIFICATION);
      assert.isTrue(messages[0]?.text.includes("Ship the router"));
      assert.isTrue(runs.some((run) => run.userMessageId === messages[0]?.id));

      yield* send(threadId, "clear", "/goal clear");
      assert.isNull(yield* goalOf(threadId));
      assert.isNull(yield* shellGoalOf(threadId));
      const refused = yield* goals
        .update({ threadId, change: { type: "pause" } })
        .pipe(Effect.flip);
      assert.equal(refused._tag === "TempoGoalRefusedError" && refused.reason, "noGoal");
    }).pipe(Effect.provide(layer)),
  );

  it.effect("a continue queues one turn toward the goal at a time", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const goals = yield* TempoGoals.TempoGoals;
      const threadId = ThreadId.make("goal-continue");
      yield* createThread(threadId);
      const { goal } = yield* goals.update({
        threadId,
        change: { type: "set", objective: "Ship the router" },
      });
      assert.isNotNull(goal);
      if (goal === null) return;
      const continueGoal = (key: string) =>
        orchestrator.dispatch({
          type: "thread.goal.update",
          commandId: CommandId.make(`${threadId}:${key}`),
          threadId,
          change: { type: "continue", setAt: goal.setAt },
          messageId: MessageId.make(`${threadId}:${key}`),
        });

      yield* continueGoal("first");
      assert.equal((yield* goalOf(threadId))?.turns, 1);
      // The first continuation's turn is still going, so its end continues the goal instead.
      yield* continueGoal("second");
      assert.equal((yield* goalOf(threadId))?.turns, 1);
      assert.deepEqual(
        (yield* records(threadId)).messages.map((message) => message.id),
        [`${threadId}:first`],
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("Stop and settling pause the goal", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("goal-stop");
      const settled = ThreadId.make("goal-settle");
      yield* createThread(threadId);
      yield* createThread(settled);
      yield* send(threadId, "set", "/goal Ship the router");
      yield* send(settled, "set", "/goal Ship the router");

      const run = (yield* records(threadId)).runs[0];
      assert.isDefined(run);
      if (run === undefined) return;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`${threadId}:stop`),
        threadId,
        runId: run.id,
      });
      assert.equal((yield* goalOf(threadId))?.status, "paused");

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`${settled}:settle`),
        threadId: settled,
      });
      assert.equal((yield* goalOf(settled))?.status, "paused");
    }).pipe(Effect.provide(layer)),
  );
});
