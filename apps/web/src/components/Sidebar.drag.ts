import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "background-header" || // tempo: Waiting.
    item.marker === "snoozed-header" ||
    item.marker === "waiting-header" ||
    item.marker === "settled-header");

// tempo: the sections whose rows can carry nested subagent rows, so they are not the slim reference.
const isLineSection = (section: SidebarSection) =>
  section === "pinned" || section === "active" || section === "working" || section === "background";

export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Only pointer movement changes sections; opening the destination moves rows under stationary gestures.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        // tempo: the first shelf in the list's own order, so Settled today counts under Open.
        const firstShelf = items.find(isShelfHeader);
        const nextHeader =
          firstShelf === undefined
            ? undefined
            : args.droppableContainers.find(
                (container) => container.id === sidebarListItemId(firstShelf),
              );
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  enabled?: boolean;
  settledOrder: readonly string[];
  activeOrder?: readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  boundaryLabelHeight?: number;
  /** tempo: the opt-in sidebar's one-line rows, which may carry nested subagent rows. */
  lineRows?: boolean;
  /** tempo: the height a slim row has at the default font size: 36, or 30 in the tempo look. */
  slimRowHeight?: number;
  /**
   * tempo: the tempo look's shelves, docked below Settled today. They follow the list, and stick to
   * the foot of a list that runs under them, where they stay where they measure.
   */
  dockedShelves?: boolean;
  /** tempo: whether Settled today ends in its Show more row, between the list and the docked shelves. */
  settledMoreRow?: boolean;
}): SortingStrategy {
  if (input.enabled === false) return () => stationary;
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return [];
    const groups: Record<SidebarSection, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      background: [], // tempo: Waiting.
      snoozed: [],
      waiting: [],
      settled: [],
    };
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      // tempo: one-line rows measure as the card height here.
      if (isLineSection(item.section)) cardHeight ??= rects[index]?.height;
      else slimHeight ??= rects[index]?.height;
      if (item.key !== active.key) groups[item.section].push(item);
    }
    const slimRowHeight = input.slimRowHeight ?? 36;
    const scale =
      slimHeight !== undefined
        ? slimHeight / slimRowHeight
        : (headerScale ?? (cardHeight ?? 82) / 82);
    slimHeight ??= slimRowHeight * scale;
    // tempo: with one-line rows an unmeasured row is a slim row, not an 82px card.
    cardHeight ??= input.lineRows === true ? slimHeight : 82 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const group = groups[target.section];
    const order =
      target.section === "pinned"
        ? target.pinnedOrder
        : target.section === "settled"
          ? input.settledOrder
          : (input.activeOrder ?? target.activeOrder);
    const ranks = new Map(order.map((key, index) => [key, index]));
    const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
    const index = group.findIndex(
      (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
    );
    group.splice(index < 0 ? group.length : index, 0, { ...active, section: target.section });
    const settledOrder = (
      input.settledOrder.length > 0 ? input.settledOrder : groups.settled.map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = visible.map((key) => ({ kind: "thread", key, section: "settled" }));
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    const section = (name: "active" | "settled") => {
      if (groups[name].length > 0) projected.push(...groups[name]);
      else marker(`${name}-placeholder`);
    };
    const docked = input.dockedShelves === true;
    const settledShelf = () => {
      marker("settled-header");
      section("settled");
    };
    marker("pinned-header");
    projected.push(...groups.pinned);
    marker("pinned-divider");
    section("active");
    // tempo: the tempo look's Settled today sits above the docked shelves.
    if (docked) settledShelf();
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    // tempo: like Working, the Waiting shelf keeps its place through a drag.
    if (items.some((item) => item.kind === "marker" && item.marker === "background-header")) {
      marker("background-header");
      projected.push(...groups.background);
    }
    // tempo: Waiting for Production sits above Snoozed. Its rows never move, so the shelf keeps its
    // place through a drag.
    if (items.some((item) => item.kind === "marker" && item.marker === "waiting-header")) {
      marker("waiting-header");
      projected.push(...groups.waiting);
    }
    if (
      groups.snoozed.length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...groups.snoozed);
    }
    if (!docked) settledShelf();
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind === "thread" && isLineSection(item.section) ? cardHeight : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      // tempo: a one-line row keeps its own measured height (nested subagent rows included) when it
      // lands in another one-line section; only a move into a slim shelf takes the slim height.
      const keepsOwnHeight =
        input.lineRows === true && item.kind === "thread" && isLineSection(item.section);
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder")
          ? slimHeight
          : moved && !keepsOwnHeight
            ? fallback
            : (rect?.height ?? fallback);
    });
    // The shelves sit at the bottom; Settled today above docked ones is part of the list.
    const opensShelves = (item: SidebarListItem | undefined) =>
      isShelfHeader(item) &&
      !(docked && item?.kind === "marker" && item.marker === "settled-header");
    const firstShelf = items.findIndex(opensShelves);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    const gapAboveShelves = shelfRect && beforeShelf ? shelfRect.top - beforeShelf.bottom - 1 : 0;
    // tempo: the docked shelves follow the list, keeping the gap they measure under it, until they
    // stick to the foot of a list that runs under them, if only over its Show more row; there they
    // hold still.
    const stuck = docked && gapAboveShelves < (input.settledMoreRow === true ? slimHeight + 1 : 0);
    let shelfSpace = docked
      ? Math.max(0, gapAboveShelves)
      : shelfRect && beforeShelf && lastRect && gapAboveShelves > 0
        ? Math.max(
            0,
            lastRect.bottom - rects[0].top - heights.reduce((sum, height) => sum + height + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    let dockTop = stuck ? shelfRect?.top : undefined;
    for (const [projectedIndex, item] of projected.entries()) {
      if (opensShelves(item)) {
        top = dockTop ?? top + shelfSpace;
        dockTop = undefined;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}
