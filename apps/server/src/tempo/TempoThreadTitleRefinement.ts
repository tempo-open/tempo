/**
 * tempo: a first title the model marked as written without the subject is written again, with its
 * logo, from the conversation after the agent's third message (or when its turn ends with fewer).
 * A rename removes the mark first, so a title someone chose stays.
 */
import { CommandId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

/** Agent messages after which a thread usually names its subject well enough. */
const AGENT_MESSAGES_BEFORE_SECOND_TITLE = 3;
const BATCH = 12;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const scheduler = yield* Scheduler.Scheduler;
    const sql = yield* SqlClient.SqlClient;
    // One try per thread per server start, so a thread whose second title never lands cannot loop.
    const tried = yield* Ref.make<ReadonlySet<string>>(new Set());

    const sweep = Effect.fnUntraced(function* () {
      const skip = yield* Ref.get(tried);
      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT thread.thread_id AS "threadId"
        FROM orchestration_v2_projection_threads AS thread
        WHERE thread.deleted_at IS NULL AND thread.archived_at IS NULL
          AND json_extract(thread.payload_json, '$.tempoTitleNeedsRefinement') = 1
          AND json_extract(thread.payload_json, '$.titleRegeneration') IS NULL
          AND (
            SELECT count(*) FROM orchestration_v2_projection_messages AS message
            WHERE message.thread_id = thread.thread_id
              AND message.role = 'assistant' AND message.streaming = 0
          ) >= CASE
            WHEN EXISTS (
              SELECT 1 FROM orchestration_v2_projection_runs AS run
              WHERE run.thread_id = thread.thread_id AND run.completed_at IS NULL
            ) THEN ${AGENT_MESSAGES_BEFORE_SECOND_TITLE}
            ELSE 1
          END
        ORDER BY thread.updated_at DESC
        LIMIT ${skip.size + BATCH}
      `;
      const due = rows
        .map((row) => row.threadId)
        .filter((threadId) => !skip.has(threadId))
        .slice(0, BATCH);
      if (due.length === 0) return;
      yield* Ref.update(tried, (current) => new Set([...current, ...due]));
      yield* Effect.forEach(
        due,
        (threadId) =>
          threads
            .dispatch({
              type: "thread.metadata.update",
              commandId: CommandId.make(`tempo-title-refine:${threadId}`),
              threadId: ThreadId.make(threadId),
              regenerateTitle: true,
            })
            .pipe(
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Second thread title request failed", { threadId, cause }),
              ),
            ),
        { discard: true },
      );
    });

    yield* scheduler.register("tempo-thread-title-refinement", sweep());
  }),
);
