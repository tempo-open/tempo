import { useAtomValue } from "@effect/atom-react";
import { useRouter } from "@tanstack/react-router";
import { ChevronLeftIcon, ChevronRightIcon, MoonIcon, SearchIcon, SunIcon } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode, type Ref } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import { notifyThemeSaveFailure } from "~/components/CommandPaletteThemeItems";
import { Button } from "~/components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { setAppearanceMode, useTheme } from "~/hooks/useTheme";
import { shortcutLabelForCommand } from "~/keybindings";
import { cn } from "~/lib/utils";
import { primaryServerKeybindingsAtom } from "~/state/server";
import { createHistoryReach } from "./historyReach";

function TitleBarButton(props: {
  readonly label: string;
  readonly shortcut?: string | null;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-sm"
            aria-label={props.label}
            disabled={props.disabled}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.label}
        {props.shortcut ? ` (${props.shortcut})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * The tempo look's window title bar: the sidebar toggle, Back and Forward, the search field that
 * opens the command palette, and the light or dark switch. It drags the window; its controls do not.
 */
export function TempoTitleBar({
  ref,
  sidebarToggle,
  overArt,
  hidden,
  theme,
  searchCenter = null,
}: {
  readonly ref: Ref<HTMLDivElement>;
  readonly sidebarToggle: ReactNode;
  /** The sidebar's light is under the toggle, Back and Forward, which then draw in white in dark. */
  readonly overArt: boolean;
  readonly hidden: boolean;
  /** The theme the bar draws for, when not the app's: the Appearance preview's own. */
  readonly theme?: "light" | "dark";
  /** Where the search centers in the window on a wide window: the conversation's axis. */
  readonly searchCenter?: number | null;
}) {
  const router = useRouter();
  const [historyReach] = useState(() => createHistoryReach(router.history));
  const reach = useSyncExternalStore(
    historyReach.subscribe,
    historyReach.getSnapshot,
    historyReach.getSnapshot,
  );
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const appTheme = useTheme().resolvedTheme;
  const resolvedTheme = theme ?? appTheme;
  const searchShortcut = shortcutLabelForCommand(keybindings, "commandPalette.toggle");
  const nextAppearance = resolvedTheme === "dark" ? "light" : "dark";

  return (
    <div
      ref={ref}
      className={cn(
        "drag-region fixed inset-x-0 top-0 z-40 flex h-(--tempo-titlebar-height) items-center pr-(--workspace-controls-right) pl-(--workspace-controls-left)",
        hidden && "hidden",
      )}
      data-tempo-title-bar=""
      data-over-art={overArt ? "" : undefined}
    >
      <div className="flex items-center" data-tempo-title-bar-nav="">
        {sidebarToggle}
        <div className="ms-1.5 flex items-center gap-0.5">
          <TitleBarButton
            label="Back"
            shortcut={shortcutLabelForCommand(keybindings, "navigation.back")}
            disabled={!reach.back}
            onClick={() => router.history.back()}
          >
            <ChevronLeftIcon />
          </TitleBarButton>
          <TitleBarButton
            label="Forward"
            shortcut={shortcutLabelForCommand(keybindings, "navigation.forward")}
            disabled={!reach.forward}
            onClick={() => router.history.forward()}
          >
            <ChevronRightIcon />
          </TitleBarButton>
        </div>
      </div>
      <button
        type="button"
        className="absolute left-1/2 flex -translate-x-1/2 cursor-pointer items-center gap-2 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset max-md:hidden"
        data-tempo-title-bar-search=""
        style={searchCenter === null ? undefined : { left: searchCenter }}
        onClick={() => openCommandPalette()}
      >
        <SearchIcon aria-hidden />
        <span className="min-w-0 flex-1 overflow-hidden text-start whitespace-nowrap">
          Search threads, projects and commands
        </span>
        {searchShortcut ? <kbd>{searchShortcut}</kbd> : null}
      </button>
      <div className="ms-auto flex items-center">
        <TitleBarButton
          label={nextAppearance === "light" ? "Switch to light" : "Switch to dark"}
          onClick={() => {
            if (!setAppearanceMode(nextAppearance)) notifyThemeSaveFailure();
          }}
        >
          {resolvedTheme === "dark" ? <SunIcon /> : <MoonIcon />}
        </TitleBarButton>
      </div>
    </div>
  );
}
