/** tempo: what the home's Pull requests widget and status bar show. */
import {
  pullRequestEntryKey,
  pullRequestEntryViewer,
  type EnvironmentPullRequestEntry,
  type MergedPullRequestList,
} from "~/components/pullRequest/pullRequestList.logic";

export interface HomePullRequest {
  readonly key: string;
  readonly state: "open" | "merged";
  readonly title: string;
  readonly url: string;
  /** The author's first name, when someone else opened it. */
  readonly author: string | null;
  /** When an open one was opened; for a merged one its last change, normally the merge. */
  readonly at: string;
}

export type HomePullRequests =
  | { readonly kind: "loading" }
  | { readonly kind: "missing"; readonly reason: string }
  | {
      readonly kind: "ready";
      /** With a "+" when some open ones were not read. */
      readonly openCount: string;
      /** Empty when the newest merged ones were not asked for. */
      readonly rows: readonly HomePullRequest[];
    };

function row(list: MergedPullRequestList, entry: EnvironmentPullRequestEntry): HomePullRequest {
  const viewer = pullRequestEntryViewer(entry, list.viewers);
  const author = entry.author;
  const someoneElse = author !== null && author.login.toLowerCase() !== viewer;
  return {
    key: pullRequestEntryKey(entry),
    state: entry.state === "merged" ? "merged" : "open",
    title: entry.title,
    url: entry.url,
    author: someoneElse ? author.name?.trim().split(/\s+/)[0] || author.login : null,
    at: entry.state === "merged" ? entry.updatedAt : entry.createdAt,
  };
}

/** The newest open and merged pull requests, newest first. */
export function newestPullRequests(
  open: MergedPullRequestList,
  merged: MergedPullRequestList,
  count: number,
): readonly HomePullRequest[] {
  return [
    ...open.entries.filter((entry) => entry.state === "open").map((entry) => row(open, entry)),
    ...merged.entries
      .filter((entry) => entry.state === "merged")
      .map((entry) => row(merged, entry)),
  ]
    .toSorted((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, count);
}

/**
 * The open count and, when `merged` was read, the newest rows. A repository GitHub could not read
 * comes back as an error beside the others' entries, so the count is then a lower bound.
 */
export function homePullRequests(
  open: MergedPullRequestList,
  merged: MergedPullRequestList | null,
  rows: number,
): HomePullRequests {
  const [host] = open.providers;
  if (host && open.providers.every((provider) => !provider.configured)) {
    return { kind: "missing", reason: `Not signed in to ${host.host}` };
  }
  const reads = merged === null ? [open] : [open, merged];
  if (
    reads.some((read) => read.errors.length > 0) &&
    reads.every((read) => read.entries.length === 0)
  ) {
    return { kind: "missing", reason: "Could not read pull requests" };
  }
  const openCount = open.entries.filter((entry) => entry.state === "open").length;
  const partial = open.truncated || open.errors.length > 0;
  return {
    kind: "ready",
    openCount: `${openCount}${partial ? "+" : ""}`,
    rows: merged === null ? [] : newestPullRequests(open, merged, rows),
  };
}
