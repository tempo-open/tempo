/**
 * tempo: watchers. A thread-bound scheduled task whose interval runs a shell check in the thread's
 * workspace without waking the agent; the first result that meets the condition goes to the thread
 * with the task's prompt and removes the watcher. Threads carry them and other enabled bound tasks
 * as `tempoScheduledWaits`; only watchers become monitor background work (the thread shows Waiting).
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ScheduledTaskId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The shortest and longest gaps between two checks. */
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 24 * 60;
/** A watcher whose condition was not met this long after it was armed ends and tells its thread. */
export const TEMPO_WATCHER_LIFETIME_MS = 7 * 24 * 60 * 60_000;
/** One check is stopped after this long; a stopped check counts as failed. */
export const TEMPO_WATCHER_CHECK_TIMEOUT_MS = 60_000;
/** The end of a check's combined output that is kept, shown, and sent with a wake. */
export const TEMPO_WATCHER_OUTPUT_TAIL_CHARS = 2_000;

export const TempoWatcherWakeWhen = Schema.Literals([
  "succeeds",
  "fails",
  "output_changes",
]).annotate({
  description:
    "succeeds: the check exits 0. fails: it exits non-zero or times out. output_changes: a check that exits 0 prints different standard output (trimmed) than the first check that exited 0.",
});
export type TempoWatcherWakeWhen = typeof TempoWatcherWakeWhen.Type;

export const TempoWatcherCheck = Schema.Struct({
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(4_000)).annotate({
    description:
      "Shell command run with /bin/sh -c in the thread's workspace, as the same user, with no TTY and empty stdin.",
  }),
  wakeWhen: TempoWatcherWakeWhen,
});
export type TempoWatcherCheck = typeof TempoWatcherCheck.Type;

export const TempoWatcherCheckResult = Schema.Struct({
  checkedAt: IsoDateTime,
  /** Null when the check timed out. */
  exitCode: Schema.NullOr(Schema.Int),
  timedOut: Schema.Boolean,
  /** The end of its standard output followed by its standard error. */
  output: Schema.String,
});
export type TempoWatcherCheckResult = typeof TempoWatcherCheckResult.Type;

/** A scheduled task's watcher as clients and agents read it. */
export const TempoWatcher = Schema.Struct({
  ...TempoWatcherCheck.fields,
  /** When the watcher ends if its condition is still not met. */
  expiresAt: IsoDateTime,
  /** The latest check; null until one ran since the watcher was armed or resumed. */
  lastCheck: Schema.NullOr(TempoWatcherCheckResult),
});
export type TempoWatcher = typeof TempoWatcher.Type;

/** A scheduled task bound to a thread that will wake it later. */
export const TempoScheduledWait = Schema.Struct({
  taskId: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  kind: Schema.Literals(["watcher", "schedule"]),
});
export type TempoScheduledWait = typeof TempoScheduledWait.Type;

/** The agent's `watch_command` tool. */
export const TempoWatchCommandInput = Schema.Struct({
  ...TempoWatcherCheck.fields,
  everyMinutes: Schema.Int.check(
    Schema.isBetween({ minimum: MIN_INTERVAL_MINUTES, maximum: MAX_INTERVAL_MINUTES }),
  ).annotate({ description: "Minutes between checks, from 1 to 1440." }),
  prompt: TrimmedNonEmptyString.check(Schema.isMaxLength(8_000)).annotate({
    description:
      "What to do once the condition holds, written for yourself later. It arrives in this thread with the check's exit code and output.",
  }),
  title: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(120)).annotate({
      description:
        "Short name shown in the thread's Automations and the sidebar, such as 'API recovers from 429'. Defaults to the prompt's first line.",
    }),
  ),
  clientRequestId: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(256)).annotate({
      description: "Stable idempotency key to reuse when retrying this call.",
    }),
  ),
});
export type TempoWatchCommandInput = typeof TempoWatchCommandInput.Type;

export const TempoWatchCommandResult = Schema.Struct({
  /** False when the first check already met the condition, so nothing was armed. */
  armed: Schema.Boolean,
  scheduledTaskId: Schema.NullOr(ScheduledTaskId),
  firstCheck: TempoWatcherCheckResult,
  nextCheckAt: Schema.NullOr(IsoDateTime),
  expiresAt: Schema.NullOr(IsoDateTime),
  message: Schema.String,
});
export type TempoWatchCommandResult = typeof TempoWatchCommandResult.Type;
