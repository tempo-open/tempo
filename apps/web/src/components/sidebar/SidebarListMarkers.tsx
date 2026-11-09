import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { SidebarGroupLabel, SidebarGroupToggle } from "../../tempo/sidebar/SidebarGroupLabel";
import { sidebarTranslate } from "../../tempo/sidebar/sidebarZoom";
import { useSortable } from "@dnd-kit/sortable";
import { type ReactNode, useLayoutEffect } from "react";
import { cn } from "~/lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the projected drop box inside the scroll viewport as drag transforms move it
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [node, props.revealOverflow, transform?.y]);
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        // tempo: in the sidebar's own pixels, which the tempo look zooms on a wide window.
        transform: sidebarTranslate(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      revealOverflow={props.marker === "settled-placeholder" && props.showHint}
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  // tempo: the opt-in sidebar keeps a rule under its pinned rows at rest.
  rule?: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn(
        "pointer-events-none relative mx-0.5",
        props.rule === true ? "h-3" : "-mb-px h-0",
      )}
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : props.rule === true ? (
        <span aria-hidden className="absolute inset-x-2 top-1/2 h-px bg-sidebar-border/60" />
      ) : null}
    </SortableSidebarMarker>
  );
}

/** tempo: the tempo look's Pinned and Open labels, with their counts, at rest and mid drag. */
export function SidebarGroupBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  count: number;
  dragging: boolean;
  isDropTarget: boolean;
}) {
  const atRest = props.count > 0;
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("pointer-events-none relative", atRest ? "h-8" : "-mb-px h-0")}
    >
      {atRest || props.dragging ? (
        <SidebarGroupLabel
          className="sidebar-drag-boundary-label absolute inset-x-0 top-0"
          label={props.label}
          count={props.count}
          tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        />
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker:
    | "working-header"
    | "background-header" // tempo: Waiting.
    | "snoozed-header"
    | "waiting-header"
    | "settled-header";
  label: string;
  /** A muted trailing count. */
  count: number;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
  // tempo: the tempo look's group label, in the list or among the docked shelves.
  group?: "list" | "docked";
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "background-header"
        ? "background"
        : props.marker === "snoozed-header"
          ? "snoozed"
          : props.marker === "waiting-header"
            ? "waiting"
            : "settled";
  const tone = props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted";
  if (props.group !== undefined) {
    return (
      <SortableSidebarMarker
        marker={props.marker}
        data-testid={`sidebar-${props.marker}`}
        className={cn("relative", props.className)}
      >
        <SidebarGroupToggle
          role="treeitem"
          tabIndex={-1}
          data-sidebar-row={`shelf:${shelf}`}
          data-testid={`sidebar-${shelf}-shelf-toggle`}
          onClick={props.toggle.onToggle}
          expanded={props.toggle.expanded}
          docked={props.group === "docked"}
          label={props.label}
          count={props.count}
          tone={tone}
        />
      </SortableSidebarMarker>
    );
  }
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn("relative mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        role="treeitem"
        tabIndex={-1}
        data-sidebar-row={`shelf:${shelf}`}
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={tone}
        data-testid={`sidebar-${shelf}-shelf-toggle`}
        accessory={<span className="font-normal tabular-nums">{props.count}</span>}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}
