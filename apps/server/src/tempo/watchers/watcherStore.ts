/**
 * tempo: a watcher's check and state, beside upstream's `scheduled_tasks`. The migrator refuses a
 * history that skips a number, so a Tempo migration would collide with upstream's next; the table is
 * created on startup instead. Its rows always name a scheduled task, and deleting the task deletes
 * its row in the same transaction.
 */
import {
  TempoWatcherCheckResult,
  TempoWatcherWakeWhen,
  ScheduledTaskId,
  type TempoWatcher,
  type TempoWatcherCheck,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { watcherExpiresAt } from "./watcherDecision.ts";

export interface StoredWatcher {
  readonly taskId: ScheduledTaskId;
  readonly watcher: TempoWatcher;
  /** When it was armed or last resumed; its lifetime counts from here. */
  readonly armedAt: string;
  /** The `output_changes` baseline: the output of the first check since arming that exited 0. */
  readonly baseline: string | null;
}

interface WatcherRow {
  readonly task_id: string;
  readonly command: string;
  readonly wake_when: string;
  readonly armed_at: string;
  readonly baseline: string | null;
  readonly last_check_json: string | null;
}

const decodeWakeWhen = Schema.decodeUnknownEffect(TempoWatcherWakeWhen);
const decodeLastCheck = Schema.decodeUnknownEffect(Schema.fromJsonString(TempoWatcherCheckResult));
const encodeLastCheck = Schema.encodeSync(Schema.fromJsonString(TempoWatcherCheckResult));

export const ensureWatcherTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tempo_scheduled_task_watchers (
      task_id TEXT PRIMARY KEY NOT NULL,
      command TEXT NOT NULL,
      wake_when TEXT NOT NULL,
      armed_at TEXT NOT NULL,
      baseline TEXT,
      last_check_json TEXT
    )
  `;
});

// Runs per row; the list and lookup that read rows own the span.
const decodeWatcherRow = Effect.fnUntraced(function* (row: WatcherRow) {
  const wakeWhen = yield* decodeWakeWhen(row.wake_when);
  const lastCheck =
    row.last_check_json === null ? null : yield* decodeLastCheck(row.last_check_json);
  return {
    taskId: ScheduledTaskId.make(row.task_id),
    watcher: {
      command: row.command,
      wakeWhen,
      expiresAt: watcherExpiresAt(row.armed_at),
      lastCheck,
    },
    armedAt: row.armed_at,
    baseline: row.baseline,
  } satisfies StoredWatcher;
});

/**
 * Every watcher, or the one of `taskId`, by task id. Each row decodes on its
 * own, so an unreadable one fails only its task, as an unreadable task row does.
 */
export const loadWatchers = Effect.fn("WatcherStore.loadWatchers")(function* (
  taskId?: ScheduledTaskId,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<WatcherRow>`
    SELECT task_id, command, wake_when, armed_at, baseline, last_check_json
    FROM tempo_scheduled_task_watchers
    ${taskId === undefined ? sql`` : sql`WHERE task_id = ${taskId}`}
  `;
  const watchers = new Map<ScheduledTaskId, Result.Result<StoredWatcher, Schema.SchemaError>>();
  for (const row of rows) {
    watchers.set(ScheduledTaskId.make(row.task_id), yield* Effect.result(decodeWatcherRow(row)));
  }
  return watchers;
});

/** Arms a watcher, replacing any earlier one of the task. */
export const saveWatcher = Effect.fn("WatcherStore.saveWatcher")(function* (input: {
  readonly taskId: ScheduledTaskId;
  readonly check: TempoWatcherCheck;
  readonly armedAt: string;
  readonly baseline: string | null;
  readonly lastCheck: TempoWatcherCheckResult | null;
}) {
  const sql = yield* SqlClient.SqlClient;
  const lastCheck = input.lastCheck === null ? null : encodeLastCheck(input.lastCheck);
  yield* sql`
    INSERT INTO tempo_scheduled_task_watchers
      (task_id, command, wake_when, armed_at, baseline, last_check_json)
    VALUES (${input.taskId}, ${input.check.command}, ${input.check.wakeWhen}, ${input.armedAt},
      ${input.baseline}, ${lastCheck})
    ON CONFLICT (task_id) DO UPDATE SET
      command = excluded.command,
      wake_when = excluded.wake_when,
      armed_at = excluded.armed_at,
      baseline = excluded.baseline,
      last_check_json = excluded.last_check_json
  `;
});

/** Records a check that did not wake, unless the watcher was re-armed while it ran. */
export const recordWatcherCheck = Effect.fn("WatcherStore.recordWatcherCheck")(function* (input: {
  readonly taskId: ScheduledTaskId;
  readonly armedAt: string;
  readonly baseline: string | null;
  readonly lastCheck: TempoWatcherCheckResult;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE tempo_scheduled_task_watchers
    SET baseline = ${input.baseline}, last_check_json = ${encodeLastCheck(input.lastCheck)}
    WHERE task_id = ${input.taskId} AND armed_at = ${input.armedAt}
  `;
});

/** Resuming a paused watcher starts its lifetime and its output baseline over. */
export const rearmWatcher = Effect.fn("WatcherStore.rearmWatcher")(function* (
  taskId: ScheduledTaskId,
  armedAt: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE tempo_scheduled_task_watchers SET armed_at = ${armedAt}, baseline = NULL
    WHERE task_id = ${taskId}
  `;
});
