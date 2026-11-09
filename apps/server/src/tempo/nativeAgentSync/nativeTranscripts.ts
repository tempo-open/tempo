/**
 * Synced threads resume their native session (importedNativeSession.ts), but Tempo's own provider
 * homes lack its transcript: before it resumes or forks, the transcript is copied to where the
 * provider looks; it writes only that copy, never the native files. Codex also gets a reverted
 * thread's older rollouts and the thread a fork started from, since its history reads them.
 */
import type { OrchestrationV2ProviderThread } from "@t3tools/contracts";
import type { ProviderAdapterV2SessionRuntime } from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";

import { CODEX_ROLLOUT } from "./nativeDiscovery.ts";

/** Forks reach back at most this many threads. */
const MAX_FORK_DEPTH = 8;
const HEAD_BYTES = 512 * 1024;

const RolloutHead = Schema.Struct({
  type: Schema.optional(Schema.String),
  payload: Schema.optional(
    Schema.Struct({
      forked_from_id: Schema.optional(Schema.NullOr(Schema.String)),
      history_base: Schema.optional(
        Schema.NullOr(Schema.Struct({ thread_id: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const decodeRolloutHead = Schema.decodeUnknownOption(Schema.fromJsonString(RolloutHead));

export interface NativeTranscriptHomes {
  readonly driver: "claudeAgent" | "codex";
  /** The home Tempo runs this provider from. */
  readonly tempoHome: string;
  /** The host's own home for it (see nativeHomes.ts), or null when there is none. */
  readonly nativeHome: string | null;
}

/** The native session a synced thread was imported with, or null for any other provider thread. */
const importedNativeId = (providerThread: OrchestrationV2ProviderThread): string | null => {
  const nativeId = providerThread.nativeThreadRef?.nativeId;
  if (nativeId === undefined || nativeId === null || nativeId === "") return null;
  return providerThread.appThreadId === `import:${providerThread.providerInstanceId}:${nativeId}`
    ? nativeId
    : null;
};

interface CodexRollout {
  readonly file: string;
  /** `sessions/YYYY/MM/DD`, the folder Codex keeps it in while not archived. */
  readonly day: ReadonlyArray<string>;
}

const makeCopier = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));
  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));

  /**
   * Written beside the target and renamed, so a provider never sees half a
   * transcript. Dated now: Claude Code deletes transcripts by age.
   */
  const copyInto = Effect.fn("nativeTranscripts.copyInto")(
    function* (source: string, target: string) {
      if (yield* exists(target)) return;
      const directory = path.dirname(target);
      yield* fileSystem.makeDirectory(directory, { recursive: true });
      const suffix = Math.abs(yield* Random.nextInt).toString(36);
      const temporary = path.join(directory, `.${path.basename(target)}.tempo-${suffix}.tmp`);
      const now = DateTime.toDateUtc(yield* DateTime.now);
      yield* fileSystem.copyFile(source, temporary).pipe(
        Effect.andThen(fileSystem.utimes(temporary, now, now)),
        Effect.andThen(fileSystem.rename(temporary, target)),
        Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)),
      );
      yield* Effect.logInfo(`copied a synced session's transcript into ${TEMPO_APP_BASE_NAME}`, {
        target,
      });
    },
    (effect, source, target) =>
      effect.pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            `could not copy a synced session's transcript into ${TEMPO_APP_BASE_NAME}`,
            {
              source,
              target,
              cause,
            },
          ),
        ),
      ),
  );

  const prepareClaude = Effect.fn("nativeTranscripts.prepareClaude")(function* (
    homes: NativeTranscriptHomes & { readonly nativeHome: string },
    nativeId: string,
  ) {
    const fileName = `${nativeId}.jsonl`;
    const projectsDir = path.join(homes.nativeHome, "projects");
    for (const folder of yield* listDirectory(projectsDir)) {
      const source = path.join(projectsDir, folder, fileName);
      if (!(yield* exists(source))) continue;
      // The same folder: Tempo runs the thread in the directory the session ran in.
      yield* copyInto(source, path.join(homes.tempoHome, "projects", folder, fileName));
      return;
    }
  });

  /** Every rollout in a Codex home, by thread id. */
  const indexCodexRollouts = Effect.fn("nativeTranscripts.indexCodexRollouts")(function* (
    codexHome: string,
  ) {
    const byThread = new Map<string, Array<CodexRollout>>();
    const add = (directory: string, entry: string, day: ReadonlyArray<string> | null) => {
      const match = CODEX_ROLLOUT.exec(entry);
      const threadId = match?.[2]?.toLowerCase();
      const date = match?.[1];
      if (threadId === undefined || date === undefined) return;
      // Codex dates the folder by the local time in the name; so does `codex unarchive`.
      const folder = day ?? date.slice(0, 10).split("-");
      const list = byThread.get(threadId) ?? [];
      list.push({ file: path.join(directory, entry), day: folder });
      byThread.set(threadId, list);
    };
    const sessionsDir = path.join(codexHome, "sessions");
    for (const year of yield* listDirectory(sessionsDir)) {
      for (const month of yield* listDirectory(path.join(sessionsDir, year))) {
        for (const day of yield* listDirectory(path.join(sessionsDir, year, month))) {
          const directory = path.join(sessionsDir, year, month, day);
          for (const entry of yield* listDirectory(directory)) {
            add(directory, entry, [year, month, day]);
          }
        }
      }
    }
    const archivedDir = path.join(codexHome, "archived_sessions");
    for (const entry of yield* listDirectory(archivedDir)) add(archivedDir, entry, null);
    return byThread;
  });

  /** The threads a rollout's history starts from, as its first line names them. */
  const ancestorsOf = Effect.fn("nativeTranscripts.ancestorsOf")(function* (file: string) {
    if (file.endsWith(".zst")) return [];
    const head = yield* Effect.scoped(
      fileSystem
        .open(file, { flag: "r" })
        .pipe(Effect.flatMap((handle) => handle.readAlloc(HEAD_BYTES))),
    ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
    if (Option.isNone(head)) return [];
    const firstLine = new TextDecoder().decode(head.value).split("\n")[0] ?? "";
    const meta = decodeRolloutHead(firstLine);
    if (Option.isNone(meta) || meta.value.type !== "session_meta") return [];
    return [
      meta.value.payload?.forked_from_id,
      meta.value.payload?.history_base?.thread_id,
    ].flatMap((id) => (typeof id === "string" && id !== "" ? [id.toLowerCase()] : []));
  });

  const prepareCodex = Effect.fn("nativeTranscripts.prepareCodex")(function* (
    homes: NativeTranscriptHomes & { readonly nativeHome: string },
    nativeId: string,
  ) {
    const index = yield* indexCodexRollouts(homes.nativeHome);
    const targetOf = (rollout: CodexRollout) =>
      path.join(homes.tempoHome, "sessions", ...rollout.day, path.basename(rollout.file));
    // Copied before: Tempo's copy is the thread's now, and a newer native rollout
    // (a revert there) must not become the one Codex resumes here.
    for (const rollout of index.get(nativeId.toLowerCase()) ?? []) {
      if (yield* exists(targetOf(rollout))) return;
    }
    const seen = new Set<string>();
    let pending = [nativeId.toLowerCase()];
    for (let depth = 0; depth < MAX_FORK_DEPTH && pending.length > 0; depth += 1) {
      const next: Array<string> = [];
      for (const threadId of pending) {
        if (seen.has(threadId)) continue;
        seen.add(threadId);
        for (const rollout of index.get(threadId) ?? []) {
          yield* copyInto(rollout.file, targetOf(rollout));
          next.push(...(yield* ancestorsOf(rollout.file)));
        }
      }
      pending = next;
    }
  });

  return { prepareClaude, prepareCodex };
});

/**
 * The adapter with every session's resume and fork preceded by copying a
 * synced thread's native transcript into the Tempo home when it is not there yet.
 */
export const withNativeTranscripts = Effect.fn("nativeTranscripts.withNativeTranscripts")(
  function* (adapter: ProviderAdapter.ProviderAdapterV2["Service"], homes: NativeTranscriptHomes) {
    const nativeHome = homes.nativeHome;
    if (nativeHome === null) return adapter;
    const copier = yield* makeCopier;
    // Once prepared, a session keeps its Tempo copy; nothing to check again this run.
    const prepared = new Set<string>();
    const prepare = (providerThread: OrchestrationV2ProviderThread) => {
      const nativeId = importedNativeId(providerThread);
      if (nativeId === null || prepared.has(nativeId)) return Effect.void;
      return (
        homes.driver === "claudeAgent"
          ? copier.prepareClaude({ ...homes, nativeHome }, nativeId)
          : copier.prepareCodex({ ...homes, nativeHome }, nativeId)
      ).pipe(Effect.tap(() => Effect.sync(() => prepared.add(nativeId))));
    };
    const wrap = (runtime: ProviderAdapterV2SessionRuntime): ProviderAdapterV2SessionRuntime => ({
      ...runtime,
      resumeThread: (input) =>
        prepare(input.providerThread).pipe(Effect.andThen(runtime.resumeThread(input))),
      forkThread: (input) =>
        prepare(input.sourceProviderThread).pipe(Effect.andThen(runtime.forkThread(input))),
    });
    return {
      ...adapter,
      openSession: (input) => adapter.openSession(input).pipe(Effect.map(wrap)),
    } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
  },
);
