import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

const layerSql = ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const base = DateTime.makeUnsafe("2026-10-16T10:00:00Z");
const providerInstanceId = ProviderInstanceId.make("claude");

const createThread = Effect.fn(function* (name: string) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const threadId = ThreadId.make(`thread:sub-chat:${name}`);
  const thread: OrchestrationV2AppThread = {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make("project:sub-chat"),
    title: name,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: base,
    updatedAt: base,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* store.apply({
    id: EventId.make(`event:sub-chat:${name}`),
    type: "thread.created",
    threadId,
    occurredAt: base,
    payload: thread,
  });
  return threadId;
});

const sendMessage = Effect.fn(function* (
  threadId: ThreadId,
  id: string,
  minutes: number,
  sender?: ThreadId,
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const at = DateTime.add(base, { minutes });
  yield* store.apply({
    id: EventId.make(`event:sub-chat:${id}`),
    type: "message.updated",
    threadId,
    occurredAt: at,
    payload: {
      createdBy: sender === undefined ? "user" : "agent",
      creationSource: sender === undefined ? "web" : "mcp",
      ...(sender === undefined ? {} : { senderThreadId: sender }),
      id: MessageId.make(`message:sub-chat:${id}`),
      threadId,
      runId: null,
      nodeId: null,
      role: "user",
      text: id,
      attachments: [],
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });
});

it.effect("sql: a chat's shell names the chat whose message started it", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const creator = yield* createThread("creator");
    const other = yield* createThread("other");

    const launched = yield* createThread("launched");
    yield* sendMessage(launched, "launched-1", 1, creator);
    yield* sendMessage(launched, "launched-2", 2, other);

    const userStarted = yield* createThread("user-started");
    yield* sendMessage(userStarted, "user-started-1", 1);

    const sentLater = yield* createThread("sent-later");
    yield* sendMessage(sentLater, "sent-later-1", 1);
    yield* sendMessage(sentLater, "sent-later-2", 2, creator);

    const emptyLaunch = yield* createThread("empty-launch");

    const self = yield* createThread("self");
    yield* sendMessage(self, "self-1", 1, self);

    const expected = new Map<ThreadId, ThreadId | undefined>([
      [launched, creator],
      [userStarted, undefined],
      [sentLater, undefined],
      [emptyLaunch, undefined],
      [self, undefined],
      [creator, undefined],
    ]);
    const listed = (yield* store.getShellSnapshot()).threads;
    for (const [threadId, createdBy] of expected) {
      assert.equal(
        listed.find((thread) => thread.id === threadId)?.tempoCreatedByThreadId,
        createdBy,
        `snapshot ${threadId}`,
      );
      assert.equal(
        (yield* store.getThreadShell(threadId))?.tempoCreatedByThreadId,
        createdBy,
        `thread shell ${threadId}`,
      );
    }
  }).pipe(Effect.provide(layerSql)),
);
