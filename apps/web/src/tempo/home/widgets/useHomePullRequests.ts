/** tempo: the pull requests the home's widget and status bar show, read as the Pull requests page reads them. */
import type { PullRequestListInput } from "@t3tools/contracts";

import {
  usePullRequestScope,
  type PullRequestsSearch,
} from "~/components/pullRequest/usePullRequestListView";
import { usePullRequestList } from "~/state/pullRequests";
import { homePullRequests, type HomePullRequests } from "./homePullRequests";

const ROWS = 5;

const EVERY_PROJECT: PullRequestsSearch = { involvement: "all", state: "open" };
// The Pull requests page's first page, so the home and the page share one read of what is open.
const OPEN_LIMIT = 99;

export function useHomePullRequests(withMerged: boolean): HomePullRequests {
  const { environmentQueries, capabilityKnown } = usePullRequestScope(EVERY_PROJECT);
  const targets = (state: "open" | "merged", limit: number) =>
    environmentQueries.map(({ environmentId, projectIds }) => ({
      environmentId,
      input: {
        state,
        involvement: "all",
        limit,
        ...(projectIds ? { projectIds } : {}),
      } satisfies PullRequestListInput,
    }));
  const open = usePullRequestList(targets("open", OPEN_LIMIT));
  const merged = usePullRequestList(withMerged ? targets("merged", ROWS) : []);

  if (!capabilityKnown) return { kind: "loading" };
  if (environmentQueries.length === 0) return { kind: "ready", openCount: "0", rows: [] };
  if (open.data === null || (withMerged && merged.data === null)) {
    return open.error === null && merged.error === null
      ? { kind: "loading" }
      : { kind: "missing", reason: "Could not read pull requests" };
  }
  return homePullRequests(open.data, merged.data, ROWS);
}
