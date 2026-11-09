import { assert, describe, it } from "@effect/vitest";
import {
  ChatAttachmentId,
  TEMPO_THREAD_OUTLINE_TEXT_LIMIT,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";

const layerTest = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, ProjectStore.layer).pipe(
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

const providerInstanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:outline");
const threadId = ThreadId.make("thread:outline");
const runId = RunId.make("run:outline");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 30, 0, minute));

const commit = Effect.fn("ThreadOutlineTest.commit")(function* (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
) {
  const store = yield* EventStore.EventStoreV2;
  const projection = yield* ProjectionStore.ProjectionStoreV2;
  yield* store.append({ events });
  yield* Effect.forEach(events, projection.apply, { discard: true });
});

const createProject = Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
  projects.apply({
    sequence: 0,
    eventId: EventId.make(`created:${projectId}`),
    aggregateKind: "project",
    aggregateId: projectId,
    occurredAt: DateTime.formatIso(at(0)),
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "project.created",
    payload: {
      projectId,
      title: projectId,
      workspaceRoot: `/work/${projectId}`,
      defaultModelSelection: null,
      scripts: [],
      createdAt: DateTime.formatIso(at(0)),
      updatedAt: DateTime.formatIso(at(0)),
    },
  }),
);

const thread = (
  id: ThreadId,
  overrides: Partial<
    Extract<OrchestrationV2DomainEvent, { type: "thread.created" }>["payload"]
  > = {},
): Extract<OrchestrationV2DomainEvent, { type: "thread.created" }> => ({
  id: EventId.make(`created:${id}`),
  type: "thread.created",
  threadId: id,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: id,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  },
});

const run = (owner: ThreadId, id: RunId, ordinal: number): OrchestrationV2DomainEvent => ({
  id: EventId.make(`run:${owner}:${id}`),
  threadId: owner,
  occurredAt: at(1),
  type: "run.created",
  payload: {
    id,
    threadId: owner,
    ordinal,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    providerThreadId: null,
    userMessageId: MessageId.make(`prompt:${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status: "completed",
    requestedAt: at(1),
    startedAt: at(1),
    completedAt: at(2),
    checkpointId: null,
    contextHandoffId: null,
  },
});

function message(
  id: string,
  ordinal: number,
  text: string,
  options: {
    readonly role?: "user" | "assistant";
    readonly owner?: ThreadId;
    readonly run?: RunId;
    readonly attachments?: number;
  } = {},
): OrchestrationV2TurnItem {
  const base = {
    id: TurnItemId.make(id),
    threadId: options.owner ?? threadId,
    runId: options.run ?? runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed" as const,
    title: null,
    startedAt: at(ordinal),
    completedAt: at(ordinal),
    updatedAt: at(ordinal),
    messageId: MessageId.make(id),
    text,
  };
  if (options.role === "assistant") return { ...base, type: "assistant_message", streaming: false };
  return {
    ...base,
    type: "user_message",
    inputIntent: "turn_start",
    attachments: Array.from({ length: options.attachments ?? 0 }, (_, index) => ({
      type: "image" as const,
      id: ChatAttachmentId.make(`${id}-file-${index}`),
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 3,
    })),
    createdBy: "user",
    creationSource: "web",
  };
}

const putItems = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  commit(
    items.map((payload) => ({
      id: EventId.make(`${payload.threadId}:${payload.id}`),
      threadId: payload.threadId,
      occurredAt: at(1),
      type: "turn-item.updated" as const,
      payload,
    })),
  );

describe("ProjectionStore.getThreadOutline", () => {
  it.effect("lists every user message oldest first, with the start of its text", () =>
    Effect.gen(function* () {
      yield* createProject;
      yield* commit([thread(threadId), run(threadId, runId, 1)]);
      yield* putItems([
        message("first", 1, "  Fix the\n\n  login   bug "),
        message("reply", 2, "Done.", { role: "assistant" }),
        message("compact", 3, " /compact "),
        message("compact-with-file", 4, "/compact", { attachments: 1 }),
        message("long", 5, `${"word ".repeat(100)}end`),
      ]);
      const outline = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
        projections.getThreadOutline(threadId),
      );
      assert.deepEqual(
        outline.map((entry) => entry.id),
        ["first", "compact-with-file", "long"],
      );
      assert.equal(outline[0]?.text, "Fix the login bug");
      assert.equal(outline[0]?.createdAt, DateTime.formatIso(at(1)));
      assert.equal(outline[2]?.text, "word ".repeat(100).slice(0, TEMPO_THREAD_OUTLINE_TEXT_LIMIT));
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("includes the messages a fork inherits, before its own", () =>
    Effect.gen(function* () {
      yield* createProject;
      const parent = ThreadId.make("thread:outline-parent");
      const forkRun = RunId.make("run:fork-point");
      const laterRun = RunId.make("run:after-fork");
      yield* commit([thread(parent), run(parent, forkRun, 1), run(parent, laterRun, 2)]);
      yield* putItems([
        message("inherited", 1, "Before the fork", { owner: parent, run: forkRun }),
        message("after-fork", 2, "Only on the parent", { owner: parent, run: laterRun }),
      ]);
      yield* commit([
        thread(threadId, { forkedFrom: { type: "run", threadId: parent, runId: forkRun } }),
        run(threadId, runId, 1),
      ]);
      yield* putItems([message("local", 1, "On the fork")]);
      const outline = yield* Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
        projections.getThreadOutline(threadId),
      );
      assert.deepEqual(
        outline.map((entry) => entry.id),
        ["inherited", "local"],
      );
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("fails for a deleted thread", () =>
    Effect.gen(function* () {
      yield* createProject;
      yield* commit([thread(threadId), run(threadId, runId, 1)]);
      yield* putItems([message("first", 1, "Hello")]);
      const deleted = thread(threadId, { deletedAt: at(3) });
      yield* commit([{ ...deleted, id: EventId.make("deleted"), type: "thread.deleted" }]);
      const error = yield* Effect.flip(
        Effect.flatMap(ProjectionStore.ProjectionStoreV2, (projections) =>
          projections.getThreadOutline(threadId),
        ),
      );
      assert.equal(error._tag, "ProjectionStoreThreadNotFoundError");
    }).pipe(Effect.provide(layerTest)),
  );
});
