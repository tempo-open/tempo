import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { TEMPO_THREAD_CLI_CLIENT_LABEL, resolveLaunchedBy } from "./launchedBy.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("Nothing here runs a provider"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadManagementService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      EventStore.layer.pipe(Layer.provide(layerDatabase)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "launched-by-client" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
    ),
  ),
  Layer.provideMerge(ServerSettings.layerTest()),
  Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
);

const createThread = (threadId: ThreadId, launchedBy?: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:launched-by-client"),
      title: threadId,
      modelSelection: { instanceId, model: "gpt-5.1-codex" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: launchedBy === undefined ? "user" : "agent",
      creationSource: launchedBy === undefined ? "web" : "mcp",
      ...(launchedBy === undefined ? {} : { tempoLaunchedBy: launchedBy }),
    });
  });

it.effect("a thread a bot launched keeps the bot's name on its stored shell", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const botThread = ThreadId.make("thread:bot");
    const ownThread = ThreadId.make("thread:own");
    yield* createThread(botThread, "Review Bot");
    yield* createThread(ownThread);

    const listed = (yield* store.getShellSnapshot()).threads;
    for (const [threadId, expected] of [
      [botThread, "Review Bot"],
      [ownThread, undefined],
    ] as const) {
      assert.equal(listed.find((thread) => thread.id === threadId)?.tempoLaunchedBy, expected);
      assert.equal((yield* store.getThreadShell(threadId))?.tempoLaunchedBy, expected);
    }
  }).pipe(Effect.provide(layerTest)),
);

it("names only bots outside Tempo: the name they give, else their sign-in", () => {
  const outside = { callerThreadId: undefined, clientLabel: "Cursor", linked: false };
  assert.equal(
    resolveLaunchedBy({ ...outside, launchedBy: "  Review Bot · Ops " }),
    "Review Bot · Ops",
  );
  assert.equal(resolveLaunchedBy({ ...outside, launchedBy: "   " }), "Cursor");
  assert.equal(resolveLaunchedBy({ ...outside, launchedBy: undefined }), "Cursor");
  assert.equal(resolveLaunchedBy({ ...outside, launchedBy: "x".repeat(300) }), "x".repeat(40));
  assert.equal(
    resolveLaunchedBy({ ...outside, launchedBy: `${"a".repeat(39)}🤖🤖` }),
    `${"a".repeat(39)}🤖`,
  );
  // Tempo's own agents and the `tempo thread` CLI are not bots, whatever they pass.
  assert.isUndefined(
    resolveLaunchedBy({
      callerThreadId: "thread:agent",
      clientLabel: undefined,
      launchedBy: "Release Bot",
      linked: false,
    }),
  );
  assert.isUndefined(
    resolveLaunchedBy({
      callerThreadId: undefined,
      clientLabel: TEMPO_THREAD_CLI_CLIENT_LABEL,
      launchedBy: "Review Bot",
      linked: false,
    }),
  );
  assert.isUndefined(resolveLaunchedBy({ ...outside, clientLabel: "   ", launchedBy: undefined }));
});
