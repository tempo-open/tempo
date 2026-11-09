// @effect-diagnostics globalTimers:off - The move runs in the client as promises, outside an Effect runtime.
/**
 * tempo: moving a thread between environments, driven by a client connected to both, since neither
 * server trusts the other. The source prepares an archive, the client carries the bytes over signed
 * HTTP URLs, the target imports it, and only then does the source become a stub. Web and mobile
 * share this; each passes its own byte transport.
 */
import {
  TEMPO_THREAD_MOVE_WS_METHODS,
  type TempoThreadMoveAbortInput,
  type TempoThreadMoveCreateImportUploadInput,
  type TempoThreadMoveCreateImportUploadResult,
  type TempoThreadMoveFinalizeInput,
  type TempoThreadMoveFinalizeResult,
  type TempoThreadMoveImportInput,
  type TempoThreadMoveImportResult,
  type TempoThreadMovePrepareInput,
  type TempoThreadMovePrepareResult,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createEnvironmentRpcCommand,
  runAtomCommand,
  squashAtomCommandFailure,
  type AtomCommand,
} from "../state/runtime.ts";

/** RPC commands for each step; each client builds them on its own connection runtime. */
export function createThreadMoveEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    prepare: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo-thread-move:prepare",
      tag: TEMPO_THREAD_MOVE_WS_METHODS.prepare,
    }),
    createImportUpload: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo-thread-move:create-import-upload",
      tag: TEMPO_THREAD_MOVE_WS_METHODS.createImportUpload,
    }),
    importMove: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo-thread-move:import",
      tag: TEMPO_THREAD_MOVE_WS_METHODS.import,
    }),
    finalize: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo-thread-move:finalize",
      tag: TEMPO_THREAD_MOVE_WS_METHODS.finalize,
    }),
    abort: createEnvironmentRpcCommand(runtime, {
      label: "environment-command:tempo-thread-move:abort",
      tag: TEMPO_THREAD_MOVE_WS_METHODS.abort,
    }),
  };
}

/** The calls a move makes; each rejects with the step's typed error. */
export interface ThreadMoveCalls {
  readonly prepare: (
    environmentId: EnvironmentId,
    input: TempoThreadMovePrepareInput,
  ) => Promise<TempoThreadMovePrepareResult>;
  readonly createImportUpload: (
    environmentId: EnvironmentId,
    input: TempoThreadMoveCreateImportUploadInput,
  ) => Promise<TempoThreadMoveCreateImportUploadResult>;
  readonly importMove: (
    environmentId: EnvironmentId,
    input: TempoThreadMoveImportInput,
  ) => Promise<TempoThreadMoveImportResult>;
  readonly finalize: (
    environmentId: EnvironmentId,
    input: TempoThreadMoveFinalizeInput,
  ) => Promise<TempoThreadMoveFinalizeResult>;
  readonly abort: (environmentId: EnvironmentId, input: TempoThreadMoveAbortInput) => Promise<void>;
}

/** `ThreadMoveCalls` backed by the atom commands, without reporting failures twice. */
export function threadMoveCallsFromAtoms(
  registry: AtomRegistry.AtomRegistry,
  commands: ReturnType<typeof createThreadMoveEnvironmentAtoms>,
): ThreadMoveCalls {
  const call =
    <I, A, Er>(
      command: AtomCommand<{ readonly environmentId: EnvironmentId; readonly input: I }, A, Er>,
    ) =>
    async (environmentId: EnvironmentId, input: I): Promise<A> => {
      const result = await runAtomCommand(
        registry,
        command,
        { environmentId, input },
        { reportFailure: false },
      );
      if (result._tag !== "Success") throw squashAtomCommandFailure(result);
      return result.value;
    };
  return {
    prepare: call(commands.prepare),
    createImportUpload: call(commands.createImportUpload),
    importMove: call(commands.importMove),
    finalize: call(commands.finalize),
    abort: async (environmentId, input) => {
      await call(commands.abort)(environmentId, input);
    },
  };
}

export type ThreadMoveStep = "prepare" | "transfer" | "import" | "finalize";

export interface ThreadMoveEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

interface ThreadMoveTransferUrls {
  readonly downloadUrl: string;
  readonly uploadUrl: string;
  readonly sizeBytes: number;
}

/** Whether the source became a stub. Until it does, both copies stay usable. */
export type ThreadMoveFinalizeOutcome =
  | { readonly ok: true; readonly pausedScheduledTasks: number }
  | { readonly ok: false; readonly error: unknown };

type ThreadMoveOutcome =
  | {
      readonly status: "moved";
      readonly threadId: ThreadId;
      readonly environmentId: EnvironmentId;
      /** The thread had no Git remote, so its folder was copied into a new folder there. */
      readonly copiedFolder: boolean;
      readonly notes: ReadonlyArray<string>;
      readonly finalized: ThreadMoveFinalizeOutcome;
      /** Asks the source again to become a stub; safe to repeat. */
      readonly retryFinalize: () => Promise<ThreadMoveFinalizeOutcome>;
    }
  | { readonly status: "failed"; readonly step: ThreadMoveStep; readonly error: unknown };

const RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1_000;

function errorTag(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    typeof error._tag === "string"
    ? error._tag
    : null;
}

/** A typed answer from a server. Anything else is the connection failing on the way. */
function isServerAnswer(error: unknown): boolean {
  const tag = errorTag(error);
  return (
    tag !== null && (tag.startsWith("TempoThreadMove") || tag === "EnvironmentAuthorizationError")
  );
}

/** An answer that asking again cannot change; only failed steps and lost connections can. */
export function isThreadMoveRefusal(error: unknown): boolean {
  return isServerAnswer(error) && errorTag(error) !== "TempoThreadMoveFailedError";
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Calls `call` until it succeeds, fails in a way `retryable` rules out, or attempts run out. */
async function withRetries<A>(
  call: () => Promise<A>,
  retryable: (error: unknown) => boolean,
  sleep: (ms: number) => Promise<void>,
): Promise<
  { readonly ok: true; readonly value: A } | { readonly ok: false; readonly error: unknown }
> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return { ok: true, value: await call() };
    } catch (error) {
      if (!retryable(error) || attempt >= RETRY_ATTEMPTS) return { ok: false, error };
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
}

async function finalizeWithRetries(
  finalize: () => Promise<TempoThreadMoveFinalizeResult>,
  sleep: (ms: number) => Promise<void>,
): Promise<ThreadMoveFinalizeOutcome> {
  const result = await withRetries(finalize, (error) => !isThreadMoveRefusal(error), sleep);
  return result.ok
    ? { ok: true, pausedScheduledTasks: result.value.pausedScheduledTasks }
    : { ok: false, error: result.error };
}

/**
 * Moves `threadId` from `source` to `target`. A failure before the target
 * imports aborts the move on the source, which leaves the thread as it was.
 */
export async function runThreadMove(input: {
  readonly calls: ThreadMoveCalls;
  readonly threadId: ThreadId;
  readonly source: ThreadMoveEnvironment;
  readonly target: ThreadMoveEnvironment;
  /** Whether the target takes a thread with no Git remote as a copy of its folder (`tempoThreadMoveFolders`). */
  readonly allowFolder: boolean;
  readonly resolveHttpUrl: (environmentId: EnvironmentId, relativeUrl: string) => string | null;
  readonly transfer: (urls: ThreadMoveTransferUrls) => Promise<void>;
  readonly onStep?: (step: ThreadMoveStep) => void;
  /** Waits between attempts at a step; tests pass one that does not wait. */
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<ThreadMoveOutcome> {
  const { calls, source, target } = input;
  input.onStep?.("prepare");
  let prepared: TempoThreadMovePrepareResult;
  try {
    prepared = await calls.prepare(source.environmentId, {
      threadId: input.threadId,
      allowFolder: input.allowFolder,
    });
  } catch (error) {
    return { status: "failed", step: "prepare", error };
  }
  const abort = () =>
    calls
      .abort(source.environmentId, { threadId: input.threadId, moveId: prepared.moveId })
      .catch(() => undefined);

  input.onStep?.("transfer");
  try {
    const upload = await calls.createImportUpload(target.environmentId, {
      moveId: prepared.moveId,
      sizeBytes: prepared.sizeBytes,
      repository: prepared.repository,
    });
    const downloadUrl = input.resolveHttpUrl(source.environmentId, prepared.downloadRelativeUrl);
    const uploadUrl = input.resolveHttpUrl(target.environmentId, upload.uploadRelativeUrl);
    if (downloadUrl === null || uploadUrl === null) {
      throw new Error("Both machines must stay connected while the thread moves.");
    }
    await input.transfer({ downloadUrl, uploadUrl, sizeBytes: prepared.sizeBytes });
  } catch (error) {
    await abort();
    return { status: "failed", step: "transfer", error };
  }

  input.onStep?.("import");
  const sleep = input.sleep ?? defaultSleep;
  // The target imports a move once, so asking again after a lost answer returns the thread it made.
  const importResult = await withRetries(
    () =>
      calls.importMove(target.environmentId, {
        moveId: prepared.moveId,
        source: { environmentId: source.environmentId, environmentLabel: source.label },
      }),
    (error) => !isServerAnswer(error),
    sleep,
  );
  if (!importResult.ok) {
    await abort();
    return { status: "failed", step: "import", error: importResult.error };
  }
  const imported = importResult.value;

  input.onStep?.("finalize");
  const finalize = () =>
    calls.finalize(source.environmentId, {
      threadId: input.threadId,
      moveId: prepared.moveId,
      target: {
        environmentId: target.environmentId,
        environmentLabel: target.label,
        threadId: imported.threadId,
      },
    });
  return {
    status: "moved",
    threadId: imported.threadId,
    environmentId: target.environmentId,
    copiedFolder: prepared.repository === null,
    notes: imported.notes,
    finalized: await finalizeWithRetries(finalize, sleep),
    retryFinalize: () => finalizeWithRetries(finalize, sleep),
  };
}

/** Byte transport over `fetch`: the signed URLs are the only credential. */
export async function transferThreadMoveArchive(
  urls: ThreadMoveTransferUrls,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const download = await fetchImpl(urls.downloadUrl, { cache: "no-store" });
  if (!download.ok) throw new Error(`Downloading the thread failed (${download.status}).`);
  const body = await download.blob();
  if (body.size !== urls.sizeBytes) throw new Error("The thread download was incomplete.");
  const upload = await fetchImpl(urls.uploadUrl, {
    method: "POST",
    body,
    headers: { "content-type": "application/octet-stream" },
  });
  if (!upload.ok) throw new Error(`Uploading the thread failed (${upload.status}).`);
}

/** Connected environments a thread on `sourceEnvironmentId` can move to. */
export function threadMoveTargets<
  T extends ThreadMoveEnvironment & { readonly connected: boolean },
>(sourceEnvironmentId: EnvironmentId, environments: ReadonlyArray<T>): ReadonlyArray<T> {
  return environments.filter(
    (environment) => environment.connected && environment.environmentId !== sourceEnvironmentId,
  );
}
