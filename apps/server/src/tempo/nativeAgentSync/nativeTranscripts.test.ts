import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import { withNativeTranscripts } from "./nativeTranscripts.ts";

const CLAUDE_ID = "0697f99c-0e22-406f-9d0a-7a07cf6b5ecc";
const CODEX_ID = "01a113df-9b3d-7660-8f79-fb7e6a45e63b";
const CODEX_PARENT = "01a113d0-0000-7000-8000-000000000003";
const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const OLD = DateTime.toDateUtc(DateTime.makeUnsafe("2026-08-01T10:00:00.000Z"));

const providerThread = (input: {
  readonly driver: "claudeAgent" | "codex";
  readonly appThreadId: string;
  readonly nativeId: string;
}): OrchestrationV2ProviderThread => ({
  id: ProviderThreadId.make(`provider-thread:${input.nativeId}`),
  driver: ProviderDriverKind.make(input.driver),
  providerInstanceId: ProviderInstanceId.make(input.driver),
  providerSessionId: null,
  appThreadId: ThreadId.make(input.appThreadId),
  ownerNodeId: null,
  nativeThreadRef: {
    driver: ProviderDriverKind.make(input.driver),
    nativeId: input.nativeId,
    strength: "strong",
  },
  nativeConversationHeadRef: null,
  status: "idle",
  firstRunOrdinal: null,
  lastRunOrdinal: null,
  handoffIds: [],
  forkedFrom: null,
  createdAt: at,
  updatedAt: at,
});

/** An adapter whose sessions only record which provider threads they resumed. */
const fakeAdapter = (resumed: Array<string>) =>
  ({
    openSession: () =>
      Effect.succeed({
        resumeThread: (input: { readonly providerThread: OrchestrationV2ProviderThread }) =>
          Effect.sync(() => {
            resumed.push(input.providerThread.nativeThreadRef?.nativeId ?? "");
            return input.providerThread;
          }),
        forkThread: (input: { readonly sourceProviderThread: OrchestrationV2ProviderThread }) =>
          Effect.succeed(input.sourceProviderThread),
      }),
  }) as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const resume = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  thread: OrchestrationV2ProviderThread,
) =>
  Effect.scoped(
    adapter.openSession({} as never).pipe(
      Effect.flatMap((session) =>
        session.resumeThread({
          providerThread: thread,
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/work/repo",
          },
        }),
      ),
    ),
  );

describe("withNativeTranscripts", () => {
  // Live: the copy is dated by the clock.
  it.live(
    "copies a synced Claude session into Tempo's home before it resumes, and leaves other sessions and the native file alone",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-native-copy-" });
        const nativeHome = path.join(root, "home", ".claude");
        const tempoHome = path.join(root, "tempo", "provider-homes", "claude");
        const folder = path.join(nativeHome, "projects", "-work-repo");
        yield* fileSystem.makeDirectory(folder, { recursive: true });
        const native = path.join(folder, `${CLAUDE_ID}.jsonl`);
        yield* fileSystem.writeFileString(native, '{"type":"user"}\n');
        yield* fileSystem.utimes(native, OLD, OLD);

        const resumed: Array<string> = [];
        const adapter = yield* withNativeTranscripts(fakeAdapter(resumed), {
          driver: "claudeAgent",
          tempoHome,
          nativeHome,
        });
        // A thread Tempo started itself: nothing to copy.
        yield* resume(
          adapter,
          providerThread({
            driver: "claudeAgent",
            appThreadId: "thread-started-in-tempo",
            nativeId: CLAUDE_ID,
          }),
        );
        const copy = path.join(tempoHome, "projects", "-work-repo", `${CLAUDE_ID}.jsonl`);
        assert.isFalse(yield* fileSystem.exists(copy));

        yield* resume(
          adapter,
          providerThread({
            driver: "claudeAgent",
            appThreadId: `import:claudeAgent:${CLAUDE_ID}`,
            nativeId: CLAUDE_ID,
          }),
        );
        assert.deepEqual(resumed, [CLAUDE_ID, CLAUDE_ID]);
        assert.equal(yield* fileSystem.readFileString(copy), '{"type":"user"}\n');
        // Dated now, or Claude Code's own cleanup would delete an old session's copy.
        const copied = Option.getOrThrow((yield* fileSystem.stat(copy)).mtime).getTime();
        assert.isAbove(copied, OLD.getTime());
        const original = Option.getOrThrow((yield* fileSystem.stat(native)).mtime).getTime();
        assert.equal(original, OLD.getTime());

        // Tempo's copy is the provider's from now on: a later resume never replaces it.
        yield* fileSystem.writeFileString(copy, '{"type":"user"}\n{"type":"assistant"}\n');
        yield* resume(
          adapter,
          providerThread({
            driver: "claudeAgent",
            appThreadId: `import:claudeAgent:${CLAUDE_ID}`,
            nativeId: CLAUDE_ID,
          }),
        );
        assert.equal(
          yield* fileSystem.readFileString(copy),
          '{"type":"user"}\n{"type":"assistant"}\n',
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "copies every rollout of a synced Codex thread, and the thread it forked from, into the same day folders",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-native-copy-" });
        const nativeHome = path.join(root, "home", ".codex");
        const tempoHome = path.join(root, "tempo", "provider-homes", "codex");
        const day = ["2026", "10", "01"] as const;
        const dayDir = path.join(nativeHome, "sessions", ...day);
        yield* fileSystem.makeDirectory(dayDir, { recursive: true });
        const meta = (id: string, forkedFrom?: string) =>
          `${JSON.stringify({ type: "session_meta", payload: { id, ...(forkedFrom === undefined ? {} : { forked_from_id: forkedFrom }) } })}\n`;
        const files = {
          current: `rollout-2026-10-01T10-00-00-${CODEX_ID}.jsonl`,
          reverted: `rollout-2026-10-01T09-00-00-${CODEX_ID}_01a113df-0000-7000-8000-000000000009.jsonl`,
          parent: `rollout-2026-10-01T08-00-00-${CODEX_PARENT}.jsonl`,
          unrelated: "rollout-2026-10-01T07-00-00-01a113d0-0000-7000-8000-000000000004.jsonl",
        };
        yield* fileSystem.writeFileString(
          path.join(dayDir, files.current),
          meta(CODEX_ID, CODEX_PARENT),
        );
        yield* fileSystem.writeFileString(path.join(dayDir, files.reverted), meta(CODEX_ID));
        yield* fileSystem.writeFileString(path.join(dayDir, files.parent), meta(CODEX_PARENT));
        yield* fileSystem.writeFileString(path.join(dayDir, files.unrelated), meta("other"));

        const adapter = yield* withNativeTranscripts(fakeAdapter([]), {
          driver: "codex",
          tempoHome,
          nativeHome,
        });
        yield* resume(
          adapter,
          providerThread({
            driver: "codex",
            appThreadId: `import:codex:${CODEX_ID}`,
            nativeId: CODEX_ID,
          }),
        );
        const copied = yield* fileSystem.readDirectory(path.join(tempoHome, "sessions", ...day));
        assert.deepEqual(
          copied.toSorted(),
          [files.current, files.reverted, files.parent].toSorted(),
        );
        assert.equal(
          yield* fileSystem.readFileString(path.join(tempoHome, "sessions", ...day, files.current)),
          meta(CODEX_ID, CODEX_PARENT),
        );

        // After a restart, a revert in Codex leaves Tempo's copy, which Codex resumes here, alone.
        const nativeRevert = `rollout-2026-10-01T11-00-00-${CODEX_ID}_01a113df-0000-7000-8000-00000000000a.jsonl`;
        yield* fileSystem.writeFileString(path.join(dayDir, nativeRevert), meta(CODEX_ID));
        const restarted = yield* withNativeTranscripts(fakeAdapter([]), {
          driver: "codex",
          tempoHome,
          nativeHome,
        });
        yield* resume(
          restarted,
          providerThread({
            driver: "codex",
            appThreadId: `import:codex:${CODEX_ID}`,
            nativeId: CODEX_ID,
          }),
        );
        assert.notInclude(
          yield* fileSystem.readDirectory(path.join(tempoHome, "sessions", ...day)),
          nativeRevert,
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
