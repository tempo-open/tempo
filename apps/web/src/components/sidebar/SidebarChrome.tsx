import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { APP_BASE_NAME } from "../../branding";
import {
  useClientSettings,
  useClientSettingsHydrated,
  useEnvironmentIdentificationMode,
  useSidebarSkylineEnabled,
} from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { usePullRequestsSupported } from "../../state/environments";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { LaptopToolsSidebarIndicator } from "~/tempo/laptopTools/LaptopToolsCoordinator";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { LimitGlance } from "~/tempo/limits/LimitGlance";
import { useTempoLook } from "~/tempo/look/useTempoLook";
import { observeResize } from "~/lib/observeResize";

/**
 * tempo: whether the tempo look draws the blue light behind the top of the sidebar (Sidebar light).
 * It draws no stage art: a dev or nightly build looks as the stable one does.
 */
export function useTempoSidebarLight(): boolean {
  const settingsHydrated = useClientSettingsHydrated();
  const lightOn = useClientSettings((settings) => settings.tempoSidebarLight);
  return settingsHydrated && lightOn;
}

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;
  const look = useTempoLook();
  const tempoLight = useTempoSidebarLight();
  // tempo: the stable channel has no stage art, so its artwork slot shows the pixel skyline, on any
  // theme, unless the person chose None or picked nightly or dev art.
  const showSkyline =
    useSidebarSkylineEnabled() &&
    backdropVariant === null &&
    resolveSidebarStageBackdropVariant(stageLabel) === null;
  const mobileTrigger = (
    <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
      <SidebarTrigger
        variant={backdropVariant && look === "classic" ? "media-navigation" : "ghost"}
        className="relative top-auto translate-y-0"
        aria-label="Toggle main sidebar"
      />
    </div>
  );
  const pill = pillLabel ? (
    <div className="ml-1 flex h-7 items-center">
      <Badge data-environment-identification="pill" size="sm" variant="secondary">
        {pillLabel}
      </Badge>
    </div>
  ) : null;

  // tempo: the window title bar sits over this row and carries the controls, so it keeps only the
  // light, the pill and the narrow window's toggle.
  if (look === "tempo") {
    return (
      <div
        className={cn(
          "relative flex h-(--tempo-titlebar-height) shrink-0 items-center",
          isElectron && "drag-region",
        )}
        data-tempo-sidebar-top=""
      >
        {tempoLight ? (
          <div
            aria-hidden
            className="sidebar-light-backdrop pointer-events-none absolute inset-x-0 top-0"
          />
        ) : null}
        {mobileTrigger}
        {pill ? <div className="ms-auto pe-3">{pill}</div> : null}
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3",
        isElectron && "drag-region",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {showSkyline ? (
        <div
          aria-hidden
          className="sidebar-skyline-backdrop pointer-events-none absolute inset-x-0 top-0 z-0"
        />
      ) : null}
      {mobileTrigger}
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pill}
      </div>
    </div>
  );
});

export function SidebarBrandWidthProbe({
  onWidthChange,
}: {
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        <SidebarBrandMark />
      </div>
    </div>
  );
}

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 ml-[var(--workspace-titlebar-content-left)] hidden h-7 w-fit min-w-0 shrink-0 items-center overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <SidebarBrandMark />
    </Link>
  );
}

function SidebarBrandMark() {
  return (
    <span className="min-w-0 truncate text-sm font-medium tracking-tight [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1">
      {APP_BASE_NAME}
    </span>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <SidebarMenu className="flex-row items-center" data-tempo-sidebar-utility="">
      {isOnUtilityPage ? (
        <SidebarMenuItem className="min-w-0 flex-1">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
        </>
      )}
      <SidebarThreadUndoNotice />
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  const look = useTempoLook();
  return (
    <SidebarFooter>
      {/* tempo: which threads may use this laptop's tools, with Stop. */}
      <LaptopToolsSidebarIndicator />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      {look === "tempo" ? <LimitGlance /> : null}
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
