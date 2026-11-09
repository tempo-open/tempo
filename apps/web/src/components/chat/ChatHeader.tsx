import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { ChevronDownIcon, EllipsisIcon, FilesIcon } from "lucide-react";
import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type CSSProperties,
  type ReactNode,
} from "react";
import { isTrailingDoubleClick } from "../Sidebar.logic";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { readLocalApi } from "~/localApi";
import { threadEnvironment } from "../../state/threads";
import { canShareWithGuestAtom } from "./guestShareAvailability";
import { useAtomValue } from "@effect/atom-react";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { textDirection } from "~/textDirection";
import { useClientSettings } from "../../hooks/useSettings";
import { GuestShareIndicator } from "./GuestShareControls";
import { useStore } from "zustand";
import { useTempoLook } from "~/tempo/look/useTempoLook";
import { chatColumnPlaceStore } from "~/tempo/look/windowAxis";
import { ThreadIcon } from "~/tempo/threadLogos/ThreadLogo";
import githubLogoUrl from "~/tempo/threadLogos/logos/github.png";

interface HeaderChipTarget {
  readonly count: number;
  readonly onOpen: () => void;
}

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  activeThreadTitle: string;
  activeThreadLinkOrigin?: string | null | undefined;
  isServerThread: boolean;
  activeProject: EnvironmentProject | null;
  parentThreadLink: { threadId: ThreadId; title: string } | null;
  onOpenThread: (threadId: ThreadId) => void;
  rightPanelOpen: boolean;
  onNewThreadInProject: () => void;
  onOpenProjectSettings?: (() => void) | undefined;
  /** tempo: the tempo look's header also shows the thread's logo, chips and panel toggles. */
  activeThreadLogo?: string | null | undefined;
  pullRequests?: HeaderChipTarget | null;
  /** Opens the side panel's Deliverables tab; the count is the thread's pages and files. */
  deliverables?: HeaderChipTarget | null;
  controls?: ReactNode;
}

function HeaderChip(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={props.label}
            onClick={props.onClick}
            className="inline-flex cursor-pointer items-center outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            data-tempo-header-chip=""
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

// Delay the input-swallowing native menu through the double-click rename interval.
const TITLE_MENU_OPEN_DELAY_MS = 500;
export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  activeThreadTitle,
  activeThreadLinkOrigin,
  isServerThread,
  activeProject,
  parentThreadLink,
  onOpenThread,
  rightPanelOpen,
  onNewThreadInProject,
  onOpenProjectSettings,
  activeThreadLogo,
  pullRequests,
  deliverables,
  controls,
}: ChatHeaderProps) {
  const look = useTempoLook();
  // tempo: on a wide window the tempo title starts where the conversation's column does (look/wide.css).
  const columnStart = useStore(chatColumnPlaceStore, (state) => state.place?.start ?? null);
  const activeProjectName = activeProject?.isScratch ? "No project" : activeProject?.title;
  const activeProjectCwd = activeProject?.workspaceRoot ?? null;
  const interfaceFont = useClientSettings((settings) => settings.fontFamilySans);
  const breadcrumbContainerRef = useRef<HTMLDivElement>(null);
  const [collapseParentTitle, setCollapseParentTitle] = useState(false);
  const activeThreadRef = scopeThreadRef(activeThreadEnvironmentId, activeThreadId);
  const canOperateThread = useEnvironmentScope(
    activeThreadEnvironmentId,
    AuthOrchestrationOperateScope,
  );
  const canShareWithGuest = useAtomValue(canShareWithGuestAtom(activeThreadEnvironmentId));
  const updateThreadMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  const [renaming, setRenaming] = useState<{
    threadId: ThreadId;
    environmentId: EnvironmentId;
    title: string;
  } | null>(null);
  if (
    renaming !== null &&
    (renaming.threadId !== activeThreadId ||
      renaming.environmentId !== activeThreadEnvironmentId ||
      !canOperateThread)
  ) {
    setRenaming(null);
  }
  const renamingTitle =
    canOperateThread &&
    renaming?.threadId === activeThreadId &&
    renaming.environmentId === activeThreadEnvironmentId
      ? renaming.title
      : null;
  const isRenamingTitle = renamingTitle !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the breadcrumb list DOM via ResizeObserver, a frame and font loads to collapse the parent title
  useEffect(() => {
    const list = breadcrumbContainerRef.current?.querySelector("ol");
    if (!list || !parentThreadLink) return;
    const measure = () => {
      const gap = Number.parseFloat(getComputedStyle(list).columnGap) || 0;
      const width = Array.from(list.children).reduce(
        (total, item) => {
          const label = item.querySelector('[data-slot="workspace-breadcrumb-text"]');
          const ellipsis = item.querySelector("[data-parent-breadcrumb-ellipsis]");
          return (
            total +
            (item.firstElementChild?.getBoundingClientRect().width ?? 0) +
            (label && getComputedStyle(label).maxWidth === "none"
              ? label.scrollWidth - label.clientWidth
              : 0) -
            (ellipsis?.getBoundingClientRect().width ?? 0)
          );
        },
        gap * (list.children.length - 1),
      );
      setCollapseParentTitle(width > list.clientWidth);
    };
    measure();
    const frame = requestAnimationFrame(measure);
    document.fonts.addEventListener("loadingdone", measure);
    const stopObserving = observeResize(list, measure);
    return () => {
      cancelAnimationFrame(frame);
      document.fonts.removeEventListener("loadingdone", measure);
      stopObserving();
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Title, font and rename changes resize the breadcrumb text without resizing the list, so it re-measures.
    activeProjectName,
    activeThreadTitle,
    parentThreadLink,
    interfaceFont,
    isRenamingTitle,
  ]);
  const renameCommittedRef = useRef(false);
  const startRename = () => {
    if (
      !isServerThread ||
      !readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)
    )
      return;
    renameCommittedRef.current = false;
    setRenaming({
      environmentId: activeThreadEnvironmentId,
      threadId: activeThreadId,
      title: activeThreadTitle,
    });
  };
  const commitRename = (title: string) => {
    setRenaming(null);
    if (!readEnvironmentScope(activeThreadEnvironmentId, AuthOrchestrationOperateScope)) return;
    const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
    if (resolution.action === "reject-empty") {
      toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
      return;
    }
    if (resolution.action === "noop") return;
    void updateThreadMetadata({
      environmentId: activeThreadEnvironmentId,
      input: { threadId: activeThreadId, title: resolution.title },
    }).then((result) => {
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Failed to rename thread",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      }
    });
  };
  const { openMenu, closeMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    onStartRename: startRename,
    canShareWithGuest,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const titleMenuTimerRef = useRef<number | null>(null);
  const cancelPendingTitleMenu = () => {
    if (titleMenuTimerRef.current === null) return;
    clearTimeout(titleMenuTimerRef.current);
    titleMenuTimerRef.current = null;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- clears the pending title-menu timer when the thread switches or the header unmounts
  useEffect(
    () => () => {
      if (titleMenuTimerRef.current === null) return;
      clearTimeout(titleMenuTimerRef.current);
      titleMenuTimerRef.current = null;
    },
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A pending title menu belongs to the thread that was clicked, so switching threads drops it.
    [activeThreadEnvironmentId, activeThreadId],
  );
  const openTitleMenuNow = () => {
    cancelPendingTitleMenu();
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  };
  const openMenuFromTitle = (event: ReactMouseEvent<HTMLButtonElement>) => {
    if (isTrailingDoubleClick(event.detail)) return;
    const clickedChevron =
      (event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null;
    if (event.detail === 0 || clickedChevron || window.desktopBridge === undefined) {
      openTitleMenuNow();
      return;
    }
    cancelPendingTitleMenu();
    titleMenuTimerRef.current = window.setTimeout(() => {
      titleMenuTimerRef.current = null;
      openTitleMenuNow();
    }, TITLE_MENU_OPEN_DELAY_MS);
  };
  const handleTitleDoubleClick = (event: ReactMouseEvent) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if ((event.target as HTMLElement).closest("[data-thread-title-chevron]") !== null) return;
    cancelPendingTitleMenu();
    closeMenu();
    startRename();
  };
  const hasHeaderMenu = isServerThread || onOpenProjectSettings !== undefined;
  const openHeaderMenu = (position: { x: number; y: number }) => {
    cancelPendingTitleMenu();
    if (!isServerThread) {
      const api = readLocalApi();
      if (!api) return;
      void api.contextMenu
        .show([{ id: "project-settings", label: "Project settings", icon: "settings" }], position)
        .then((action) => {
          if (action === "project-settings") onOpenProjectSettings?.();
        });
      return;
    }
    openMenu(position);
  };
  const handleHeaderContextMenu = (event: ReactMouseEvent) => {
    if (renamingTitle !== null || !hasHeaderMenu) return;
    event.preventDefault();
    openHeaderMenu({ x: event.clientX, y: event.clientY });
  };
  const handleRenameKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter") {
      renameCommittedRef.current = true;
      commitRename(event.currentTarget.value);
    } else if (event.key === "Escape") {
      renameCommittedRef.current = true;
      setRenaming(null);
    }
  };
  const projectLink = activeProject ? (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={`New thread in ${activeProjectName}`}
            onClick={onNewThreadInProject}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring tempo:ms-1 tempo:shrink tempo:text-secondary-label"
            data-thread-project-link=""
          />
        }
      >
        <ProjectFavicon project={activeProject} className="size-3.5" />
        <WorkspaceBreadcrumbText className="max-w-40">{activeProjectName}</WorkspaceBreadcrumbText>
      </TooltipTrigger>
      <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
    </Tooltip>
  ) : null;
  const parentCrumb = parentThreadLink ? (
    <>
      <WorkspaceBreadcrumbItem>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={`Open parent thread: ${parentThreadLink.title}`}
                onClick={() => onOpenThread(parentThreadLink.threadId)}
                className="inline-flex min-w-0 max-w-full cursor-pointer items-center rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <WorkspaceBreadcrumbText
              aria-hidden
              className={collapseParentTitle ? "w-0" : undefined}
            >
              {parentThreadLink.title}
            </WorkspaceBreadcrumbText>
            {collapseParentTitle ? (
              <span aria-hidden data-parent-breadcrumb-ellipsis>
                ...
              </span>
            ) : null}
          </TooltipTrigger>
          <TooltipPopup side="top">{parentThreadLink.title}</TooltipPopup>
        </Tooltip>
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  ) : null;
  const titleCrumb = (
    <WorkspaceBreadcrumbItem current className="min-w-10 flex-1">
      {renamingTitle !== null ? (
        <input
          autoFocus
          dir="auto"
          aria-label="Thread title"
          className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-inset ring-ring/50 focus:ring-ring"
          defaultValue={renamingTitle}
          onBlur={(event) => {
            if (renameCommittedRef.current) return;
            if (
              event.relatedTarget instanceof HTMLElement &&
              event.relatedTarget.closest("button")
            ) {
              setRenaming(null);
              return;
            }
            commitRename(event.currentTarget.value);
          }}
          onFocus={(event) => event.currentTarget.select()}
          onKeyDown={handleRenameKeyDown}
        />
      ) : isServerThread ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                ref={titleButtonRef}
                type="button"
                aria-label={`Thread actions for ${activeThreadTitle}`}
                aria-haspopup="menu"
                onClick={openMenuFromTitle}
                onDoubleClick={canOperateThread ? handleTitleDoubleClick : undefined}
                onBlur={cancelPendingTitleMenu}
                className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            <h2 className="min-w-0" dir={textDirection(activeThreadTitle)}>
              <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
            </h2>
            <ChevronDownIcon
              aria-hidden
              data-thread-title-chevron
              className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
            />
          </TooltipTrigger>
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-0 flex-1"
                dir={textDirection(activeThreadTitle)}
              />
            }
          >
            <WorkspaceBreadcrumbText>{activeThreadTitle}</WorkspaceBreadcrumbText>
          </TooltipTrigger>
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
      )}
      {renamingTitle === null && activeThreadLinkOrigin ? (
        <Tooltip>
          <TooltipTrigger render={<Badge variant="info" size="sm" />}>
            From {activeThreadLinkOrigin}
          </TooltipTrigger>
          <TooltipPopup side="top">
            Started by an agent on {activeThreadLinkOrigin} through a linked environment.
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </WorkspaceBreadcrumbItem>
  );
  const guestShare = isServerThread ? <GuestShareIndicator threadRef={activeThreadRef} /> : null;

  if (look === "tempo") {
    const chips = pullRequests || deliverables;
    return (
      <div
        ref={breadcrumbContainerRef}
        data-tempo-thread-header=""
        data-tempo-axis={columnStart === null ? undefined : ""}
        className="flex min-w-0 flex-1 items-center gap-2.5"
        style={
          columnStart === null
            ? undefined
            : ({ "--tempo-column-start": `${columnStart}px` } as CSSProperties)
        }
        onContextMenu={handleHeaderContextMenu}
      >
        {isServerThread ? (
          <ThreadIcon
            title={activeThreadTitle}
            logo={activeThreadLogo}
            project={activeProject}
            className="size-5"
          />
        ) : null}
        <WorkspaceBreadcrumb
          ariaLabel="Thread breadcrumb"
          className="overflow-clip [overflow-clip-margin:2px]"
        >
          {parentCrumb}
          {titleCrumb}
        </WorkspaceBreadcrumb>
        {projectLink}
        {guestShare}
        <div className="ms-auto flex shrink-0 items-center gap-1" data-tempo-header-controls="">
          {pullRequests ? (
            <HeaderChip label="Pull requests" onClick={pullRequests.onOpen}>
              <img src={githubLogoUrl} alt="" draggable={false} className="size-3.75 rounded-sm" />
              {pullRequests.count}
            </HeaderChip>
          ) : null}
          {deliverables ? (
            <HeaderChip label="Pages and files" onClick={deliverables.onOpen}>
              <FilesIcon aria-hidden className="size-3.75" />
              {deliverables.count}
            </HeaderChip>
          ) : null}
          {chips && controls ? (
            <span aria-hidden className="mx-1.5 h-4 w-px bg-tempo-hair-2" />
          ) : null}
          {controls}
          {hasHeaderMenu ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost-muted"
                    size="icon-sm"
                    aria-label="More"
                    aria-haspopup="menu"
                    onClick={(event) => {
                      const rect = event.currentTarget.getBoundingClientRect();
                      openHeaderMenu({ x: rect.left, y: rect.bottom + 4 });
                    }}
                  />
                }
              >
                <EllipsisIcon />
              </TooltipTrigger>
              <TooltipPopup side="bottom">More</TooltipPopup>
            </Tooltip>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      ref={breadcrumbContainerRef}
      className={cn(
        "flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-10" : "pr-24",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb
        ariaLabel="Thread breadcrumb"
        className="flex-1 overflow-clip [overflow-clip-margin:2px]"
      >
        {projectLink ? (
          <>
            <WorkspaceBreadcrumbItem className="shrink">{projectLink}</WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator>
              <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
            </WorkspaceBreadcrumbSeparator>
          </>
        ) : null}
        {parentCrumb}
        {titleCrumb}
      </WorkspaceBreadcrumb>
      {guestShare}
    </div>
  );
});
