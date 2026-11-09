/**
 * tempo: the tempo look's Usage tab: the total, one heat map
 * that switches between five measures, output tokens by model, every number, and the streaks.
 * Every number comes from the environment's activity (tempoActivity.ts).
 */
import type { TempoActivity, TempoActivityGitHubStatus } from "@t3tools/contracts";
import { formatModelSlugName } from "@t3tools/shared/model";
import { formatCount } from "@t3tools/shared/usageFormat";
import { useState } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { usePrimarySettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { formatDayAwareTimestamp, formatShortTimestamp } from "~/timestampFormat";
import { DayGrid } from "../activity/DayGrid";
import {
  formatAverage,
  formatDay,
  formatMeasure,
  formatMonth,
  formatOutputTokens,
} from "./activityFormat";
import {
  everyNumber,
  GITHUB_MEASURES,
  HEAT_MAP_MEASURES,
  heatMap,
  modelShares,
  previousMonth,
  streaks,
  summarizeMeasure,
  TABLE_MEASURES,
  type ActivityMeasure,
  type HeatCell,
  type HeatMapMeasure,
  type MeasureSummary,
  type TableRow,
} from "./activitySummary";
import { UsageCard, UsageHeadline } from "./UsageCard";

/** As many weeks as fit beside the totals in the 760 px page, at the mockup's 24 px cells. */
const HEAT_MAP_WEEKS = 21;
const NAMED_MODELS = 5;

const MEASURE_NAMES: Record<ActivityMeasure, { label: string; one: string; many: string }> = {
  threads: { label: "Threads", one: "thread", many: "threads" },
  agents: { label: "Agents", one: "agent", many: "agents" },
  commits: { label: "Commits", one: "commit", many: "commits" },
  hours: { label: "Hours worked", one: "hour", many: "hours" },
  tokens: { label: "Output tokens", one: "output token", many: "output tokens" },
  mergedPullRequests: {
    label: "Merged pull requests",
    one: "merged pull request",
    many: "merged pull requests",
  },
};

function quantity(measure: ActivityMeasure, value: number): string {
  const { one, many } = MEASURE_NAMES[measure];
  return `${formatMeasure(measure, value)} ${value === (measure === "hours" ? 10 : 1) ? one : many}`;
}

function headlineLabel(measure: HeatMapMeasure, since: string): string {
  switch (measure) {
    case "threads":
      return `threads since ${since}`;
    case "agents":
      return `agents since ${since}, when Tempo began recording them`;
    case "commits":
      return `commits since ${since}, on GitHub`;
    case "hours":
      return `hours with an agent working, since ${since}`;
    case "tokens":
      return `output tokens since ${since}, across every Claude and Codex account`;
  }
}

/** GitHub's days are still being read, so a number that needs one is on its way, not missing. */
function loading(measure: ActivityMeasure, github: TempoActivityGitHubStatus): boolean {
  return github === "refreshing" && GITHUB_MEASURES.has(measure);
}

function missingText(measure: ActivityMeasure, github: TempoActivityGitHubStatus): string {
  return loading(measure, github) ? "Loading…" : "Not counted";
}

function notCountedReason(measure: ActivityMeasure, github: TempoActivityGitHubStatus): string {
  const name = MEASURE_NAMES[measure].label;
  if (!GITHUB_MEASURES.has(measure)) return `${name} are not counted.`;
  if (github === "refreshing") return `Loading ${name.toLowerCase()} from GitHub…`;
  return github === "signedOut"
    ? `${name} are not counted: this environment is not signed in to GitHub.`
    : `${name} are not counted: GitHub could not be read.`;
}

export function UsageActivityTab({
  activity,
  error,
}: {
  readonly activity: TempoActivity | null;
  readonly error: string | null;
}) {
  const [measure, setMeasure] = useState<HeatMapMeasure>("threads");
  if (activity === null) {
    return error ? <p className="text-sm text-muted-foreground">{error}</p> : <ActivitySkeleton />;
  }
  if (activity.days.length === 0) {
    return <p className="text-sm text-muted-foreground">No threads yet.</p>;
  }
  const summary = summarizeMeasure(activity.days, measure);
  const cells = heatMap(activity.days, measure, HEAT_MAP_WEEKS);
  return (
    <>
      {summary.total === null || summary.since === null ? (
        <p className="mb-5.5 text-tempo-title text-muted-foreground">
          {notCountedReason(measure, activity.github)}
        </p>
      ) : (
        <UsageHeadline
          figure={formatMeasure(measure, summary.total)}
          label={headlineLabel(measure, formatDay(summary.since))}
        />
      )}
      <UsageCard
        label="Activity per day"
        title={
          <ToggleGroup
            aria-label="Measure"
            data-tempo-usage-segmented="compact"
            value={[measure]}
            onValueChange={(next) => {
              const value = HEAT_MAP_MEASURES.find((candidate) => candidate === next[0]);
              if (value) setMeasure(value);
            }}
          >
            {HEAT_MAP_MEASURES.map((option) => (
              <Toggle key={option} value={option}>
                {option === "tokens" ? "Tokens" : MEASURE_NAMES[option].label}
              </Toggle>
            ))}
          </ToggleGroup>
        }
        aside={
          summary.busiest
            ? `Busiest: ${formatDay(summary.busiest.day)}, ${quantity(measure, summary.busiest.value)}`
            : null
        }
      >
        <div className="flex items-stretch justify-between gap-5">
          <HeatMap cells={cells} measure={measure} github={activity.github} />
          <MeasureStats
            measure={measure}
            summary={summary}
            firstDay={activity.days[0]!.day}
            today={activity.days.at(-1)!.day}
            missing={missingText(measure, activity.github)}
          />
        </div>
      </UsageCard>
      <ModelsCard activity={activity} />
      <EveryNumberCard activity={activity} />
      <StreaksCard activity={activity} />
    </>
  );
}

function cellDetail(
  cell: HeatCell,
  measure: HeatMapMeasure,
  github: TempoActivityGitHubStatus,
): string {
  if (cell.value === null) return loading(measure, github) ? "Loading from GitHub" : "Not recorded";
  return cell.value === 0 ? `No ${MEASURE_NAMES[measure].many}` : quantity(measure, cell.value);
}

function HeatMap({
  cells,
  measure,
  github,
}: {
  readonly cells: readonly HeatCell[];
  readonly measure: HeatMapMeasure;
  readonly github: TempoActivityGitHubStatus;
}) {
  return (
    <DayGrid
      label={`${MEASURE_NAMES[measure].label} per day since ${cells[0] ? formatDay(cells[0].day) : ""}`}
      days={cells.map((cell) => ({ day: cell.day, detail: cellDetail(cell, measure, github) }))}
      className="grid grid-flow-col grid-rows-7 justify-start gap-1"
      renderCell={(index, props) => {
        const cell = cells[index]!;
        return (
          <i
            key={cell.day}
            {...props}
            data-tempo-heat-level={cell.level ?? "none"}
            data-busiest={cell.busiest ? "" : undefined}
            className={cn(props.className, "size-6 rounded-md")}
          />
        );
      }}
    />
  );
}

function Stat({
  value,
  missing,
  label,
  ownLine = false,
}: {
  readonly value: string | null;
  /** Shown in grey in place of a value that is not known. */
  readonly missing?: string;
  readonly label: string;
  /** The label on a line of its own, 2 px under the value, as Streaks draws it. */
  readonly ownLine?: boolean;
}) {
  return (
    <div>
      <b
        className={cn(
          "block text-2xl leading-[normal] font-tempo-figure tracking-tight tabular-nums",
          value === null ? "text-secondary-label" : "text-foreground",
        )}
      >
        {value ?? missing}
      </b>
      <span className={cn("text-tempo-caption text-secondary-label", ownLine && "mt-0.5 block")}>
        {label}
      </span>
    </div>
  );
}

function MeasureStats({
  measure,
  summary,
  firstDay,
  today,
  missing,
}: {
  readonly measure: HeatMapMeasure;
  readonly summary: MeasureSummary;
  readonly firstDay: string;
  readonly today: string;
  readonly missing: string;
}) {
  const amount = (value: number | null) => (value === null ? null : formatMeasure(measure, value));
  const thisMonth = {
    value: amount(summary.thisMonth),
    label: `in ${formatMonth(today)} so far`,
  };
  const average = {
    value: summary.dailyAverage === null ? null : formatAverage(measure, summary.dailyAverage),
    label: `a day since ${formatDay(summary.since ?? firstDay)}`,
  };
  // A measure first recorded this month has no last month to show.
  const stats =
    summary.since?.slice(0, 7) === today.slice(0, 7)
      ? [thisMonth, average, { value: formatCount(summary.recordedDays), label: "days recorded" }]
      : [
          { value: amount(summary.lastMonth), label: `in ${formatMonth(previousMonth(today))}` },
          thisMonth,
          average,
        ];
  return (
    <div className="flex min-w-30 flex-col justify-between">
      {stats.map((stat) => (
        <Stat key={stat.label} missing={missing} {...stat} />
      ))}
    </div>
  );
}

function ModelsCard({ activity }: { readonly activity: TempoActivity }) {
  const { rows, total } = modelShares(activity.outputTokensByModel, NAMED_MODELS);
  const largest = rows[0]?.outputTokens ?? 0;
  const since = activity.days.find((day) => day.outputTokens !== null)?.day;
  return (
    <UsageCard title="By model" aside={since ? `Output tokens since ${formatDay(since)}` : null}>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No output tokens recorded.</p>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map(({ model, outputTokens }) => (
            <div
              key={model ? `${model.provider}:${model.model}` : "other"}
              className="grid grid-cols-[110px_1fr_56px_52px] items-center gap-3.5 text-sm leading-[normal]"
            >
              <span className="truncate text-foreground">
                {model ? formatModelSlugName(model.model).replace(/^Claude /, "") : "Other models"}
              </span>
              <span className="h-2 overflow-hidden rounded-sm bg-tempo-seg-off">
                <span
                  className="block h-full min-w-0.5 rounded-sm bg-tempo-accent"
                  style={{ width: `${(outputTokens / largest) * 100}%` }}
                />
              </span>
              <span className="text-right font-medium text-foreground tabular-nums">
                {formatOutputTokens(outputTokens)}
              </span>
              <span className="text-right text-tempo-note text-secondary-label tabular-nums">
                {formatShare(outputTokens / total)}
              </span>
            </div>
          ))}
        </div>
      )}
    </UsageCard>
  );
}

const SHARE = new Intl.NumberFormat("en-US", {
  style: "percent",
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

function formatShare(share: number): string {
  return SHARE.format(share);
}

function rowLabel(row: TableRow): string {
  switch (row.key) {
    case "today":
      return "Today";
    case "last7":
      return "Last 7 days";
    case "weekBefore":
      return "Week before";
    case "lastMonth":
      return formatMonth(row.period ?? "");
    case "since":
      return `Since ${formatDay(row.period ?? "")}`;
    case "average":
      return "Daily average";
    case "best":
      return "Best day";
    case "count":
      return "Days active";
  }
}

function cellText(row: TableRow, measure: ActivityMeasure, value: number): string {
  if (row.key === "average") return formatAverage(measure, value);
  if (row.key === "count") return formatCount(value);
  return formatMeasure(measure, value);
}

function EveryNumberCard({ activity }: { readonly activity: TempoActivity }) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const rows = everyNumber(activity.days);
  const first = activity.days[0]!.day;
  const time = formatShortTimestamp(activity.readAt, timestampFormat);
  const stamp = formatDayAwareTimestamp(activity.readAt, timestampFormat);
  return (
    <UsageCard
      title="Every number"
      aside={`Since ${formatDay(first)}, measured ${stamp === time ? `today at ${time}` : stamp}`}
    >
      <table className="w-full border-collapse text-tempo-label leading-4.5 tabular-nums">
        <thead>
          <tr className="text-tempo-caption text-secondary-label">
            <th className="w-27 pb-1.75" />
            {TABLE_MEASURES.map((measure) => (
              <th key={measure} className="pb-1.75 text-right font-tempo-book whitespace-nowrap">
                {MEASURE_NAMES[measure].label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="group/row border-t border-border">
              <th className="py-1.75 text-left font-tempo-book whitespace-nowrap text-muted-foreground group-last/row:pb-0">
                {rowLabel(row)}
              </th>
              {TABLE_MEASURES.map((measure) => {
                const cell = row.cells[measure];
                return cell === null ? (
                  <td
                    key={measure}
                    className="py-1.75 text-right text-tempo-caption whitespace-nowrap text-secondary-label group-last/row:pb-0"
                  >
                    {missingText(measure, activity.github)}
                  </td>
                ) : (
                  <td
                    key={measure}
                    className="py-1.75 text-right whitespace-nowrap group-last/row:pb-0"
                  >
                    <b className="font-tempo-number text-foreground">
                      {cellText(row, measure, cell.value)}
                    </b>
                    {cell.day ? (
                      <span className="ms-1.5 text-xs leading-4.5 text-secondary-label">
                        {formatDay(cell.day)}
                      </span>
                    ) : null}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </UsageCard>
  );
}

function StreaksCard({ activity }: { readonly activity: TempoActivity }) {
  const { commitDays, threadDays, longestWorked } = streaks(activity.days);
  return (
    <UsageCard title="Streaks" aside="Days in a row, up to today">
      <div className="grid grid-cols-3 gap-5">
        <Stat
          value={commitDays === null ? null : formatCount(commitDays)}
          missing={missingText("commits", activity.github)}
          label="days with a commit"
          ownLine
        />
        <Stat value={formatCount(threadDays)} label="days with a thread" ownLine />
        <Stat value={formatCount(longestWorked)} label="longest run of days worked" ownLine />
      </div>
    </UsageCard>
  );
}

function ActivitySkeleton() {
  return (
    <>
      <Skeleton className="mb-5.5 h-12 w-80" />
      <Skeleton className="mb-6.5 h-56" />
      <Skeleton className="mb-6.5 h-56" />
    </>
  );
}
