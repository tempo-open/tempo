import { useAtomValue } from "@effect/atom-react";
import {
  scopedProjectKey,
  scopedThreadKey,
  scopeProjectRef,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { resolveSettledThreadTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import { ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";

import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { useClientSettings } from "~/hooks/useSettings";
import { useNowMinute } from "~/hooks/useNowMinute";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { useDelegatedUnderParent, useProjects, useServerConfigs } from "~/state/entities";
import { usePullRequestsSupported } from "~/state/environments";
import { useOlderSettledShelf } from "~/state/olderSettledShelf";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { useUiStateStore } from "~/uiStateStore";
import { LimitGlance } from "../limits/LimitGlance";
import { useQuietThreadShells } from "../quietThreadShells";
import { SidebarGroupLabel, SidebarGroupToggle } from "../sidebar/SidebarGroupLabel";
import { SidebarNewThreadRow } from "../sidebar/SidebarNewThreadRow";
import { useSidebarV2Enabled } from "../sidebar/useSidebarV2";
import { ThreadIcon } from "../threadLogos/ThreadLogo";
import { groupHomePreviewThreads } from "./homePreview.logic";

type PreviewProjects = ReadonlyMap<string, EnvironmentProject>;

function compactTimeLabel(timestamp: string | null, nowMinute: string) {
  if (timestamp === null) return null;
  const label = formatRelativeTimeLabel(timestamp, Date.parse(`${nowMinute}:00.000Z`));
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** A thread's one line as the tempo sidebar draws it at rest: logo, title, time. */
function PreviewThreadRow(props: {
  readonly thread: EnvironmentThreadShell;
  readonly projects: PreviewProjects;
  readonly settled: boolean;
  readonly nowMinute: string;
}) {
  const { thread, settled } = props;
  return (
    <div
      className="flex h-7.5 items-center gap-2.5 ps-2 pe-2"
      data-tempo-home-preview-row={settled ? "settled" : ""}
    >
      <ThreadIcon
        title={thread.title}
        logo={thread.source.tempoLogo}
        project={props.projects.get(
          scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
        )}
        className={cn("size-4.5 rounded-tempo-logo", settled && "opacity-42 grayscale")}
      />
      <span
        className={cn(
          "min-w-0 flex-1 overflow-hidden text-sm leading-4.75 font-book whitespace-nowrap",
          settled ? "text-secondary-label" : "text-foreground",
        )}
      >
        {thread.title}
      </span>
      <span
        className={cn(
          "shrink-0 text-tempo-meta whitespace-nowrap tabular-nums",
          settled ? "text-tempo-ink-4" : "text-secondary-label",
        )}
      >
        {compactTimeLabel(
          settled
            ? resolveSettledThreadTimestamp(thread)
            : (thread.latestUserMessageAt ?? thread.updatedAt),
          props.nowMinute,
        )}
      </span>
    </div>
  );
}

/**
 * The window's sidebar in the Appearance preview, from the same threads, limits and settings as
 * the real one: New thread, Pinned, Open, Settled today, the docked shelves folded, and the
 * footer. Inert, like everything in the preview.
 */
export function HomePreviewSidebar() {
  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const visitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const isSidebarV2 = useSidebarV2Enabled();
  const workingShelfEnabled = useClientSettings((s) => s.sidebarWorkingShelfEnabled);
  const productionWaitShelfEnabled = useClientSettings((s) => s.tempoProductionWaitShelfEnabled);
  const sidebarLight = useClientSettings((s) => s.tempoSidebarLight);
  const nowMinute = useNowMinute();
  const groups = groupHomePreviewThreads({
    threads,
    delegatedUnderParent,
    visitedAtById,
    isSidebarV2,
    workingShelfEnabled,
    productionWaitShelfEnabled,
    nowMs: Date.parse(`${nowMinute}:00.000Z`),
  });
  // Older settled threads stay on the server; their count completes Show all, as in the sidebar.
  const serverConfigs = useServerConfigs();
  const olderSettled = useOlderSettledShelf({
    scopes: [...serverConfigs.keys()].map((environmentId) => ({ environmentId, projectIds: null })),
    expanded: false,
    visibleCount: 0,
  });
  const settledCount = groups.settledCount + olderSettled.unloadedCount(threads);
  const projectList = useProjects();
  const projects: PreviewProjects = new Map(
    projectList.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const pullRequestsSupported = usePullRequestsSupported();
  const row = (thread: EnvironmentThreadShell, settled: boolean) => (
    <PreviewThreadRow
      key={scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id))}
      thread={thread}
      projects={projects}
      settled={settled}
      nowMinute={nowMinute}
    />
  );

  return (
    <div data-tempo-home-preview-sidebar="">
      {sidebarLight ? (
        <div aria-hidden className="sidebar-light-backdrop absolute inset-x-0 top-0" />
      ) : null}
      <div data-tempo-home-preview-sidebar-top="">
        <SidebarNewThreadRow
          shortcut={shortcutLabelForCommand(keybindings, "chat.new")}
          tooltip="New thread"
          disabled={false}
          onNewThread={() => {}}
        >
          {null}
        </SidebarNewThreadRow>
      </div>
      <div data-tempo-home-preview-list="">
        {groups.pinned.length > 0 ? (
          <>
            <SidebarGroupLabel label="Pinned" count={groups.pinned.length} tone="muted" />
            {groups.pinned.map((thread) => row(thread, false))}
          </>
        ) : null}
        {groups.open.length > 0 ? (
          <>
            <SidebarGroupLabel label="Open" count={groups.open.length} tone="muted" />
            {groups.open.map((thread) => row(thread, false))}
          </>
        ) : null}
        {settledCount > 0 ? (
          <>
            <SidebarGroupToggle
              label="Settled today"
              count={groups.settledToday.length}
              tone="muted"
              expanded
              docked={false}
            />
            {groups.settledToday.map((thread) => row(thread, true))}
            {settledCount > groups.settledToday.length ? (
              <div className="flex h-7.5 items-center ps-9 text-tempo-note text-secondary-label">
                Show all {settledCount}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
      {groups.shelves.length > 0 ? (
        <div data-tempo-home-preview-shelves="">
          {groups.shelves.map((shelf) => (
            <SidebarGroupToggle
              key={shelf.label}
              label={shelf.label}
              count={shelf.count}
              tone="muted"
              expanded={false}
              docked
            />
          ))}
        </div>
      ) : null}
      <div data-tempo-home-preview-footer="">
        <LimitGlance />
        <span data-tempo-home-preview-utility="">
          <SettingsIcon />
          {pullRequestsSupported ? <PullRequestGlyph.pullRequest /> : null}
          <ChartNoAxesColumnIcon />
        </span>
      </div>
    </div>
  );
}
