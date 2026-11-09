/**
 * tempo: GitHub's commits and merged pull requests per local day (GitHubActivity.ts reads them).
 * GitHub's contribution graph counts an account's commits per date, each on the date it was
 * authored in the offset it was written with. Commit search returns those commits with that
 * offset, so each counted commit moves to the local day it was authored.
 */
import { addDays, daysThrough, type Day, type LocalCalendar } from "./activityDays.ts";

/** What GitHub said about one date, kept so a later read asks again only for unfinished dates. */
export interface GitHubDayFacts {
  /** Commit contributions GitHub's graph puts on this date, by repository (`owner/name`). */
  readonly contributions: Readonly<Record<string, number>>;
  /** The account's default branch commits authored this UTC day: repository and author time. */
  readonly commits: ReadonlyArray<readonly [repository: string, authoredAt: string]>;
  /** Merge times of the account's pull requests merged this UTC day. */
  readonly merged: ReadonlyArray<string>;
  readonly readAtMs: number;
}

/**
 * A date is finished once it has ended in every time zone (at noon UTC the next day) and a week
 * more has passed: GitHub counts a commit when it reaches a default branch, often days later.
 */
export function isFinished(day: Day, facts: GitHubDayFacts | undefined): boolean {
  return facts !== undefined && facts.readAtMs >= Date.parse(`${addDays(day, 8)}T12:00:00Z`);
}

/** The dates GitHub is asked about for local days `first` through `last`, in any zone. */
export function gitHubDates(first: Day, last: Day): Array<Day> {
  return daysThrough(addDays(first, -2), addDays(last, 2));
}

/** Splits `total` across keys in proportion to `weights`, the largest remainders rounding up. */
function splitInProportion(total: number, weights: ReadonlyMap<Day, number>): Map<Day, number> {
  const sum = [...weights.values()].reduce((a, b) => a + b, 0);
  const shares = [...weights].map(([key, weight]) => {
    const exact = (total * weight) / sum;
    return { key, whole: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = total - shares.reduce((a, share) => a + share.whole, 0);
  for (const share of shares.toSorted(
    (a, b) => b.remainder - a.remainder || a.key.localeCompare(b.key),
  )) {
    if (left === 0) break;
    share.whole += 1;
    left -= 1;
  }
  return new Map(shares.map(({ key, whole }) => [key, whole]));
}

export interface GitHubDayCounts {
  readonly commits: number;
  readonly mergedPullRequests: number;
}

/**
 * Commits and merged pull requests on each local day from `first` through `last` whose dates
 * GitHub answered about. GitHub sometimes counts fewer commits for a repository and date than
 * search finds (an email it did not link then): if those fall on one local day, the count goes
 * there, otherwise it is split in proportion. A count search has no commits for stays on its date.
 */
export function gitHubDayCounts(
  facts: ReadonlyMap<Day, GitHubDayFacts>,
  calendar: LocalCalendar,
  first: Day,
  last: Day,
): Map<Day, GitHubDayCounts> {
  const commits = new Map<Day, number>();
  const merged = new Map<Day, number>();
  const add = (counts: Map<Day, number>, day: Day, n: number) =>
    counts.set(day, (counts.get(day) ?? 0) + n);

  const authored = new Map<string, Array<number>>();
  for (const { commits: dayCommits, merged: mergedAt } of facts.values()) {
    for (const [repository, authoredAt] of dayCommits) {
      // An ISO time keeps its own offset, so its date part is the date GitHub counts it on.
      const key = `${repository} ${authoredAt.slice(0, 10)}`;
      const times = authored.get(key) ?? [];
      times.push(Date.parse(authoredAt));
      authored.set(key, times);
    }
    for (const at of mergedAt) add(merged, calendar.dayOf(Date.parse(at)), 1);
  }
  for (const [date, { contributions }] of facts) {
    for (const [repository, counted] of Object.entries(contributions)) {
      const times = authored.get(`${repository} ${date}`) ?? [];
      if (times.length <= counted) {
        for (const ms of times) add(commits, calendar.dayOf(ms), 1);
        if (counted > times.length) add(commits, date, counted - times.length);
        continue;
      }
      const byDay = new Map<Day, number>();
      for (const ms of times) add(byDay, calendar.dayOf(ms), 1);
      for (const [day, n] of splitInProportion(counted, byDay)) add(commits, day, n);
    }
  }

  const answered = (day: Day) =>
    facts.has(addDays(day, -1)) && facts.has(day) && facts.has(addDays(day, 1));
  return new Map(
    daysThrough(first, last).flatMap((day) =>
      answered(day)
        ? [[day, { commits: commits.get(day) ?? 0, mergedPullRequests: merged.get(day) ?? 0 }]]
        : [],
    ),
  );
}
