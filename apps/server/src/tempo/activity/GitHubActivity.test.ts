import * as NodeServices from "@effect/platform-node/NodeServices";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import { assert, describe, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as GitHubGraphQl from "../GitHubGraphQl.ts";
import { localCalendar } from "./activityDays.ts";
import * as GitHubActivity from "./GitHubActivity.ts";
import { gitHubDayCounts, type GitHubDayFacts } from "./gitHubDays.ts";

const newYork = Option.getOrThrow(localCalendar("America/New_York"));

/** One GitHub account's commits, contributions and merges, answering as GitHub's APIs do. */
function fakeGitHub(
  options: {
    readonly firstViewerTakes?: Duration.Input;
    /** The first commit search times out, as GitHub's sometimes does. */
    readonly firstSearchIncomplete?: boolean;
  } = {},
) {
  const account = {
    contributions: new Map<string, Record<string, number>>(),
    commits: [] as Array<readonly [string, string]>,
    merged: [] as Array<string>,
  };
  const asked: Array<string> = [];
  let viewers = 0;
  let credentials = 0;
  let searches = 0;
  const range = (text: string, name: string) => {
    const [from = "", to = ""] =
      new RegExp(`${name}:(\\S+)\\.\\.(\\S+)`).exec(text)?.slice(1) ?? [];
    return (iso: string) =>
      Date.parse(iso) >= Date.parse(from) && Date.parse(iso) <= Date.parse(to);
  };
  const graphql = Layer.mock(GitHubGraphQl.GitHubGraphQl)({
    graphql: ({ operation, variables }) =>
      Effect.gen(function* () {
        if (operation === "tempoActivityViewer") {
          if (viewers++ === 0 && options.firstViewerTakes !== undefined) {
            yield* Effect.sleep(options.firstViewerTakes);
          }
          return JSON.stringify({ data: { viewer: { login: "octo" } } });
        }
        if (operation === "tempoActivityMergedPullRequests") {
          const inRange = range(String(variables.query), "merged");
          const nodes = account.merged.filter(inRange).map((mergedAt) => ({ mergedAt }));
          return JSON.stringify({
            data: { search: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } },
          });
        }
        const [from, to] = [String(variables.from).slice(0, 10), String(variables.to).slice(0, 10)];
        asked.push(`${from}..${to}`);
        const repositories = new Map<string, Array<{ occurredAt: string; commitCount: number }>>();
        let total = 0;
        for (const [date, counts] of account.contributions) {
          if (date < from || date > to) continue;
          for (const [repository, commitCount] of Object.entries(counts)) {
            repositories.set(repository, [
              ...(repositories.get(repository) ?? []),
              { occurredAt: `${date}T07:00:00Z`, commitCount },
            ]);
            total += commitCount;
          }
        }
        return JSON.stringify({
          data: {
            viewer: {
              contributionsCollection: {
                totalCommitContributions: total,
                commitContributionsByRepository: [...repositories].map(
                  ([nameWithOwner, nodes]) => ({
                    repository: { nameWithOwner },
                    contributions: { nodes },
                  }),
                ),
              },
            },
          },
        });
      }),
  });
  const rest = Layer.mock(GitHubRest.GitHubRest)({
    credential: () =>
      Effect.sync(() => {
        credentials += 1;
        return { token: Redacted.make("token"), fingerprint: "octo" };
      }),
    rest: ({ path }) =>
      Effect.sync(() => {
        const inRange = range(
          new URLSearchParams(path.split("?")[1]).get("q") ?? "",
          "author-date",
        );
        const items = account.commits
          .filter(([, authoredAt]) => inRange(authoredAt))
          .map(([full_name, date], index) => ({
            sha: `${full_name}-${index}-${date}`,
            repository: { full_name },
            commit: { author: { date } },
          }));
        const incomplete = searches++ === 0 && options.firstSearchIncomplete === true;
        const body = JSON.stringify({
          total_count: items.length,
          incomplete_results: incomplete,
          items: incomplete ? items.slice(1) : items,
        });
        return { status: 200, headers: {}, body, truncated: false, invalidUtf8: false };
      }),
  });
  return { account, asked, credentials: () => credentials, layer: Layer.merge(graphql, rest) };
}

const serviceIn = (baseDir: string, github: ReturnType<typeof fakeGitHub>) =>
  GitHubActivity.layer.pipe(
    Layer.provide(github.layer),
    Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)),
  );

const read = (first: string, last: string, awaitRefresh = true) =>
  Effect.flatMap(GitHubActivity.GitHubActivity, (activity) =>
    activity.read({ calendar: newYork, first, last, awaitRefresh }),
  );

it.layer(NodeServices.layer)("GitHubActivity", (it) => {
  it.effect("asks GitHub again only for dates not finished when last read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-activity-" });
      const github = fakeGitHub();
      // Written on Pacific time late on Oct 27: GitHub's Oct 27, New York's Oct 28.
      github.account.commits.push(["octo/app", "2026-10-27T22:30:00-07:00"]);
      github.account.contributions.set("2026-10-27", { "octo/app": 1 });
      github.account.commits.push(
        ["octo/app", "2026-11-05T10:00:00-05:00"],
        ["octo/app", "2026-11-05T11:00:00-05:00"],
      );
      github.account.contributions.set("2026-11-05", { "octo/app": 2 });
      github.account.merged.push("2026-11-06T03:00:00Z");
      yield* TestClock.setTime(Date.parse("2026-11-07T20:00:00Z"));

      const first = yield* read("2026-10-27", "2026-11-07").pipe(
        Effect.provide(serviceIn(baseDir, github)),
      );
      assert.equal(first.status, "ready");
      assert.deepEqual(github.asked, [
        "2026-10-25..2026-10-31",
        "2026-11-01..2026-11-07",
        "2026-11-08..2026-11-09",
      ]);
      assert.deepEqual(first.days.get("2026-10-27"), { commits: 0, mergedPullRequests: 0 });
      assert.deepEqual(first.days.get("2026-10-28"), { commits: 1, mergedPullRequests: 0 });
      assert.deepEqual(first.days.get("2026-11-04"), { commits: 0, mergedPullRequests: 0 });
      assert.deepEqual(first.days.get("2026-11-05"), { commits: 2, mergedPullRequests: 1 });

      // Two days on, a restarted server keeps the dates a week old when read and reads the rest
      // again, which finds a Nov 4 commit that reached the default branch late.
      github.asked.length = 0;
      github.account.contributions.set("2026-10-27", { "octo/app": 1, "octo/lib": 5 });
      github.account.commits.push(["octo/app", "2026-11-04T09:00:00-05:00"]);
      github.account.contributions.set("2026-11-04", { "octo/app": 1 });
      github.account.commits.push(["octo/app", "2026-11-08T09:00:00-05:00"]);
      github.account.contributions.set("2026-11-08", { "octo/app": 1 });
      yield* TestClock.adjust("2 days");
      const later = yield* read("2026-10-27", "2026-11-09").pipe(
        Effect.provide(serviceIn(baseDir, github)),
      );
      assert.equal(later.status, "ready");
      assert.deepEqual(github.asked, ["2026-10-31..2026-11-06", "2026-11-07..2026-11-11"]);
      assert.deepEqual(later.days.get("2026-10-27"), first.days.get("2026-10-27"));
      assert.deepEqual(later.days.get("2026-10-28"), first.days.get("2026-10-28"));
      assert.deepEqual(later.days.get("2026-11-04"), { commits: 1, mergedPullRequests: 0 });
      assert.deepEqual(later.days.get("2026-11-08"), { commits: 1, mergedPullRequests: 0 });
    }),
  );

  it.effect("answers with the kept dates at once and refreshes the rest behind the read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-activity-" });
      const github = fakeGitHub();
      github.account.commits.push(["octo/app", "2026-11-05T10:00:00-05:00"]);
      github.account.contributions.set("2026-11-05", { "octo/app": 1 });
      yield* TestClock.setTime(Date.parse("2026-11-07T20:00:00Z"));
      yield* Effect.gen(function* () {
        const quick = yield* read("2026-11-01", "2026-11-07", false);
        assert.equal(quick.status, "refreshing");
        assert.equal(quick.days.size, 0);
        const awaited = yield* read("2026-11-01", "2026-11-07");
        assert.equal(awaited.status, "ready");
        assert.deepEqual(awaited.days.get("2026-11-05"), { commits: 1, mergedPullRequests: 0 });
        assert.equal(github.asked.length, 2);

        // Once a read found the credential, the next quick read answers without asking for it.
        yield* TestClock.adjust("1 minute");
        const asks = github.credentials();
        const again = yield* read("2026-11-01", "2026-11-07", false);
        assert.equal(again.status, "refreshing");
        assert.deepEqual(again.days.get("2026-11-05"), { commits: 1, mergedPullRequests: 0 });
        assert.equal(github.credentials(), asks);
        assert.equal((yield* read("2026-11-01", "2026-11-07")).status, "ready");
      }).pipe(Effect.provide(serviceIn(baseDir, github)));
    }),
  );

  it.effect("reads a span again in halves when commit search comes back incomplete", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-activity-" });
      const github = fakeGitHub({ firstSearchIncomplete: true });
      github.account.commits.push(
        ["octo/app", "2026-11-02T10:00:00-05:00"],
        ["octo/app", "2026-11-04T10:00:00-05:00"],
      );
      github.account.contributions.set("2026-11-02", { "octo/app": 1 });
      github.account.contributions.set("2026-11-04", { "octo/app": 1 });
      yield* TestClock.setTime(Date.parse("2026-11-07T20:00:00Z"));
      const answer = yield* read("2026-11-01", "2026-11-07").pipe(
        Effect.provide(serviceIn(baseDir, github)),
      );
      assert.equal(answer.status, "ready");
      assert.deepEqual(answer.days.get("2026-11-02"), { commits: 1, mergedPullRequests: 0 });
      assert.deepEqual(answer.days.get("2026-11-04"), { commits: 1, mergedPullRequests: 0 });
    }),
  );

  it.effect("reads the dates a running refresh leaves out once it ends", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const baseDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-activity-" });
      const github = fakeGitHub({ firstViewerTakes: "1 second" });
      github.account.commits.push(["octo/app", "2026-11-10T10:00:00-05:00"]);
      github.account.contributions.set("2026-11-10", { "octo/app": 1 });
      yield* TestClock.setTime(Date.parse("2026-11-07T20:00:00Z"));
      yield* Effect.gen(function* () {
        const quick = yield* read("2026-11-01", "2026-11-07", false);
        assert.equal(quick.status, "refreshing");
        // A client whose today is later starts reading while the first refresh still runs.
        const later = yield* Effect.forkChild(read("2026-11-01", "2026-11-10"));
        yield* TestClock.adjust("1 second");
        const answer = yield* Fiber.join(later);
        assert.equal(answer.status, "ready");
        assert.deepEqual(answer.days.get("2026-11-10"), { commits: 1, mergedPullRequests: 0 });
        assert.deepEqual(github.asked, [
          "2026-10-30..2026-11-05",
          "2026-11-06..2026-11-09",
          "2026-11-10..2026-11-12",
        ]);
      }).pipe(Effect.provide(serviceIn(baseDir, github)));
    }),
  );
});

describe("gitHubDayCounts", () => {
  const facts = (
    contributions: Record<string, number>,
    commits: Array<readonly [string, string]>,
  ) => ({ contributions, commits, merged: [], readAtMs: 0 }) satisfies GitHubDayFacts;

  it("moves counted commits to their local days and splits a count GitHub kept lower", () => {
    const counts = gitHubDayCounts(
      new Map([
        ["2026-11-02", facts({}, [])],
        // GitHub counted 2 of the 4 commits on Nov 3: two of them fall on Nov 3 and two on Nov 4.
        [
          "2026-11-03",
          facts({ "octo/app": 2, "octo/gone": 3 }, [
            ["octo/app", "2026-11-03T10:00:00-05:00"],
            ["octo/app", "2026-11-03T11:00:00-05:00"],
            ["octo/app", "2026-11-03T22:00:00-08:00"],
            ["octo/app", "2026-11-03T23:00:00-08:00"],
          ]),
        ],
        ["2026-11-04", facts({}, [])],
        ["2026-11-05", facts({}, [])],
      ]),
      newYork,
      "2026-11-02",
      "2026-11-05",
    );
    assert.deepEqual(Object.fromEntries(counts), {
      // The 3 contributions with no commit left on the default branch stay on GitHub's date.
      "2026-11-03": { commits: 4, mergedPullRequests: 0 },
      "2026-11-04": { commits: 1, mergedPullRequests: 0 },
    });
  });
});
