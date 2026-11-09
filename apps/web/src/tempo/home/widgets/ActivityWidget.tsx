import { formatCount } from "@t3tools/shared/usageFormat";
import { CalendarIcon } from "lucide-react";

import { DayGrid } from "~/tempo/activity/DayGrid";
import { useTempoActivity } from "~/tempo/activity/useTempoActivity";
import { formatDay } from "~/tempo/usage/activityFormat";
import { usePrimaryEnvironmentId } from "~/state/environments";
import {
  activityMissing,
  HEAT_MAP_WEEKS,
  heatDayDetail,
  heatMap,
  type HeatMap,
} from "./homeActivity";
import { Placeholder, WidgetFrame } from "./WidgetFrame";

// Before the days arrive the map is drawn empty at its full size.
const EMPTY_WEEKS = Array.from({ length: HEAT_MAP_WEEKS * 7 }, (_, index) => index);

function HeatMapGrid({ map, label }: { readonly map: HeatMap | null; readonly label: string }) {
  if (map === null) {
    return (
      <div data-tempo-home-heat="" role="img" aria-label={label}>
        {EMPTY_WEEKS.map((index) => (
          <i key={index} data-level={0} />
        ))}
      </div>
    );
  }
  return (
    <DayGrid
      data-tempo-home-heat=""
      label={label}
      days={map.cells.map((cell) => ({ day: cell.day, detail: heatDayDetail(cell) }))}
      renderCell={(index, props) => {
        const cell = map.cells[index]!;
        return (
          <i
            key={cell.day}
            {...props}
            data-level={cell.level}
            data-today={index === map.cells.length - 1 && cell.level > 0 ? "" : undefined}
          />
        );
      }}
    />
  );
}

/** Threads and agents started each day over the recent weeks, with the two totals under the map. */
export function ActivityWidget() {
  const state = useTempoActivity(usePrimaryEnvironmentId());
  const { activity } = state;
  const map = activity ? heatMap(activity.days) : null;
  const missing = activityMissing(state);
  // The totals count only the days shown, so the label names the first of them to the day.
  const since = map ? `Since ${formatDay(map.cells[0]!.day)}` : null;
  return (
    <WidgetFrame widget="activity" icon={<CalendarIcon />} title="Activity" aside={since}>
      <HeatMapGrid
        map={map}
        label={
          since
            ? `Threads and agents started each day. ${since}`
            : "Threads and agents started each day"
        }
      />
      <p className="mt-3 flex gap-4 text-tempo-caption text-secondary-label">
        {map ? (
          <>
            <span>
              <b className="me-0.75 font-semibold text-foreground tabular-nums">
                {formatCount(map.threads)}
              </b>{" "}
              threads
            </span>
            {map.agents === null ? null : (
              <span>
                <b className="me-0.75 font-semibold text-foreground tabular-nums">
                  {formatCount(map.agents)}
                </b>{" "}
                agents
              </span>
            )}
          </>
        ) : activity ? (
          "No threads yet"
        ) : (
          (missing ?? (
            <>
              <span>
                <Placeholder className="me-0.75 h-2.5 w-6" />
                threads
              </span>
              <span>
                <Placeholder className="me-0.75 h-2.5 w-6" />
                agents
              </span>
            </>
          ))
        )}
      </p>
    </WidgetFrame>
  );
}
