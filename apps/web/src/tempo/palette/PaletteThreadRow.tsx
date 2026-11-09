import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import type { ProjectFaviconProject } from "../../components/ProjectFavicon";
import {
  pullRequestMatchesSearchQuery,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  resolveWorkingStartedAt,
  type ThreadStatusPill,
} from "../../components/Sidebar.logic";
import { WorkingDuration } from "../../components/sidebar/SidebarThreadRow";
import {
  ThreadRowLeadingStatus,
  ThreadRowTrailingStatus,
  ThreadSearchPullRequestNumber,
} from "../../components/ThreadStatusIndicators";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useClientSettings } from "../../hooks/useSettings";
import { formatRelativeTime } from "../../timestampFormat";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { SidebarStatusWord } from "../sidebar/SidebarStatusWord";
import { ThreadIcon } from "../threadLogos/ThreadLogo";

// The status the classic rows show as a dot, in the sidebar's words and colors.
const STATUS_WORDS: Record<
  Exclude<ThreadStatusPill["label"], "Working" | "Waiting" | "Completed">,
  { readonly word: string; readonly className: string }
> = {
  Connecting: { word: "Connecting", className: "font-medium text-tempo-accent" },
  "Pending Approval": { word: "Approval", className: "font-medium text-warning" },
  "Awaiting Input": { word: "Input", className: "font-medium text-warning" },
  "Guest Request": { word: "Request", className: "font-medium text-warning" },
  "Plan Ready": { word: "Plan ready", className: "font-medium text-warning" },
  Failed: { word: "Failed", className: "font-medium text-error" },
};

/**
 * The parts of a palette thread row in the tempo look, for `buildThreadActionItems`: the logo, the
 * title on one line, its marks, and its end. The project and branch line goes, as in the sidebar.
 */
export function tempoPaletteThreadRow(input: {
  readonly projectByKey: ReadonlyMap<string, ProjectFaviconProject>;
  readonly activeThread: { readonly environmentId: EnvironmentId; readonly id: ThreadId } | null;
  readonly query: string;
}) {
  const { projectByKey, activeThread, query } = input;
  return {
    icon: (thread: SidebarThreadSummary) => (
      <ThreadIcon
        title={thread.title}
        logo={thread.source.tempoLogo}
        project={projectByKey.get(`${thread.environmentId}:${thread.projectId}`) ?? null}
      />
    ),
    renderLeadingContent: () => null,
    renderTrailingContent: (thread: SidebarThreadSummary) => (
      <PaletteThreadMarks thread={thread} query={query} />
    ),
    renderDescription: () => null,
    renderTimestamp: (thread: SidebarThreadSummary) => (
      <PaletteThreadEnd
        thread={thread}
        isCurrent={
          thread.id === activeThread?.id && thread.environmentId === activeThread.environmentId
        }
      />
    ),
    // The palette stands in for the sidebar's search: settled rows dimmed, files dropped on a row.
    rowState: (thread: SidebarThreadSummary) => ({
      settled: thread.settledOverride === "settled",
      fileDropThread: scopeThreadRef(thread.environmentId, thread.id),
    }),
  };
}

/** Beside the end: the thread's pull request, a running terminal, a remote machine. */
function PaletteThreadMarks(props: { thread: SidebarThreadSummary; query: string }) {
  const { thread, query } = props;
  return (
    <>
      {pullRequestMatchesSearchQuery(thread, query) ? (
        <ThreadSearchPullRequestNumber
          thread={thread}
          query={query}
          settled={thread.settledOverride === "settled"}
        />
      ) : (
        <ThreadRowLeadingStatus thread={thread} withStatus={false} />
      )}
      <ThreadRowTrailingStatus thread={thread} />
    </>
  );
}

/**
 * The row's end: a working thread's live time in blue, a status word or the sidebar's unread check,
 * else "Current thread" or how long ago the thread moved.
 */
function PaletteThreadEnd(props: { thread: SidebarThreadSummary; isCurrent: boolean }) {
  const { thread } = props;
  const localLastVisitedAt = useUiStateStore(
    (state) =>
      state.threadLastVisitedAtById[
        scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))
      ],
  );
  const lastVisitedAt = resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt);
  const pill = resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } });
  // A settled thread shows no unread check, as in the sidebar.
  const status = pill?.label === "Completed" && thread.settledOverride === "settled" ? null : pill;
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);

  if (status?.label === "Working") {
    const isGoal = thread.goal?.status === "active";
    return (
      <SidebarStatusWord
        label={isGoal ? "Goal" : "Working"}
        variant={isGoal ? "row" : "time"}
        duration={<WorkingDuration startedAt={resolveWorkingStartedAt(thread)} />}
        limitResetAt={null}
        timestampFormat={timestampFormat}
      />
    );
  }
  if (status?.label === "Waiting") {
    // Timed from the turn's end, as the sidebar times it.
    return (
      <SidebarStatusWord
        label="Waiting"
        variant="row"
        duration={<WorkingDuration startedAt={thread.latestRun?.completedAt ?? null} />}
        limitResetAt={null}
        timestampFormat={timestampFormat}
      />
    );
  }
  if (status?.label === "Failed" && thread.runtime?.lastErrorClass === "usage_limit") {
    return (
      <SidebarStatusWord
        label="Limited"
        variant="row"
        duration={null}
        limitResetAt={thread.runtime.usageLimitResetAt ?? null}
        timestampFormat={timestampFormat}
      />
    );
  }
  if (status?.label === "Completed") {
    return (
      <SidebarStatusWord
        label="Done"
        variant="row"
        duration={null}
        limitResetAt={null}
        timestampFormat={timestampFormat}
      />
    );
  }
  if (status) {
    const { word, className } = STATUS_WORDS[status.label];
    return <span className={className}>{word}</span>;
  }
  if (props.isCurrent) return "Current thread";
  return <PaletteRelativeTime timestamp={thread.latestUserMessageAt ?? thread.updatedAt} />;
}

/** How long ago, in the sidebar's words: "now", "5m", "2h", "3d". */
export function PaletteRelativeTime(props: { timestamp: string }) {
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const value = formatRelativeTime(props.timestamp, nowMs)?.value ?? null;
  return value === "just now" ? "now" : value;
}
