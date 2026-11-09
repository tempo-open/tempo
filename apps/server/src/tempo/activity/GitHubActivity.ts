/**
 * tempo: the GitHub account's commits and merged pull requests per local day (gitHubDays.ts). GitHub's
 * answers are kept per date in the state folder, and a read asks again only for dates not finished
 * when last read. A first read of months spends minutes of commit search, whose quota is 30
 * requests a minute, so a read that does not await the refresh answers with what is kept.
 */
import type { TempoActivityGitHubStatus } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import type * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../../config.ts";
import * as GitHubGraphQl from "../GitHubGraphQl.ts";
import { addDays, type Day, type LocalCalendar } from "./activityDays.ts";
import {
  gitHubDates,
  gitHubDayCounts,
  isFinished,
  type GitHubDayCounts,
  type GitHubDayFacts,
} from "./gitHubDays.ts";

const HOST = "github.com";
const CACHE_FILE_NAME = "activity-github-v1.json";
const WINDOW_DAYS = 7;
const SEARCH_PAGE = 100;
/** GitHub's search returns at most this many results for one query. */
const SEARCH_LIMIT = 1000;
/** A quota pause longer than this ends the refresh; the next read goes on from there. */
const MAX_QUOTA_WAIT_MS = 2 * 60_000;
/** Dates read this recently are not read again, so the two calls of one load ask GitHub once. */
const REREAD_AFTER_MS = 60_000;
const SIGNED_OUT: ReadonlySet<GitHubRequestPolicy.GitHubApiError["_tag"]> = new Set([
  "GitHubCliMissingError",
  "GitHubNotSignedInError",
  "GitHubHostDisabledError",
]);

const DayFacts = Schema.Struct({
  contributions: Schema.Record(Schema.String, Schema.Number),
  commits: Schema.Array(Schema.Tuple([Schema.String, Schema.String])),
  merged: Schema.Array(Schema.String),
  readAtMs: Schema.Number,
});
const CacheFile = Schema.fromJsonString(
  Schema.Struct({ login: Schema.String, days: Schema.Record(Schema.String, DayFacts) }),
);
const decodeCacheFile = Schema.decodeUnknownOption(CacheFile);
const encodeCacheFile = Schema.encodeEffect(CacheFile);

const decodeViewer = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ data: Schema.Struct({ viewer: Schema.Struct({ login: Schema.String }) }) }),
  ),
);

const CONTRIBUTIONS_QUERY = `query TempoActivityContributions($from: DateTime!, $to: DateTime!) {
  viewer {
    contributionsCollection(from: $from, to: $to) {
      totalCommitContributions
      commitContributionsByRepository(maxRepositories: 100) {
        repository { nameWithOwner }
        contributions(first: 100) { nodes { occurredAt commitCount } }
      }
    }
  }
}`;
const decodeContributions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        viewer: Schema.Struct({
          contributionsCollection: Schema.Struct({
            totalCommitContributions: Schema.Number,
            commitContributionsByRepository: Schema.Array(
              Schema.Struct({
                repository: Schema.Struct({ nameWithOwner: Schema.String }),
                contributions: Schema.Struct({
                  nodes: Schema.Array(
                    Schema.Struct({ occurredAt: Schema.String, commitCount: Schema.Number }),
                  ),
                }),
              }),
            ),
          }),
        }),
      }),
    }),
  ),
);

const MERGED_QUERY = `query TempoActivityMergedPullRequests($query: String!, $after: String) {
  search(query: $query, type: ISSUE, first: 100, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { mergedAt } }
  }
}`;
const MergedPage = Schema.Struct({
  data: Schema.Struct({
    search: Schema.Struct({
      pageInfo: Schema.Struct({
        hasNextPage: Schema.Boolean,
        endCursor: Schema.NullOr(Schema.String),
      }),
      nodes: Schema.Array(
        Schema.Struct({ mergedAt: Schema.optional(Schema.NullOr(Schema.String)) }),
      ),
    }),
  }),
});
const decodeMerged = Schema.decodeUnknownEffect(Schema.fromJsonString(MergedPage));

const decodeCommitSearch = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      total_count: Schema.Number,
      incomplete_results: Schema.Boolean,
      items: Schema.Array(
        Schema.Struct({
          sha: Schema.String,
          repository: Schema.Struct({ full_name: Schema.String }),
          commit: Schema.Struct({ author: Schema.Struct({ date: Schema.String }) }),
        }),
      ),
    }),
  ),
);

export class GitHubActivityReadError extends Schema.TaggedError<GitHubActivityReadError>()(
  "GitHubActivityReadError",
  {
    stage: Schema.Literals(["viewer", "contributions", "commits", "mergedPullRequests"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not read the GitHub account's ${this.stage}.`;
  }
}

export class GitHubActivity extends Context.Service<
  GitHubActivity,
  {
    /** Counts for each local day from `first` through `last` whose dates GitHub answered. */
    readonly read: (input: {
      readonly calendar: LocalCalendar;
      readonly first: Day;
      readonly last: Day;
      readonly awaitRefresh: boolean;
    }) => Effect.Effect<{
      readonly status: TempoActivityGitHubStatus;
      readonly days: ReadonlyMap<Day, GitHubDayCounts>;
    }>;
  }
>()("t3/tempo/activity/GitHubActivity") {}

interface Refresh {
  readonly dates: ReadonlySet<Day>;
  readonly done: Deferred.Deferred<void, GitHubActivityReadError>;
}

/** Runs of consecutive dates, at most `WINDOW_DAYS` long. */
function windows(dates: ReadonlyArray<Day>): Array<Array<Day>> {
  const runs: Array<Array<Day>> = [];
  for (const date of dates) {
    const run = runs.at(-1);
    const last = run?.at(-1);
    if (
      run !== undefined &&
      last !== undefined &&
      addDays(last, 1) === date &&
      run.length < WINDOW_DAYS
    ) {
      run.push(date);
    } else {
      runs.push([date]);
    }
  }
  return runs;
}

const isoSeconds = (ms: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(ms)).replace(/\.\d{3}Z$/, "Z");
const utcDay = (at: string | number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(at));

const make = Effect.gen(function* () {
  const rest = yield* GitHubRest.GitHubRest;
  const graphQl = yield* GitHubGraphQl.GitHubGraphQl;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const cachePath = path.join(stateDir, CACHE_FILE_NAME);

  let login: string | null = null;
  const facts = new Map<Day, GitHubDayFacts>();
  /** The last refresh started. */
  let refresh: Refresh | null = null;
  /** Whether the last read that asked found a credential. */
  let signedIn = false;

  const loaded = yield* Effect.cached(
    fileSystem.readFileString(cachePath).pipe(
      Effect.map((raw) =>
        Option.map(decodeCacheFile(raw), (file) => {
          login = file.login;
          for (const [day, dayFacts] of Object.entries(file.days)) facts.set(day, dayFacts);
        }),
      ),
      Effect.ignore,
    ),
  );

  const persist = Effect.suspend(() =>
    login === null
      ? Effect.void
      : encodeCacheFile({ login, days: Object.fromEntries(facts) }).pipe(
          Effect.flatMap((contents) =>
            writeFileStringAtomically({ filePath: cachePath, contents }),
          ),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.catchCause((cause) =>
            Effect.logWarning("could not keep the GitHub activity", { cause }),
          ),
        ),
  );

  /** Sends `request`, waiting out a quota pause that ends soon. */
  const waitingOutQuota = <A>(
    request: Effect.Effect<A, GitHubRequestPolicy.GitHubApiError>,
  ): Effect.Effect<A, GitHubRequestPolicy.GitHubApiError> =>
    request.pipe(
      Effect.catchTags({
        SourceControlRateLimitPausedError: (error) =>
          afterQuotaPause(request, error, error.retryAt),
        GitHubApiRateLimitError: (error) => afterQuotaPause(request, error, error.retryAt),
      }),
    );
  const afterQuotaPause = Effect.fn("GitHubActivity.afterQuotaPause")(function* <A>(
    request: Effect.Effect<A, GitHubRequestPolicy.GitHubApiError>,
    error: GitHubRequestPolicy.GitHubApiError,
    retryAt: number | undefined,
  ) {
    const waitMs = (retryAt ?? Number.POSITIVE_INFINITY) - (yield* Clock.currentTimeMillis);
    if (waitMs > MAX_QUOTA_WAIT_MS) return yield* error;
    yield* Effect.sleep(Math.max(0, waitMs) + 1_000);
    return yield* waitingOutQuota(request);
  });

  const graphql = (operation: string, query: string, variables: Record<string, unknown>) =>
    waitingOutQuota(graphQl.graphql({ host: HOST, operation, query, variables }));

  const readViewer = graphql(
    "tempoActivityViewer",
    "query TempoActivityViewer { viewer { login } }",
    {},
  ).pipe(
    Effect.flatMap(decodeViewer),
    Effect.map(({ data }) => data.viewer.login),
    Effect.mapError((cause) => new GitHubActivityReadError({ stage: "viewer", cause })),
  );

  /** Contributions by date and repository. A window over the repository limit is read in halves. */
  const readContributions: (
    dates: ReadonlyArray<Day>,
  ) => Effect.Effect<Map<Day, Record<string, number>>, GitHubActivityReadError> = Effect.fn(
    "GitHubActivity.readContributions",
  )(function* (dates) {
    const { data } = yield* graphql("tempoActivityContributions", CONTRIBUTIONS_QUERY, {
      from: `${dates[0]}T00:00:00Z`,
      to: `${dates.at(-1)}T23:59:59Z`,
    }).pipe(
      Effect.flatMap(decodeContributions),
      Effect.mapError((cause) => new GitHubActivityReadError({ stage: "contributions", cause })),
    );
    const collection = data.viewer.contributionsCollection;
    const byDate = new Map<Day, Record<string, number>>();
    let counted = 0;
    for (const { repository, contributions } of collection.commitContributionsByRepository) {
      for (const { occurredAt, commitCount } of contributions.nodes) {
        // GitHub sends a date as its midnight in a zone of its own (Pacific, measured); noon UTC
        // later falls on that date for every zone from UTC-11 to UTC+12.
        const date = utcDay(Date.parse(occurredAt) + 12 * 60 * 60_000);
        const repositories = byDate.get(date) ?? {};
        repositories[repository.nameWithOwner] =
          (repositories[repository.nameWithOwner] ?? 0) + commitCount;
        byDate.set(date, repositories);
        counted += commitCount;
      }
    }
    if (counted === collection.totalCommitContributions) return byDate;
    if (dates.length === 1) {
      return yield* new GitHubActivityReadError({ stage: "contributions" });
    }
    const half = Math.ceil(dates.length / 2);
    const [early, late] = yield* Effect.all([
      readContributions(dates.slice(0, half)),
      readContributions(dates.slice(half)),
    ]);
    return new Map([...early, ...late]);
  });

  /**
   * The account's commits authored from `fromMs` through `toMs` (whole seconds). Search pages
   * stop at 1000 results, can skip results that tie in order, and can come back incomplete when
   * GitHub's search times out (measured), so such a span is read in halves.
   */
  const searchCommits: (
    author: string,
    fromMs: number,
    toMs: number,
  ) => Effect.Effect<Array<readonly [string, string]>, GitHubActivityReadError> = Effect.fn(
    "GitHubActivity.searchCommits",
  )(function* (author, fromMs, toMs) {
    const found = new Map<string, readonly [string, string]>();
    let total = 0;
    let incomplete = false;
    for (let page = 1; page <= SEARCH_LIMIT / SEARCH_PAGE; page++) {
      const query = new URLSearchParams({
        q: `author:${author} author-date:${isoSeconds(fromMs)}..${isoSeconds(toMs)}`,
        sort: "author-date",
        order: "asc",
        per_page: String(SEARCH_PAGE),
        page: String(page),
      });
      const answer = yield* waitingOutQuota(
        rest.rest({
          host: HOST,
          operation: "tempoActivitySearchCommits",
          path: `search/commits?${query}`,
          resource: "search",
        }),
      ).pipe(
        Effect.flatMap(({ body }) => decodeCommitSearch(body)),
        Effect.mapError((cause) => new GitHubActivityReadError({ stage: "commits", cause })),
      );
      if (answer.incomplete_results) {
        incomplete = true;
        break;
      }
      total = answer.total_count;
      if (total > SEARCH_LIMIT) break;
      for (const item of answer.items) {
        found.set(`${item.repository.full_name} ${item.sha}`, [
          item.repository.full_name,
          item.commit.author.date,
        ]);
      }
      if (answer.items.length < SEARCH_PAGE || page * SEARCH_PAGE >= total) break;
    }
    const shortest = toMs - fromMs < 2_000;
    if (incomplete && shortest) return yield* new GitHubActivityReadError({ stage: "commits" });
    if (!incomplete && (found.size >= total || shortest)) return [...found.values()];
    const middleMs = fromMs + Math.floor((toMs - fromMs) / 2_000) * 1_000;
    const [early, late] = yield* Effect.all([
      searchCommits(author, fromMs, middleMs),
      searchCommits(author, middleMs + 1_000, toMs),
    ]);
    return [...early, ...late];
  });

  const searchMerged = Effect.fn("GitHubActivity.searchMerged")(
    function* (author: string, dates: ReadonlyArray<Day>) {
      const merged: Array<string> = [];
      let after: string | null = null;
      do {
        const page: typeof MergedPage.Type = yield* graphql(
          "tempoActivityMergedPullRequests",
          MERGED_QUERY,
          {
            query: `is:pr author:${author} is:merged merged:${dates[0]}T00:00:00Z..${dates.at(-1)}T23:59:59Z`,
            after,
          },
        ).pipe(Effect.flatMap(decodeMerged));
        const { nodes, pageInfo } = page.data.search;
        for (const node of nodes) if (node.mergedAt) merged.push(node.mergedAt);
        after = pageInfo.hasNextPage ? pageInfo.endCursor : null;
      } while (after !== null);
      return merged;
    },
    Effect.mapError((cause) => new GitHubActivityReadError({ stage: "mergedPullRequests", cause })),
  );

  const stale = (date: Day, nowMs: number) => {
    const known = facts.get(date);
    return (
      !isFinished(date, known) && (known === undefined || nowMs - known.readAtMs >= REREAD_AFTER_MS)
    );
  };

  const refreshDates = Effect.fn("GitHubActivity.refresh")(function* (dates: ReadonlyArray<Day>) {
    const viewer = yield* readViewer;
    if (viewer !== login) {
      facts.clear();
      login = viewer;
    }
    const startedMs = yield* Clock.currentTimeMillis;
    for (const window of windows(dates.filter((date) => stale(date, startedMs)))) {
      const readAtMs = yield* Clock.currentTimeMillis;
      const fromMs = Date.parse(`${window[0]}T00:00:00Z`);
      const toMs = Date.parse(`${window.at(-1)}T23:59:59Z`);
      const contributions = yield* readContributions(window);
      const commits = yield* searchCommits(viewer, fromMs, toMs);
      const merged = yield* searchMerged(viewer, window);
      for (const date of window) {
        facts.set(date, {
          contributions: contributions.get(date) ?? {},
          commits: commits.filter(([, authoredAt]) => utcDay(authoredAt) === date),
          merged: merged.filter((mergedAt) => utcDay(mergedAt) === date),
          readAtMs,
        });
      }
    }
  }, Effect.ensuring(persist));

  /**
   * The refresh that reads `dates`: the last one started when it covers them, else a new one after
   * it that covers its dates too. A refresh outlives the read that started it.
   */
  const refreshing = Effect.fn("GitHubActivity.refreshing")(function* (dates: ReadonlyArray<Day>) {
    const previous = refresh;
    if (previous !== null && dates.every((date) => previous.dates.has(date))) return previous.done;
    const covered = new Set([...(previous?.dates ?? []), ...dates]);
    const done = Deferred.makeUnsafe<void, GitHubActivityReadError>();
    refresh = { dates: covered, done };
    yield* (previous === null ? Effect.void : Effect.ignore(Deferred.await(previous.done))).pipe(
      Effect.andThen(refreshDates([...covered].toSorted())),
      Effect.tapError((error) => Effect.logWarning("could not read GitHub activity", { error })),
      Effect.onExit((exit) =>
        Effect.sync(() => {
          if (refresh?.done === done) refresh = null;
        }).pipe(Effect.andThen(Deferred.done(done, exit))),
      ),
      Effect.forkDetach,
    );
    return done;
  }, Effect.uninterruptible);

  const read: GitHubActivity["Service"]["read"] = Effect.fn("GitHubActivity.read")(function* ({
    calendar,
    first,
    last,
    awaitRefresh,
  }) {
    yield* loaded;
    const dates = gitHubDates(first, last);
    const nowMs = yield* Clock.currentTimeMillis;
    const anyStale = dates.some((date) => stale(date, nowMs));
    // The refresh asks for the credential itself, which can mean running gh.
    if (anyStale && !awaitRefresh && signedIn) {
      yield* refreshing(dates);
      return { status: "refreshing", days: gitHubDayCounts(facts, calendar, first, last) } as const;
    }
    const credential = yield* Effect.result(rest.credential(HOST));
    signedIn = Result.isSuccess(credential);
    if (Result.isFailure(credential)) {
      const signedOut = SIGNED_OUT.has(credential.failure._tag);
      return {
        status: signedOut ? "signedOut" : "failed",
        days: signedOut ? new Map() : gitHubDayCounts(facts, calendar, first, last),
      } as const;
    }
    let status: TempoActivityGitHubStatus = "ready";
    if (anyStale) {
      const running = yield* refreshing(dates);
      if (awaitRefresh) {
        const done = yield* Effect.exit(Deferred.await(running));
        status = Exit.isSuccess(done) ? "ready" : "failed";
      } else {
        status = "refreshing";
      }
    }
    return { status, days: gitHubDayCounts(facts, calendar, first, last) };
  });

  return GitHubActivity.of({ read });
});

export const layer = Layer.effect(GitHubActivity, make);
