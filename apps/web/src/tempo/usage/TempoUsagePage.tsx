/**
 * tempo: the Usage page in the tempo look: a page in the sheet with
 * the tabs Cost, Usage and Limits, when the shown tab's data was read, and Refresh. UsagePage keeps
 * the state the looks share and hands in the Cost tab's views; this page reads the other two tabs'.
 */
import type { KeybindingCommand } from "@t3tools/contracts";
import { collectLimitAccounts } from "@t3tools/shared/usageLimits";
import { ChartNoAxesColumnIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ScrollArea } from "~/components/ui/scroll-area";
import { SidebarInset } from "~/components/ui/sidebar";
import { Toggle, ToggleGroup } from "~/components/ui/toggle-group";
import { WINDOW_OPTIONS, type UsageMetric } from "~/components/usage/usageShortcuts";
import { WorkspacePageContainer } from "~/components/WorkspacePageContainer";
import { WorkspacePageHeader } from "~/components/WorkspacePageHeader";
import { isElectron } from "~/env";
import { usePrimarySettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { formatDayAwareTimestamp } from "~/timestampFormat";
import { useTempoActivity } from "../activity/useTempoActivity";
import { limitsReadAt } from "../limits/limitRows";
import { UsageActivityTab } from "./UsageActivityTab";
import { UsageLimitsTab, useLimitsSource } from "./UsageLimitsTab";

type Tab = "cost" | "activity" | "limits";

interface Option<T> {
  readonly value: T;
  readonly label: string;
  readonly command?: KeybindingCommand;
}

const TABS: readonly Option<Tab>[] = [
  { value: "cost", label: "Cost", command: "usage.cost" },
  { value: "activity", label: "Usage" },
  { value: "limits", label: "Limits", command: "usage.limits" },
];

// The keys c and t switch the Cost tab between dollars and tokens, as they switched views before.
const UNITS: readonly Option<UsageMetric>[] = [
  { value: "cost", label: "Cost", command: "usage.cost" },
  { value: "tokens", label: "Tokens", command: "usage.tokens" },
];

function tabOf(metric: UsageMetric): Tab {
  return metric === "tokens" ? "cost" : metric;
}

export function TempoUsagePage({
  metric,
  onSelectMetric,
  windowDays,
  onSelectWindow,
  shortcutTitle,
  windowLabel,
  filters,
  cost,
  cursorPrompt,
  costUpdatedAt,
  refreshing,
  refreshDisabled,
  onRefresh,
}: {
  readonly metric: UsageMetric;
  readonly onSelectMetric: (metric: UsageMetric) => void;
  readonly windowDays: number;
  readonly onSelectWindow: (days: number) => void;
  readonly shortcutTitle: (option: {
    readonly label: string;
    readonly command?: KeybindingCommand;
  }) => string;
  readonly windowLabel: string;
  /** The environment and provider menus, which the Cost tab alone applies. */
  readonly filters: ReactNode;
  readonly cost: ReactNode;
  readonly cursorPrompt: ReactNode;
  readonly costUpdatedAt: string | null;
  readonly refreshing: boolean;
  readonly refreshDisabled: boolean;
  readonly onRefresh: () => void;
}) {
  const tab = tabOf(metric);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const activity = useTempoActivity(tab === "activity" ? primaryEnvironmentId : null);
  const limitPresentations = useLimitsSource(tab === "limits" ? primaryEnvironmentId : null);
  const updatedAt = {
    cost: costUpdatedAt,
    activity: activity.activity?.readAt ?? null,
    limits: limitsReadAt(collectLimitAccounts(limitPresentations)),
  }[tab];
  const activityTab = tab === "activity";

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <WorkspacePageHeader electron={isElectron} className="gap-2.5 bg-background">
        <ChartNoAxesColumnIcon aria-hidden className="size-4.5 text-muted-foreground" />
        <h1 className="text-tempo-title font-semibold text-foreground">Usage</h1>
        <div className="ms-auto flex items-center gap-2.5">
          <ToggleGroup
            aria-label="Usage view"
            data-tempo-usage-segmented=""
            value={[tab]}
            onValueChange={(next) => {
              const value = TABS.find((option) => option.value === next[0])?.value;
              if (value) onSelectMetric(value);
            }}
          >
            {TABS.map((option) => (
              <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
                {option.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <span aria-hidden className="mx-1.5 h-4 w-px bg-tempo-hair-2" />
          {updatedAt ? (
            <span className="text-tempo-caption text-secondary-label">
              Updated {formatDayAwareTimestamp(updatedAt, timestampFormat)}
            </span>
          ) : null}
          <Button
            onClick={activityTab ? activity.refresh : onRefresh}
            aria-label={`Refresh ${TABS.find((option) => option.value === tab)?.label.toLowerCase()}`}
            aria-busy={activityTab ? activity.isPending : refreshing}
            disabled={activityTab ? activity.isPending : refreshDisabled}
            size="icon-sm"
            variant="ghost"
          >
            <RefreshIcon size="sm" refreshing={activityTab ? activity.isPending : refreshing} />
          </Button>
        </div>
      </WorkspacePageHeader>
      <ScrollArea className="min-h-0 flex-1">
        {tab === "cost" ? (
          <WorkspacePageContainer width="wide">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex min-w-0 items-center gap-1 text-tempo-label">{filters}</div>
              <span className="truncate text-xs text-secondary-label">{windowLabel}</span>
              <div className="ms-auto flex items-center gap-2.5">
                <ToggleGroup
                  aria-label="Usage measure"
                  data-tempo-usage-segmented="compact"
                  value={[metric]}
                  onValueChange={(next) => {
                    const value = UNITS.find((option) => option.value === next[0])?.value;
                    if (value) onSelectMetric(value);
                  }}
                >
                  {UNITS.map((option) => (
                    <Toggle key={option.value} value={option.value} title={shortcutTitle(option)}>
                      {option.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
                <ToggleGroup
                  aria-label="Usage period"
                  data-tempo-usage-segmented="compact"
                  value={[String(windowDays)]}
                  onValueChange={(next) => {
                    if (next[0]) onSelectWindow(Number(next[0]));
                  }}
                >
                  {WINDOW_OPTIONS.map((option) => (
                    <Toggle
                      key={option.days}
                      value={String(option.days)}
                      title={shortcutTitle(option)}
                    >
                      {option.label}
                    </Toggle>
                  ))}
                </ToggleGroup>
              </div>
            </div>
            {cost}
          </WorkspacePageContainer>
        ) : (
          <div className="mx-auto max-w-200 px-5 pt-8.5 pb-10 leading-[normal]">
            {activityTab ? (
              <UsageActivityTab activity={activity.activity} error={activity.error} />
            ) : (
              <UsageLimitsTab presentations={limitPresentations} cursorPrompt={cursorPrompt} />
            )}
          </div>
        )}
      </ScrollArea>
    </SidebarInset>
  );
}
