/**
 * tempo: what happened on each local day (tempoActivity.ts), for the home Activity widget and the Usage
 * page. Threads, agents and worked time come from the projection tables, output tokens from the
 * usage scan (activityTokens.ts), and commits and merged pull requests from GitHub
 * (GitHubActivity.ts).
 */
import {
  TempoActivityError,
  UsageDay,
  type TempoActivity as TempoActivityValue,
  type TempoActivityInput,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as GitHubGraphQl from "../GitHubGraphQl.ts";
import {
  localActivityDays,
  localCalendar,
  type ImportedMessage,
  type LocalActivityRows,
} from "./activityDays.ts";
import * as ActivityTokens from "./activityTokens.ts";
import * as GitHubActivity from "./GitHubActivity.ts";

const RUNNING_TURN_STATUSES = new Set(["pending", "starting", "running", "waiting"]);

export class TempoActivity extends Context.Service<
  TempoActivity,
  {
    readonly read: (
      input: TempoActivityInput,
    ) => Effect.Effect<TempoActivityValue, TempoActivityError>;
  }
>()("t3/tempo/activity/TempoActivity") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const activityTokens = yield* ActivityTokens.make;
  const gitHub = yield* GitHubActivity.GitHubActivity;

  const readRows = Effect.gen(function* () {
    const threads = yield* sql<{
      readonly createdAt: string;
      readonly relationship: string | null;
    }>`
      SELECT created_at AS "createdAt",
        json_extract(payload_json, '$.lineage.relationshipToParent') AS relationship
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
    `;
    // Root turns are the nodes without a parent, which the parent index finds without a scan.
    const turns = yield* sql<{
      readonly startedAt: string;
      readonly completedAt: string | null;
      readonly status: string;
    }>`
      SELECT started_at AS "startedAt", completed_at AS "completedAt", status
      FROM orchestration_v2_projection_nodes
      WHERE parent_node_id IS NULL AND kind = 'root_turn' AND started_at IS NOT NULL
    `;
    // The unary plus keeps SQLite on the import threads' range instead of every item without a run.
    const messages = yield* sql<{
      readonly threadId: string;
      readonly ordinal: number;
      readonly type: "user_message" | "assistant_message";
      readonly at: string;
      readonly head: string | null;
    }>`
      SELECT thread_id AS "threadId", ordinal, type,
        json_extract(payload_json, '$.startedAt') AS at,
        substr(json_extract(payload_json, '$.text'), 1, 40) AS head
      FROM orchestration_v2_projection_turn_items
      WHERE thread_id >= 'import:' AND thread_id < 'import;' AND +run_id IS NULL
        AND type IN ('user_message', 'assistant_message')
    `;
    const sessions = new Map<string, Array<ImportedMessage>>();
    for (const message of messages) {
      const session = sessions.get(message.threadId) ?? [];
      session.push({
        ordinal: message.ordinal,
        role: message.type === "user_message" ? "user" : "assistant",
        atMs: Date.parse(message.at),
        head: message.head ?? "",
      });
      sessions.set(message.threadId, session);
    }
    return {
      threads: threads.flatMap(({ createdAt, relationship }) =>
        relationship === null || relationship === "subagent"
          ? [{ createdAtMs: Date.parse(createdAt), agent: relationship === "subagent" }]
          : [],
      ),
      recordedTurns: turns.map((turn) => ({
        startedAtMs: Date.parse(turn.startedAt),
        completedAtMs: turn.completedAt === null ? null : Date.parse(turn.completedAt),
        running: RUNNING_TURN_STATUSES.has(turn.status),
      })),
      importedSessions: [...sessions.values()],
    } satisfies LocalActivityRows;
  }).pipe(
    NodeSqliteClient.readOnly,
    Effect.mapError((cause) => new TempoActivityError({ reason: "readFailed", cause })),
  );

  const read = Effect.fn("TempoActivity.read")(function* (input: TempoActivityInput) {
    const calendar = yield* Effect.fromOption(localCalendar(input.timeZone)).pipe(
      Effect.mapError(() => new TempoActivityError({ reason: "invalidTimeZone" })),
    );
    const nowMs = yield* Clock.currentTimeMillis;
    const last = calendar.dayOf(nowMs);
    const readLocal = yield* Effect.cached(
      Effect.map(readRows, (rows) => localActivityDays(rows, calendar, nowMs)),
    );
    const first = Effect.map(readLocal, (days) => days[0]!.day);
    const [local, tokens, github] = yield* Effect.all(
      [
        readLocal,
        activityTokens.read(input.timeZone, last, first),
        Effect.flatMap(first, (first) =>
          gitHub.read({ calendar, first, last, awaitRefresh: input.awaitRefresh === true }),
        ),
      ],
      { concurrency: "unbounded" },
    );
    return {
      readAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      timeZone: input.timeZone,
      days: local.map(({ day, threads, agents, workedMs }) => {
        const counts = github.days.get(day);
        return {
          day: UsageDay.make(day),
          threads,
          agents,
          workedMs,
          outputTokens: Option.match(tokens, {
            onNone: () => null,
            onSome: ({ sinceDay, byDay }) => (day < sinceDay ? null : (byDay.get(day) ?? 0)),
          }),
          commits: counts?.commits ?? null,
          mergedPullRequests: counts?.mergedPullRequests ?? null,
        };
      }),
      outputTokensByModel: Option.match(tokens, {
        onNone: () => [],
        onSome: ({ byModel }) => byModel,
      }),
      github: github.status,
    } satisfies TempoActivityValue;
  });

  return TempoActivity.of({ read });
});

export const layer = Layer.effect(TempoActivity, make).pipe(
  Layer.provide(GitHubActivity.layer),
  Layer.provide(GitHubGraphQl.layer),
  Layer.provide(GitHubRest.layerWithDependencies),
);
