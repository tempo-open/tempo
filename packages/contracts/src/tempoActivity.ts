/**
 * tempo: what happened on each local day since the environment's first thread: threads and agents
 * started, time agents worked, output tokens, and commits and merged pull requests on GitHub.
 * Clients derive every total, average, best day and streak from the days.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { UsageDay, UsageProviderKind } from "./usage.ts";

export const TempoActivityInput = Schema.Struct({
  /** IANA zone whose midnights end the days; a fixed offset would be wrong across DST. */
  timeZone: TrimmedNonEmptyString,
  /** Wait for GitHub days still being read instead of answering with the stored ones. */
  awaitRefresh: Schema.optional(Schema.Boolean),
});
export type TempoActivityInput = typeof TempoActivityInput.Type;

/** A null measure was not recorded that day, which is not the same as none. */
export const TempoActivityDay = Schema.Struct({
  day: UsageDay,
  /** Top level threads created, Claude Code sessions imported into Tempo included. */
  threads: NonNegativeInt,
  /** Agent threads started; null before Tempo ran its first turn and began recording them. */
  agents: Schema.NullOr(NonNegativeInt),
  /** Time during which at least one agent turn ran. */
  workedMs: NonNegativeInt,
  /** Null before the usage history begins or when usage could not be read. */
  outputTokens: Schema.NullOr(NonNegativeInt),
  /**
   * GitHub commit contributions, on the day each commit was authored. A commit that reaches a
   * default branch more than a week after that day is not counted.
   */
  commits: Schema.NullOr(NonNegativeInt),
  /** Pull requests the GitHub account opened that were merged that day. */
  mergedPullRequests: Schema.NullOr(NonNegativeInt),
});
export type TempoActivityDay = typeof TempoActivityDay.Type;

export const TempoActivityModelTokens = Schema.Struct({
  provider: UsageProviderKind,
  model: TrimmedNonEmptyString,
  outputTokens: NonNegativeInt,
});
export type TempoActivityModelTokens = typeof TempoActivityModelTokens.Type;

/**
 * `refreshing`: some days are still being read, and a call with `awaitRefresh` returns them.
 * `signedOut`: this environment has no GitHub credential. `failed`: GitHub could not be read.
 */
export const TempoActivityGitHubStatus = Schema.Literals([
  "ready",
  "refreshing",
  "signedOut",
  "failed",
]);
export type TempoActivityGitHubStatus = typeof TempoActivityGitHubStatus.Type;

export const TempoActivity = Schema.Struct({
  readAt: IsoDateTime,
  timeZone: TrimmedNonEmptyString,
  /** Every day from the first thread's through today, oldest first. */
  days: Schema.Array(TempoActivityDay),
  /** Output tokens over the days that have them, largest first. */
  outputTokensByModel: Schema.Array(TempoActivityModelTokens),
  github: TempoActivityGitHubStatus,
});
export type TempoActivity = typeof TempoActivity.Type;

export class TempoActivityError extends Schema.TaggedError<TempoActivityError>()(
  "TempoActivityError",
  {
    reason: Schema.Literals(["invalidTimeZone", "readFailed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "invalidTimeZone"
      ? "The time zone is not an IANA time zone."
      : "Could not read this environment's activity.";
  }
}

export const TEMPO_ACTIVITY_WS_METHODS = {
  read: "tempo.activity.read",
} as const;

export const TempoActivityReadRpc = Rpc.make(TEMPO_ACTIVITY_WS_METHODS.read, {
  payload: TempoActivityInput,
  success: TempoActivity,
  error: Schema.Union([TempoActivityError, EnvironmentAuthorizationError]),
});
