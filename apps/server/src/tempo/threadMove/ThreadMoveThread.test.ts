import { assert, describe, it } from "@effect/vitest";
import {
  ComposerContextId,
  TempoThreadMoveId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type TempoThreadMoveManifest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import {
  buildMovedThreadEvents,
  exportMovedMessages,
  movedAwayThread,
  movedThreadId,
  resolveMovedModelSelection,
  rewriteMovedPaths,
} from "./ThreadMoveThread.ts";

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerTest = Layer.mergeAll(layerStores, EventSink.layer.pipe(Layer.provide(layerStores)));

const moveId = TempoThreadMoveId.make("0f0e0d0c-0b0a-4908-8706-050403020100");
const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const codex = ProviderInstanceId.make("codex");

function manifest(overrides: Partial<TempoThreadMoveManifest> = {}): TempoThreadMoveManifest {
  return {
    format: "tempo-thread-move",
    version: 1,
    moveId,
    createdAt: at,
    source: {
      threadId: ThreadId.make("source-thread"),
      projectId: ProjectId.make("source-project"),
      cwd: "/Users/a/.t3/worktrees/repo/feature",
      workspaceRoot: "/Users/a/code/repo",
    },
    repository: {
      canonicalKey: "github.com/acme/app",
      groupingKey: "github.com/acme/app",
      displayName: "acme/app",
    },
    git: {
      branch: "feature",
      headCommit: "a".repeat(40),
      wipCommit: null,
      bundleFile: null,
      bundleRefs: [],
    },
    thread: {
      title: "Fix the importer",
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      providerDriver: "codex",
      runtimeMode: "full-access",
      interactionMode: "default",
      createdAt: at,
      movedFrom: null,
    },
    messages: [
      {
        role: "user",
        text: "Look at /Users/a/.t3/worktrees/repo/feature/src/index.ts and /Users/a/code/repo/README.md",
        attachments: [
          {
            type: "image",
            id: "source-thread-00000000-0000-4000-8000-000000000001",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 3,
          },
        ],
        context: {
          version: 1,
          records: [
            {
              version: 1,
              contextId: ComposerContextId.make("ctx-screen"),
              label: "screen.png",
              kind: "image",
              attachmentId: "source-thread-00000000-0000-4000-8000-000000000001",
              name: "screen.png",
              mimeType: "image/png",
              sizeBytes: 3,
            },
            {
              version: 1,
              contextId: ComposerContextId.make("ctx-log"),
              label: "build.log",
              kind: "file",
              attachmentId: "source-thread-00000000-0000-4000-8000-000000000009",
              name: "build.log",
              mimeType: "text/plain",
              sizeBytes: 12,
            },
          ],
        },
        createdAt: at,
        updatedAt: at,
      },
      { role: "assistant", text: "Done.", attachments: [], createdAt: at, updatedAt: at },
      {
        role: "assistant",
        kind: "plan",
        text: "1. Edit /Users/a/code/repo/README.md",
        attachments: [],
        createdAt: at,
        updatedAt: at,
      },
    ],
    providerRefs: [],
    files: [],
    ...overrides,
  };
}

/** What an import builds the thread from: the manifest's thread and messages. */
function movedThread() {
  const { moveId: id, thread, messages } = manifest();
  return { eventPrefix: `tempo-move:${id}`, thread, messages };
}

describe("rewriteMovedPaths", () => {
  const mappings = [
    { from: "/Users/a/code/repo", to: "/Volumes/mini/repo" },
    { from: "/Users/a/code/repo/packages/app", to: "/Volumes/mini/app" },
  ];

  it("rewrites paths under a mapped root and prefers the longest root", () => {
    assert.equal(
      rewriteMovedPaths("open /Users/a/code/repo/src/a.ts, then /Users/a/code/repo", mappings),
      "open /Volumes/mini/repo/src/a.ts, then /Volumes/mini/repo",
    );
    assert.equal(
      rewriteMovedPaths("`/Users/a/code/repo/packages/app/x.ts`", mappings),
      "`/Volumes/mini/app/x.ts`",
    );
  });

  it("leaves look-alike paths alone", () => {
    for (const text of [
      "/Users/a/code/repository/src",
      "/x/Users/a/code/repo/src",
      "/Users/a/code/repo-old/a.ts",
      "/Users/a/code/repo.bak",
      "/Users/a/code/repo.d/a.ts",
    ]) {
      assert.equal(rewriteMovedPaths(text, mappings), text);
    }
  });

  it("rewrites file URLs and a root that ends a sentence", () => {
    assert.equal(
      rewriteMovedPaths("open file:///Users/a/code/repo/a.ts", mappings),
      "open file:///Volumes/mini/repo/a.ts",
    );
    assert.equal(
      rewriteMovedPaths("Work in /Users/a/code/repo. Then /Users/a/code/repo.", mappings),
      "Work in /Volumes/mini/repo. Then /Volumes/mini/repo.",
    );
  });
});

describe("resolveMovedModelSelection", () => {
  const selection = { instanceId: ProviderInstanceId.make("codex_hub"), model: "gpt-5.4" };

  it("keeps the source instance when this machine has it", () => {
    const result = resolveMovedModelSelection({
      modelSelection: selection,
      providerDriver: "codex",
      instances: [{ instanceId: selection.instanceId, driverKind: "codex", enabled: true }],
    });
    assert.deepEqual(result, { modelSelection: selection, available: true });
  });

  it("falls back to an enabled instance of the same driver", () => {
    const result = resolveMovedModelSelection({
      modelSelection: selection,
      providerDriver: "codex",
      instances: [
        { instanceId: ProviderInstanceId.make("codex_off"), driverKind: "codex", enabled: false },
        { instanceId: codex, driverKind: "codex", enabled: true },
      ],
    });
    assert.deepEqual(result, {
      modelSelection: { instanceId: codex, model: "gpt-5.4" },
      available: true,
    });
  });

  it("reports when no instance can continue the thread", () => {
    const result = resolveMovedModelSelection({
      modelSelection: selection,
      providerDriver: "codex",
      instances: [
        {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          driverKind: "claudeAgent",
          enabled: true,
        },
      ],
    });
    assert.isFalse(result.available);
  });
});

describe("moved thread events", () => {
  it.effect("import as a runless thread that keeps its trail, then the source becomes a stub", () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = movedThreadId(moveId);
      const movedAttachment = "tempo-moved-attachment-00000000-0000-4000-8000-000000000002";
      const events = buildMovedThreadEvents({
        ...movedThread(),
        threadId,
        projectId: ProjectId.make("target-project"),
        branch: "feature",
        worktreePath: "/Volumes/mini/worktrees/repo/feature",
        movedFrom: {
          moveId,
          environmentId: EnvironmentId.make("laptop"),
          environmentLabel: "Laptop",
          threadId: ThreadId.make("source-thread"),
          movedAt: "2026-10-01T10:05:00.000Z",
        },
        now: at,
        pathMappings: [
          {
            from: "/Users/a/.t3/worktrees/repo/feature",
            to: "/Volumes/mini/worktrees/repo/feature",
          },
          { from: "/Users/a/code/repo", to: "/Volumes/mini/repo" },
        ],
        attachmentIds: new Map([
          ["source-thread-00000000-0000-4000-8000-000000000001", movedAttachment],
        ]),
      });
      yield* sink.write({ events });
      // The same import writes the same event ids, so a retry is recognisable.
      assert.deepEqual(
        buildMovedThreadEvents({
          ...movedThread(),
          threadId,
          projectId: ProjectId.make("target-project"),
          branch: "feature",
          worktreePath: "/Volumes/mini/worktrees/repo/feature",
          movedFrom: {
            moveId,
            environmentId: EnvironmentId.make("laptop"),
            environmentLabel: "Laptop",
            threadId: ThreadId.make("source-thread"),
            movedAt: "2026-10-01T10:05:00.000Z",
          },
          now: at,
          pathMappings: [],
          attachmentIds: new Map(),
        }).map((event) => event.id),
        events.map((event) => event.id),
      );

      const records = yield* projections.getThreadRecords(threadId, ["messages", "runs"]);
      assert.equal(records.thread.historyOrigin, "v1_import");
      assert.equal(records.thread.worktreePath, "/Volumes/mini/worktrees/repo/feature");
      assert.equal(records.thread.movedFrom?.environmentLabel, "Laptop");
      assert.lengthOf(records.runs, 0);
      assert.deepEqual(
        records.messages.map((message) => message.text),
        [
          "Look at /Volumes/mini/worktrees/repo/feature/src/index.ts and /Volumes/mini/repo/README.md",
          "Done.",
        ],
      );
      assert.deepEqual(
        records.messages[0]?.attachments.map((attachment) => attachment.id),
        [movedAttachment],
      );
      // Chips find their attachment by id; a chip whose file stayed behind goes with it.
      assert.deepEqual(
        records.messages[0]?.context?.records.map((record) => [
          record.contextId,
          "attachmentId" in record ? record.attachmentId : null,
        ]),
        [["ctx-screen", movedAttachment]],
      );
      const projection = yield* projections.getThreadProjection(threadId);
      const plan = projection.turnItems.find((item) => item.type === "proposed_plan");
      assert.equal(
        plan?.type === "proposed_plan" ? plan.markdown : null,
        "1. Edit /Volumes/mini/repo/README.md",
      );
      // A moved thread moves on with its plan.
      assert.deepEqual(
        exportMovedMessages(projection).map((message) => [message.role, message.kind ?? null]),
        [
          ["user", null],
          ["assistant", null],
          ["assistant", "plan"],
        ],
      );
      const shell = yield* projections.getThreadShell(threadId);
      assert.equal(shell?.movedFrom?.threadId, "source-thread");
      assert.isUndefined(shell?.movedTo);

      // Finalizing on the source: the same thread, now pointing at its new home.
      const stubAt = DateTime.makeUnsafe("2026-10-01T10:06:00.000Z");
      yield* sink.write({
        events: [
          {
            id: EventId.make("tempo-move:test:moved-away"),
            type: "thread.metadata-updated",
            threadId,
            occurredAt: stubAt,
            payload: movedAwayThread(
              records.thread,
              {
                moveId,
                environmentId: EnvironmentId.make("mini"),
                environmentLabel: "Desk Mac",
                threadId: ThreadId.make("target-thread"),
                movedAt: DateTime.formatIso(stubAt),
              },
              stubAt,
            ),
          },
        ],
      });
      const stub = yield* projections.getThreadShell(threadId);
      assert.equal(stub?.movedTo?.environmentLabel, "Desk Mac");
      assert.equal(stub?.settledOverride, "settled");
      assert.equal(stub?.movedFrom?.environmentLabel, "Laptop");
    }).pipe(Effect.provide(layerTest)),
  );
});
