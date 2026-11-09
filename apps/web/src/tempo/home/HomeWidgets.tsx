import type { TempoHomeWidget } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import { formatCount } from "@t3tools/shared/usageFormat";
import { TimerIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useTempoActivity } from "~/tempo/activity/useTempoActivity";
import { formatRefillGlance } from "~/tempo/limits/limitGlance.logic";
import { useLimitGlances } from "~/tempo/limits/useLimitGlances";
import claudeLogoUrl from "~/tempo/threadLogos/logos/claude.png";
import { useClientSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { ActivityWidget } from "./widgets/ActivityWidget";
import { activityMissing, gitHubCount, monthTotals } from "./widgets/homeActivity";
import { LimitWidget } from "./widgets/LimitWidget";
import { MonthWidget } from "./widgets/MonthWidget";
import { PullRequestsWidget } from "./widgets/PullRequestsWidget";
import { useHomePullRequests } from "./widgets/useHomePullRequests";
import { Placeholder } from "./widgets/WidgetFrame";

const selectWidgets = (settings: ClientSettings) => settings.tempoHomeWidgets;

const WIDGETS = {
  limit: LimitWidget,
  activity: ActivityWidget,
  pullRequests: PullRequestsWidget,
  month: MonthWidget,
} satisfies Record<TempoHomeWidget, () => ReactNode>;

/** The chosen widgets in a row: two span the typing bar's width, three run wider. */
export function HomeWidgets() {
  const widgets = useClientSettings(selectWidgets);
  return (
    <div
      data-tempo-home-widgets={widgets.length}
      className="pointer-events-auto mx-auto mt-7 flex w-full items-stretch gap-3"
    >
      {widgets.map((widget) => {
        const Widget = WIDGETS[widget];
        return <Widget key={widget} />;
      })}
    </div>
  );
}

/** A number in the status bar, or its place while it loads. */
function DockNumber({ value }: { readonly value: number | string | undefined }) {
  return value === undefined ? (
    <Placeholder className="h-3.5 w-4" />
  ) : (
    <b className="text-tempo-title font-semibold text-foreground tabular-nums">
      {typeof value === "number" ? formatCount(value) : value}
    </b>
  );
}

/** The status bar at the bottom of the home, for Place "At the bottom": limits, pull requests, this month. */
export function HomeDock() {
  const { now, glances } = useLimitGlances();
  const claude = glances.find((glance) => glance.driver === "claudeAgent");
  const refills = claude?.accounts.flatMap((account) => account.refillsAt ?? []) ?? [];
  const nextRefill = refills.length > 0 ? Math.min(...refills) : null;
  const pullRequests = useHomePullRequests(false);
  const activityState = useTempoActivity(usePrimaryEnvironmentId());
  const { activity } = activityState;
  const totals = activity ? monthTotals(activity.days) : undefined;
  const merged = activity && totals ? gitHubCount(activity, totals.mergedPullRequests) : undefined;
  const mergedToday = activity
    ? gitHubCount(activity, activity.days.at(-1)?.mergedPullRequests ?? null)
    : undefined;
  const activityMissingReason = activity ? null : activityMissing(activityState);
  return (
    <div
      data-tempo-home-dock
      className="pointer-events-auto absolute bottom-5.5 left-1/2 flex h-16 w-max -translate-x-1/2 items-center gap-5.5 px-6 text-tempo-note leading-[normal] whitespace-nowrap text-secondary-label"
    >
      {claude ? (
        <>
          <div className="flex items-center gap-2">
            <img src={claudeLogoUrl} alt="" draggable={false} className="size-4 rounded-sm" />
            <DockNumber value={`${claude.remainingPercent}%`} />
            <span>left</span>
            <span aria-hidden data-tempo-home-cells="">
              {claude.accounts.map((account) => (
                <i key={account.key}>
                  <b style={{ height: `${account.remainingPercent}%` }} />
                </i>
              ))}
            </span>
            {nextRefill === null ? null : (
              <span className="ms-0.5 inline-flex items-center gap-1 font-medium text-foreground tabular-nums">
                <TimerIcon aria-hidden className="size-3.25 text-muted-foreground" />
                <span className="sr-only">next refill in </span>
                {formatRefillGlance(nextRefill - now)}
              </span>
            )}
          </div>
          <span aria-hidden data-tempo-home-dock-separator="" />
        </>
      ) : null}
      <div className="flex items-center gap-2">
        {pullRequests.kind === "missing" ? (
          pullRequests.reason
        ) : (
          <>
            <PullRequestGlyph.pullRequest aria-hidden className="size-3.75 text-success" />
            <DockNumber
              value={pullRequests.kind === "ready" ? pullRequests.openCount : undefined}
            />
            <span>open</span>
            {mergedToday === null ? null : (
              <span>
                {mergedToday === undefined ? (
                  <Placeholder className="h-3 w-3" />
                ) : (
                  <b className="font-semibold text-foreground tabular-nums">{mergedToday}</b>
                )}{" "}
                merged today
              </span>
            )}
          </>
        )}
      </div>
      <span aria-hidden data-tempo-home-dock-separator="" />
      <div className="flex items-center gap-2">
        {activityMissingReason ?? (
          <>
            <span>This month</span>
            <DockNumber value={totals?.threads} />
            <span>threads</span>
            {merged === null ? null : (
              <>
                <DockNumber value={merged} />
                <span>merged</span>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
