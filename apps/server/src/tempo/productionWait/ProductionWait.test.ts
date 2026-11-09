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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../../mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionMaintenance from "../../orchestration-v2/ProjectionMaintenance.ts";
import * as RuntimeLayer from "../../orchestration-v2/runtimeLayer.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as SourceControlProviderRegistry from "../../sourceControl/SourceControlProviderRegistry.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import * as ProductionDeployments from "./ProductionDeployments.ts";
import * as ProductionWait from "./ProductionWait.ts";
import {
  PRODUCTION_PROMOTED_MESSAGE,
  type ProductionDeployment,
} from "./productionWaitDecision.ts";

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "tempo-production-wait-",
});
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
    openSession: () => Effect.die("sessions are not used by production wait tests"),
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

/**
 * GitHub as this test arranges it: the deployments a sweep reads, and how often it read them.
 * `configured: false` is a server that names no production repository.
 */
function fakeGitHub({ configured = true }: { readonly configured?: boolean } = {}) {
  const state = { deployments: [] as ReadonlyArray<ProductionDeployment>, reads: 0 };
  const layer = Layer.succeed(
    ProductionDeployments.ProductionDeployments,
    ProductionDeployments.ProductionDeployments.of({
      target: configured
        ? {
            host: "github.com",
            owner: "acme",
            repository: "app",
            environment: "production",
            workflow: ".github/workflows/deploy.yml",
          }
        : null,
      recent: Effect.sync(() => {
        state.reads += 1;
        return state.deployments;
      }),
    }),
  );
  return { state, layer };
}

const layerFor = (github: ReturnType<typeof fakeGitHub>) =>
  ProductionWait.layer.pipe(
    Layer.provideMerge(layerRuntime),
    Layer.provide(github.layer),
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

const waitOf = (threadId: ThreadId) =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    Effect.map(orchestrator.getThreadShell(threadId), (shell) => shell?.waitingForProductionSince),
  );

/** A deployment created `minutes` after the wait started. */
const deploymentAfter = (
  since: string,
  minutes: number,
  latestState: string | null,
): ProductionDeployment => ({
  id: 7_000_000_000 + minutes,
  createdAt: DateTime.formatIso(DateTime.add(DateTime.makeUnsafe(since), { minutes })),
  latestState,
  workflow: ".github/workflows/deploy.yml",
});

describe("ProductionWait", () => {
  it.effect("starts, keeps and stops a wait, and a projection rebuild agrees", () => {
    const github = fakeGitHub();
    return Effect.gen(function* () {
      const productionWait = yield* ProductionWait.ProductionWait;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const threadId = ThreadId.make("production-wait-lifecycle");
      yield* createThread(threadId);

      const started = yield* productionWait.setWaiting({ threadId, waiting: true });
      assert.isString(started.waitingForProductionSince);
      assert.equal(yield* waitOf(threadId), started.waitingForProductionSince);
      // Asking again keeps the first start, so a repeated call never delays the wake.
      assert.deepEqual(yield* productionWait.setWaiting({ threadId, waiting: true }), started);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal(yield* waitOf(threadId), started.waitingForProductionSince);

      assert.deepEqual(yield* productionWait.setWaiting({ threadId, waiting: false }), {
        waitingForProductionSince: null,
      });
      assert.isUndefined(yield* waitOf(threadId));
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.isUndefined(yield* waitOf(threadId));
    }).pipe(Effect.provide(layerFor(github)));
  });

  it.effect("refuses every wait while no production repository is named", () => {
    const github = fakeGitHub({ configured: false });
    return Effect.gen(function* () {
      const productionWait = yield* ProductionWait.ProductionWait;
      const threadId = ThreadId.make("production-wait-unconfigured");
      yield* createThread(threadId);
      const refused = yield* productionWait
        .setWaiting({ threadId, waiting: true })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "TempoProductionWaitRefusedError");
      assert.equal(
        refused._tag === "TempoProductionWaitRefusedError" && refused.reason,
        "unconfigured",
      );
      assert.include(refused.message, "TEMPO_PRODUCTION_REPOSITORY");
      assert.isUndefined(yield* waitOf(threadId));
    }).pipe(Effect.provide(layerFor(github)));
  });

  it.effect("settling and archiving end a wait, and a settled thread cannot start one", () => {
    const github = fakeGitHub();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const productionWait = yield* ProductionWait.ProductionWait;
      const settled = ThreadId.make("production-wait-settle");
      const archived = ThreadId.make("production-wait-archive");
      yield* createThread(settled);
      yield* createThread(archived);
      yield* productionWait.setWaiting({ threadId: settled, waiting: true });
      yield* productionWait.setWaiting({ threadId: archived, waiting: true });

      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("production-wait-settle:settle"),
        threadId: settled,
      });
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("production-wait-archive:archive"),
        threadId: archived,
      });
      assert.isUndefined(yield* waitOf(settled));
      assert.isUndefined(yield* waitOf(archived));

      const refused = yield* productionWait
        .setWaiting({ threadId: settled, waiting: true })
        .pipe(Effect.flip);
      assert.equal(refused._tag, "TempoProductionWaitRefusedError");
      assert.equal(refused._tag === "TempoProductionWaitRefusedError" && refused.reason, "settled");
      // The orchestrator decides the same under its lock, for callers that raced the check.
      const decided = yield* orchestrator
        .dispatch({
          type: "thread.production-wait.set",
          commandId: CommandId.make("production-wait-settle:raced"),
          threadId: settled,
          waiting: true,
        })
        .pipe(Effect.flip);
      assert.equal(decided._tag, "OrchestratorDispatchError");
      assert.isUndefined(yield* waitOf(settled));
    }).pipe(Effect.provide(layerFor(github)));
  });

  it.effect(
    "a sweep reads GitHub only while a thread waits, and wakes it after a promotion",
    () => {
      const github = fakeGitHub();
      return Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const productionWait = yield* ProductionWait.ProductionWait;
        const first = ThreadId.make("production-wait-first");
        const second = ThreadId.make("production-wait-second");
        yield* createThread(first);
        yield* createThread(second);

        // Nothing waits: no read at all.
        yield* productionWait.sweep;
        assert.equal(github.state.reads, 0);

        const { waitingForProductionSince: since } = yield* productionWait.setWaiting({
          threadId: first,
          waiting: true,
        });
        yield* productionWait.setWaiting({ threadId: second, waiting: true });
        assert.isNotNull(since);
        if (since === null) return;

        // A deploy that started before the wait, one that failed, and one still running.
        github.state.deployments = [
          deploymentAfter(since, 3, "in_progress"),
          deploymentAfter(since, 2, "failure"),
          deploymentAfter(since, -5, "success"),
        ];
        yield* productionWait.sweep;
        assert.equal(github.state.reads, 1);
        assert.equal(yield* waitOf(first), since);

        // The running deploy succeeds: one sweep wakes every waiting thread.
        github.state.deployments = [
          deploymentAfter(since, 3, "success"),
          ...github.state.deployments.slice(1),
        ];
        yield* productionWait.sweep;
        for (const threadId of [first, second]) {
          assert.isUndefined(yield* waitOf(threadId));
          const { messages, runs } = yield* orchestrator.getThreadRecords(threadId, [
            "messages",
            "runs",
          ]);
          const wake = messages.find((message) => message.text === PRODUCTION_PROMOTED_MESSAGE);
          assert.isDefined(wake);
          assert.equal(wake?.notification?.source.kind, "monitor");
          assert.equal(wake?.createdBy, "agent");
          assert.isTrue(runs.some((run) => run.userMessageId === wake?.id));
        }

        // Nothing waits any more, so the next sweep reads nothing.
        yield* productionWait.sweep;
        assert.equal(github.state.reads, 2);
      }).pipe(Effect.provide(layerFor(github)));
    },
  );

  it.effect("queues the wake behind a running turn instead of dropping it", () => {
    const github = fakeGitHub();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const productionWait = yield* ProductionWait.ProductionWait;
      const threadId = ThreadId.make("production-wait-busy");
      yield* createThread(threadId);
      // The agent calls the tool mid-turn, so its own turn is still running.
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("production-wait-busy:message"),
        threadId,
        messageId: MessageId.make("production-wait-busy:message"),
        text: "Merge it to staging, then wait for production.",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const { waitingForProductionSince: since } = yield* productionWait.setWaiting({
        threadId,
        waiting: true,
      });
      assert.isNotNull(since);
      if (since === null) return;

      github.state.deployments = [deploymentAfter(since, 1, "success")];
      yield* productionWait.sweep;
      assert.isUndefined(yield* waitOf(threadId));
      const { messages, runs } = yield* orchestrator.getThreadRecords(threadId, [
        "messages",
        "runs",
      ]);
      const wake = messages.find((message) => message.text === PRODUCTION_PROMOTED_MESSAGE);
      assert.equal(runs.find((run) => run.userMessageId === wake?.id)?.status, "queued");
      assert.isTrue(runs.some((run) => run.status === "starting"));
    }).pipe(Effect.provide(layerFor(github)));
  });

  it.effect("a promotion read for an ended or restarted wait changes nothing", () => {
    const github = fakeGitHub();
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const productionWait = yield* ProductionWait.ProductionWait;
      const threadId = ThreadId.make("production-wait-stale");
      yield* createThread(threadId);
      const { waitingForProductionSince: since } = yield* productionWait.setWaiting({
        threadId,
        waiting: true,
      });
      assert.isNotNull(since);
      if (since === null) return;
      const resume = (key: string, at: string) =>
        orchestrator
          .dispatch({
            type: "thread.production-wait.resume",
            commandId: CommandId.make(`production-wait-stale:${key}`),
            threadId,
            since: at,
            wake: {
              messageId: MessageId.make(`production-wait-stale:${key}`),
              text: PRODUCTION_PROMOTED_MESSAGE,
              notification: {
                source: { kind: "monitor" },
                outcome: "completed",
                summary: "Promoted",
              },
            },
          })
          .pipe(Effect.flip);

      // Read for an earlier wait than the one that is on.
      const earlier = DateTime.subtract(DateTime.makeUnsafe(since), { minutes: 1 });
      assert.equal(
        (yield* resume("earlier", DateTime.formatIso(earlier)))._tag,
        "OrchestratorDispatchError",
      );
      assert.equal(yield* waitOf(threadId), since);
      // Read for this wait, but it was stopped before the read landed.
      yield* productionWait.setWaiting({ threadId, waiting: false });
      assert.equal((yield* resume("stopped", since))._tag, "OrchestratorDispatchError");
      const { messages } = yield* orchestrator.getThreadRecords(threadId, ["messages"]);
      assert.deepEqual(messages, []);
    }).pipe(Effect.provide(layerFor(github)));
  });
});
