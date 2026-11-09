import type { TempoActivityGitHubStatus } from "@t3tools/contracts";
import { formatCount, formatTokens } from "@t3tools/shared/usageFormat";
import { ChartNoAxesColumnIcon } from "lucide-react";

import { useTempoActivity } from "~/tempo/activity/useTempoActivity";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { activityMissing, gitHubCount, monthTotals } from "./homeActivity";
import { Placeholder, WidgetFrame } from "./WidgetFrame";

function Stat(props: {
  /** Undefined while the days load; null when no day this month counted it. */
  readonly value: number | null | undefined;
  readonly format: (value: number) => string;
  readonly label: string;
  readonly missing?: string;
}) {
  if (props.value === null) {
    return <p className="text-tempo-caption text-secondary-label">{props.missing}</p>;
  }
  return (
    <p className="flex items-baseline gap-1.75">
      {props.value === undefined ? (
        <Placeholder className="h-5 w-8 self-center" />
      ) : (
        <b className="text-tempo-stat font-tempo-figure tracking-tight text-foreground tabular-nums">
          {props.format(props.value)}
        </b>
      )}
      <span className="text-tempo-caption whitespace-nowrap text-secondary-label">
        {props.label}
      </span>
    </p>
  );
}

function mergedMissing(github: TempoActivityGitHubStatus | undefined): string {
  return github === "signedOut" ? "GitHub is not signed in" : "Pull requests not counted";
}

/** Threads, pull requests merged and output tokens since the first of this month. */
export function MonthWidget() {
  const state = useTempoActivity(usePrimaryEnvironmentId());
  const { activity } = state;
  const totals = activity ? monthTotals(activity.days) : undefined;
  const merged = activity && totals ? gitHubCount(activity, totals.mergedPullRequests) : undefined;
  const missing = activity ? null : activityMissing(state);
  return (
    <WidgetFrame widget="month" icon={<ChartNoAxesColumnIcon />} title="This month">
      {missing ? (
        <p className="my-auto text-center text-tempo-label text-muted-foreground">{missing}</p>
      ) : (
        <div className="flex flex-1 flex-col justify-between gap-2">
          <Stat value={totals?.threads} format={formatCount} label="threads" />
          <Stat
            value={merged}
            format={formatCount}
            label="pull requests merged"
            missing={mergedMissing(activity?.github)}
          />
          <Stat
            value={totals?.outputTokens}
            format={formatTokens}
            label="output tokens"
            missing="Output tokens not counted"
          />
        </div>
      )}
    </WidgetFrame>
  );
}
