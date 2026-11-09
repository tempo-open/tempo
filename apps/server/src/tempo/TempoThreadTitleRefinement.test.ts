import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TempoThreadTitleRefinement from "./TempoThreadTitleRefinement.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:title-refinement");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in title refinement tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

/** The sweep the layer registers, run on demand instead of every 5 seconds. */
function makeHarness() {
  const sweeps: Array<Effect.Effect<void>> = [];
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-title-refinement" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(ServerSettings.layerTest({})),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const layerScheduler = Layer.succeed(
    Scheduler.Scheduler,
    Scheduler.Scheduler.of({
      register: <E, R>(_name: string, runDueWork: Effect.Effect<void, E, R>) =>
        Effect.gen(function* () {
          const context = yield* Effect.context<R>();
          sweeps.push(runDueWork.pipe(Effect.provideContext(context), Effect.orDie));
        }),
    }),
  );
  const layerRefinement = TempoThreadTitleRefinement.layer.pipe(
    Layer.provide(Layer.mergeAll(layerThreadManagement, layerScheduler, layerDatabase)),
  );
  return {
    layer: Layer.mergeAll(layerOrchestrator, layerThreadManagement, layerRefinement),
    sweep: Effect.suspend(() => sweeps[0] ?? Effect.die("the refinement sweep was not registered")),
  };
}

/** A thread whose first title the model wrote without knowing the subject. */
function markedThread(name: string) {
  return Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = ThreadId.make(`thread:${name}`);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:${name}:create`),
      threadId,
      projectId,
      title: "pick up where we stopped",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    const requestId = CommandId.make(`command:${name}:first-title`);
    yield* threads.dispatch({
      type: "thread.metadata.update",
      commandId: requestId,
      threadId,
      regenerateTitle: true,
    });
    yield* threads.dispatch({
      type: "thread.title.regeneration.complete",
      commandId: CommandId.make(`${requestId}:title-complete`),
      threadId,
      requestId,
      title: "Continue Earlier Work",
      tempoNeedsRefinement: true,
    });
    return threadId;
  });
}

function messageEvent(input: {
  readonly threadId: ThreadId;
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly now: DateTime.Utc;
}) {
  const runId = RunId.make(`${input.threadId}:run`);
  return {
    id: EventId.make(`${runId}:${input.id}`),
    type: "message.updated" as const,
    threadId: input.threadId,
    runId,
    occurredAt: input.now,
    payload: {
      id: MessageId.make(`${runId}:${input.id}`),
      threadId: input.threadId,
      runId,
      nodeId: null,
      role: input.role,
      text: input.text,
      attachments: [],
      streaming: false,
      createdBy: input.role === "user" ? ("user" as const) : ("agent" as const),
      creationSource: input.role === "user" ? ("web" as const) : ("provider" as const),
      createdAt: input.now,
      updatedAt: input.now,
    },
  };
}

/** The agent writes one more message in the thread's turn. */
function agentMessage(input: {
  readonly threadId: ThreadId;
  readonly index: number;
  readonly text: string;
}) {
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* eventSink.write({
      events: [messageEvent({ ...input, id: `agent:${input.index}`, role: "assistant", now })],
    });
  });
}

/** One turn of the thread with the agent's messages, still running or finished. */
function recordTurn(input: {
  readonly threadId: ThreadId;
  readonly agentMessages: ReadonlyArray<string>;
  readonly running: boolean;
}) {
  return Effect.gen(function* () {
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`${input.threadId}:run`);
    const providerThreadId = ProviderThreadId.make(`${input.threadId}:provider`);
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`${runId}:created`),
          type: "run.created",
          threadId: input.threadId,
          runId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: input.threadId,
            ordinal: 1,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId,
            userMessageId: MessageId.make(`${runId}:user`),
            rootNodeId: null,
            activeAttemptId: null,
            status: input.running ? "running" : "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: input.running ? null : now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`${runId}:provider-thread`),
          type: "provider-thread.updated",
          threadId: input.threadId,
          occurredAt: now,
          payload: {
            id: providerThreadId,
            driver: adapter.driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: input.threadId,
            ownerNodeId: null,
            nativeThreadRef: { driver: adapter.driver, nativeId: "native", strength: "strong" },
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
        messageEvent({
          ...input,
          id: "user",
          role: "user",
          text: "pick up where we stopped",
          now,
        }),
        ...input.agentMessages.map((text, index) =>
          messageEvent({ ...input, id: `agent:${index}`, role: "assistant", text, now }),
        ),
      ],
    });
  });
}

const secondTitleRequest = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return (yield* threads.getThreadProjection(threadId)).thread.titleRegeneration?.requestId;
  });

describe("TempoThreadTitleRefinement", () => {
  it.effect("asks for a second title once a finished turn has an agent message", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threadId = yield* markedThread("refine:finished");

        yield* harness.sweep;
        assert.isUndefined(yield* secondTitleRequest(threadId));

        yield* recordTurn({
          threadId,
          agentMessages: ["Reading the README and checking the test settings."],
          running: false,
        });
        yield* harness.sweep;
        assert.equal(yield* secondTitleRequest(threadId), `tempo-title-refine:${threadId}`);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("waits for the agent's third message while the turn is still running", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threadId = yield* markedThread("refine:running");

        yield* recordTurn({
          threadId,
          agentMessages: ["Reading the config.", "It lists 6 build targets."],
          running: true,
        });
        yield* harness.sweep;
        assert.isUndefined(yield* secondTitleRequest(threadId));

        yield* agentMessage({ threadId, index: 2, text: "Checking the build scripts." });
        yield* harness.sweep;
        assert.equal(yield* secondTitleRequest(threadId), `tempo-title-refine:${threadId}`);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("never retitles a thread someone renamed", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* markedThread("refine:renamed");
        yield* threads.dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make("command:refine:renamed:rename"),
          threadId,
          title: "Login form fixes",
        });
        yield* recordTurn({ threadId, agentMessages: ["Done."], running: false });

        yield* harness.sweep;
        const projection = yield* threads.getThreadProjection(threadId);
        assert.isNotOk(projection.thread.titleRegeneration);
        assert.equal(projection.thread.title, "Login form fixes");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
