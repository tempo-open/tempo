import { useNowMinute } from "~/hooks/useNowMinute";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useOpenPrLink } from "~/lib/openPullRequestLink";
import { formatRelativeTime } from "~/timestampFormat";
import { useHomePullRequests } from "./useHomePullRequests";
import { Placeholder, WidgetFrame } from "./WidgetFrame";

// One placeholder title for each row the widget shows, of different lengths, so they read as rows.
const LOADING_TITLES = ["h-2 w-4/5", "h-2 w-3/5", "h-2 w-2/3", "h-2 w-1/2", "h-2 w-3/4"] as const;

/** The newest open and merged pull requests, one line each, newest first. */
export function PullRequestsWidget() {
  const pullRequests = useHomePullRequests(true);
  const openPrLink = useOpenPrLink();
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00.000Z`);
  return (
    <WidgetFrame
      widget="pullRequests"
      icon={<PullRequestGlyph.pullRequest />}
      title="Pull requests"
      aside={pullRequests.kind === "ready" ? `${pullRequests.openCount} open` : null}
    >
      {pullRequests.kind === "missing" ? (
        <p className="my-auto text-center text-tempo-label text-muted-foreground">
          {pullRequests.reason}
        </p>
      ) : pullRequests.kind === "ready" && pullRequests.rows.length === 0 ? (
        <p className="my-auto text-center text-tempo-label text-muted-foreground">
          No open or merged pull requests
        </p>
      ) : (
        <ul data-tempo-home-pull-requests="" className="flex flex-1 flex-col gap-0.5">
          {pullRequests.kind === "loading"
            ? LOADING_TITLES.map((title) => (
                <li key={title} className="flex h-7 items-center gap-2.5">
                  <Placeholder className="size-3.75" />
                  <Placeholder className={title} />
                </li>
              ))
            : pullRequests.rows.map((row) => {
                const Glyph =
                  row.state === "merged" ? PullRequestGlyph.merged : PullRequestGlyph.pullRequest;
                const age = formatRelativeTime(row.at, now)?.value;
                return (
                  <li key={row.key}>
                    <a
                      href={row.url}
                      onClick={(event) => openPrLink(event, row.url)}
                      data-state={row.state}
                      className="-mx-1.5 flex h-7 items-center gap-2.5 rounded-md px-1.5 text-tempo-label text-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <Glyph
                        aria-label={row.state === "merged" ? "Merged" : "Open"}
                        className="size-3.75 shrink-0"
                      />
                      <span data-tempo-home-title="" className="min-w-0 flex-1 whitespace-nowrap">
                        {row.title}
                      </span>
                      <span className="text-tempo-caption text-secondary-label tabular-nums">
                        {[row.author, age].filter(Boolean).join(" · ")}
                      </span>
                    </a>
                  </li>
                );
              })}
        </ul>
      )}
    </WidgetFrame>
  );
}
