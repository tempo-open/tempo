/**
 * tempo: gives a logo to every thread the title model has not chosen one for: threads from before
 * logos were chosen, and threads imported from the Claude and Codex apps, which keep the titles
 * those apps gave them. Newest first, one title-model call each; titles stay as they are.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";

/** Threads per run; the scheduler starts the next run on its next tick, 5 seconds later. */
const BATCH = 12;
const CONCURRENCY = 3;

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const titles = yield* ThreadTitleRegenerationService.ThreadTitleRegenerationService;
    const scheduler = yield* Scheduler.Scheduler;
    const sql = yield* SqlClient.SqlClient;
    // Each thread gets one try per server start, so one that fails or gets no answer cannot loop.
    const tried = yield* Ref.make<ReadonlySet<string>>(new Set());

    const sweep = Effect.fnUntraced(function* () {
      const skip = yield* Ref.get(tried);
      // A thread whose title is being written gets its logo from that call. New threads wait
      // two minutes so their first title gets there first. Subagent rows draw no thread icon.
      const rows = yield* sql<{ readonly threadId: string }>`
        SELECT thread_id AS "threadId" FROM orchestration_v2_projection_threads
        WHERE deleted_at IS NULL AND archived_at IS NULL
          AND (
            json_type(payload_json, '$.tempoLogo') IS NULL
            -- Threads left with no logo before fallback icons existed get one more look.
            -- chooseLogo marks each look with a tempo-logo:3: command, so it happens once.
            OR (
              json_type(payload_json, '$.tempoLogo') = 'null'
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_command_receipts
                WHERE command_id = 'tempo-logo:3:' || thread_id
              )
            )
          )
          AND json_extract(payload_json, '$.titleRegeneration') IS NULL
          AND json_extract(payload_json, '$.movedTo') IS NULL
          AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL
          AND julianday(created_at) < julianday('now', '-2 minutes')
        ORDER BY updated_at DESC
        LIMIT ${skip.size + BATCH}
      `;
      const due = rows
        .map((row) => row.threadId)
        .filter((threadId) => !skip.has(threadId))
        .slice(0, BATCH);
      if (due.length === 0) return;
      yield* Ref.update(tried, (current) => new Set([...current, ...due]));
      yield* Effect.forEach(due, (threadId) => titles.chooseLogo(ThreadId.make(threadId)), {
        concurrency: CONCURRENCY,
        discard: true,
      });
    });

    yield* scheduler.register("tempo-thread-logos", sweep());
  }),
);
