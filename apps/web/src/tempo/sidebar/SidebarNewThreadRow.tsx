import { PlusIcon } from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode, Ref } from "react";

import { useTempoSidebarLight } from "~/components/sidebar/SidebarChrome";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";

/**
 * The tempo look's sidebar top: New thread with its shortcut, then the project filter and Add
 * project. Search lives in the title bar. Over the sidebar's art the button is glass.
 */
export function SidebarNewThreadRow({
  ref,
  shortcut,
  tooltip,
  disabled,
  onNewThread,
  children,
}: {
  readonly ref?: Ref<HTMLDivElement> | undefined;
  readonly shortcut: string | null | undefined;
  readonly tooltip: ReactNode;
  readonly disabled: boolean;
  readonly onNewThread: (event: ReactMouseEvent) => void;
  readonly children: ReactNode;
}) {
  const overArt = useTempoSidebarLight();
  return (
    <div ref={ref} className="flex items-center gap-1" data-tempo-new-thread-row="">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              disabled={disabled}
              onClick={onNewThread}
              className="flex min-w-0 flex-1 cursor-pointer items-center outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:cursor-default disabled:opacity-64"
              data-tempo-new-thread=""
              data-over-art={overArt ? "" : undefined}
            />
          }
        >
          <PlusIcon aria-hidden className="size-4 shrink-0" />
          {/* A row too narrow for the shortcut wraps it onto a second line, which is cut off, so
              the label always reads in full. */}
          <span className="flex h-lh min-w-0 flex-1 flex-wrap items-center justify-between gap-x-2.25 overflow-hidden">
            <span className="whitespace-nowrap">New thread</span>
            {shortcut ? <kbd>{shortcut}</kbd> : null}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
      {children}
    </div>
  );
}
