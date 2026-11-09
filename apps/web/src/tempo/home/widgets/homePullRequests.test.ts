import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type {
  EnvironmentPullRequestEntry,
  MergedPullRequestList,
} from "~/components/pullRequest/pullRequestList.logic";
import { homePullRequests, newestPullRequests } from "./homePullRequests";

const ENVIRONMENT = EnvironmentId.make("env");

function entry(
  number: number,
  state: "open" | "merged",
  author: { login: string; name: string | null },
  createdAt: string,
  updatedAt: string,
): EnvironmentPullRequestEntry {
  return {
    environmentId: ENVIRONMENT,
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make("project"),
    projectTitle: "web-app",
    repository: "acme/web-app",
    number,
    title: `Pull request ${number}`,
    url: `https://github.com/acme/web-app/pull/${number}`,
    author: { ...author, avatarUrl: null },
    headBranch: `branch-${number}`,
    baseBranch: "main",
    state,
    isDraft: false,
    mergeability: "unknown",
    additions: 0,
    deletions: 0,
    createdAt,
    updatedAt,
    viewerReviewRequested: false,
    labels: [],
  };
}

function list(
  entries: readonly EnvironmentPullRequestEntry[],
  errors: MergedPullRequestList["errors"] = [],
): MergedPullRequestList {
  return {
    viewers: { [`${ENVIRONMENT} github.com`]: "octocat" },
    providers: [],
    entries,
    errors,
    truncated: false,
    nextCursors: {},
    truncatedEnvironments: [],
  };
}

// The server answers this way for a repository GitHub could not read.
const UNREADABLE = [
  {
    environmentId: ENVIRONMENT,
    projectId: ProjectId.make("other"),
    projectTitle: "api",
    message: "acme/api could not be read.",
  },
];

const ALEX = { login: "alex-dev", name: "Alex Kim" };
const ME = { login: "OctoCat", name: "Sam Lee" };

describe("newestPullRequests", () => {
  it("interleaves open and merged by when each opened or merged, naming only other authors", () => {
    const open = list([
      entry(4, "open", ME, "2026-11-06T20:00:00Z", "2026-11-07T22:00:00Z"),
      entry(
        5,
        "open",
        { login: "bot", name: null },
        "2026-11-07T21:00:00Z",
        "2026-11-07T21:00:00Z",
      ),
    ]);
    const merged = list([
      entry(1, "merged", ALEX, "2026-11-01T00:00:00Z", "2026-11-07T23:00:00Z"),
      entry(2, "merged", ME, "2026-11-02T00:00:00Z", "2026-11-07T19:00:00Z"),
    ]);
    expect(
      newestPullRequests(open, merged, 3).map(({ title, state, author }) => [title, state, author]),
    ).toEqual([
      ["Pull request 1", "merged", "Alex"],
      ["Pull request 5", "open", "bot"],
      ["Pull request 2", "merged", null],
    ]);
  });
});

describe("homePullRequests", () => {
  const open = entry(4, "open", ME, "2026-11-06T20:00:00Z", "2026-11-07T22:00:00Z");

  it("says so when no repository could be read, instead of counting none", () => {
    expect(homePullRequests(list([], UNREADABLE), list([], UNREADABLE), 5)).toEqual({
      kind: "missing",
      reason: "Could not read pull requests",
    });
    expect(homePullRequests(list([], UNREADABLE), null, 5)).toMatchObject({ kind: "missing" });
  });

  it("counts at least the open ones read when some repositories could not be read", () => {
    expect(homePullRequests(list([open], UNREADABLE), list([]), 5)).toMatchObject({
      kind: "ready",
      openCount: "1+",
    });
    expect(homePullRequests(list([open]), list([], UNREADABLE), 5)).toMatchObject({
      kind: "ready",
      openCount: "1",
    });
  });
});
