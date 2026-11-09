import { useLayoutEffect, useRef, useState, type ComponentProps, type CSSProperties } from "react";
import { useStore } from "zustand";
import { ChatCanvasContext } from "./ChatCanvasContext";
import type { ChatCanvasPreview } from "./chatCanvasLayout";
import { resolveChatCanvasModel, type ChatCanvasStore } from "./canvasStore";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { observeResize } from "../../lib/observeResize";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useClientSettings } from "~/hooks/useSettings";
import { threadPanelStatePresentation } from "../../tempo/threadDetails/threadDetailsAutoOpen";
import { useTempoLook } from "../../tempo/look/useTempoLook";
import { chatColumnPlaceStore, resolveChatAxis } from "../../tempo/look/windowAxis";

export function ChatCanvas({
  store,
  threadRef,
  preview,
  composerOverlayElement,
  detailsCardTopInset = 0,
  centerOnWindow,
  children,
  ...props
}: Omit<ComponentProps<"div">, "className" | "style" | "ref"> & {
  store: ChatCanvasStore;
  /** The thread whose details card sits on the canvas; other threads' measurements are stale. */
  threadRef: ScopedThreadRef | null;
  /** The thread's mini player while it renders on this canvas. */
  preview: ChatCanvasPreview | null;
  composerOverlayElement: HTMLElement | null;
  detailsCardTopInset?: number;
  /** tempo: whether the tempo look's axis is the window's middle; false beside a side panel. */
  centerOnWindow: boolean;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const widthProbeRef = useRef<HTMLDivElement | null>(null);
  const [timelineElement, registerTimeline] = useState<HTMLElement | null>(null);
  const measurements = useStore(store, (state) => state.measurements);
  const detailsCardMeasurement = useStore(store, (state) => state.detailsCardMeasurement);
  const look = useTempoLook();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- observes canvas, find bar and timeline resizes and writes the measurements to the canvas store
  useLayoutEffect(() => {
    const element = elementRef.current;
    const probe = widthProbeRef.current;
    if (!element || !probe) return;
    const findBar =
      detailsCardTopInset > 0 ? element.querySelector<HTMLElement>("[data-thread-find-bar]") : null;
    const measure = () => {
      const canvasBounds = element.getBoundingClientRect();
      const findBarBounds = findBar?.getBoundingClientRect();
      const styles = getComputedStyle(probe);
      store.getState().setMeasurements({
        findBar:
          detailsCardTopInset > 0
            ? {
                left: findBarBounds ? findBarBounds.left - canvasBounds.left : 0,
                right: findBarBounds ? findBarBounds.right - canvasBounds.left : 0,
                bottom: findBarBounds ? findBarBounds.bottom - canvasBounds.top : 0,
              }
            : null,
        width: element.clientWidth,
        height: element.clientHeight,
        padding: Number.parseFloat(styles.paddingLeft),
        maxChatWidth: Number.parseFloat(styles.width),
        minChatWidth: Number.parseFloat(styles.minWidth),
        composerHeight: composerOverlayElement?.getBoundingClientRect().height ?? 0,
        timelineGutter: timelineElement
          ? (timelineElement.offsetWidth - timelineElement.clientWidth) / 2
          : 0,
        // tempo: the tempo look's axis on a wide window (look/windowAxis.ts).
        axis:
          look === "tempo"
            ? resolveChatAxis({
                windowWidth: window.innerWidth,
                canvasLeft: canvasBounds.left,
                canvasWidth: element.clientWidth,
                centerOnWindow,
              })
            : null,
      });
    };
    measure();
    const observed: Element[] = [element, probe];
    if (findBar) observed.push(findBar);
    if (composerOverlayElement) observed.push(composerOverlayElement);
    if (timelineElement) observed.push(timelineElement);
    return observeResize(observed, measure);
  }, [store, composerOverlayElement, timelineElement, detailsCardTopInset, look, centerOnWindow]);
  // tempo: with Open thread details automatically off, the inline card follows the popover's flag.
  const detailsAutoOpen = useClientSettings((s) => s.tempoThreadDetailsAutoOpen);
  const detailsCardInlineOpen = useRightPanelStore((state) =>
    threadRef === null
      ? false
      : selectThreadPanelOpen(
          state.threadPanelVisibilityByThreadKey,
          threadRef,
          threadPanelStatePresentation("inline", detailsAutoOpen),
        ),
  );
  const model = resolveChatCanvasModel({
    measurements,
    detailsCardMeasurement,
    threadRef,
    preview,
    detailsCardInlineOpen,
  });
  const context = {
    container: model.container,
    lane: model.lane,
    layout: model.layout,
    previewKey: preview?.key ?? null,
    registerTimeline,
    measureDetailsCard: store.getState().measureDetailsCard,
    detailsCardTopInset: model.detailsCardTopInset,
    preferredDetailsCard: model.preferredDetailsCard,
    detailsCardPlacement: model.detailsCardPlacement,
  };
  const { layout } = context;
  // tempo: where the column sits on the axis, for the chrome outside the canvas that lines up with it.
  const { axis } = measurements;
  const columnStart = axis === null ? null : layout.chat.left;
  const columnMiddle =
    axis === null ? null : axis.canvasLeft + layout.chat.left + layout.chat.width / 2;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the thread header and the title bar's search sit outside the canvas and line up with its column
  useLayoutEffect(() => {
    if (columnStart === null || columnMiddle === null) return;
    chatColumnPlaceStore.setState({ place: { start: columnStart, middle: columnMiddle } });
    return () => chatColumnPlaceStore.setState({ place: null });
  }, [columnStart, columnMiddle]);
  return (
    <ChatCanvasContext value={context}>
      <div
        {...props}
        ref={elementRef}
        data-chat-canvas
        data-preview-overlaps-chat={layout.overlapsChat || undefined}
        // tempo: look/wide.css places the minimap beside the column while the axis is on.
        data-tempo-axis={columnStart === null ? undefined : ""}
        className="relative flex min-h-0 min-w-0 flex-1 flex-col"
        style={
          {
            "--chat-timeline-gutter": `${measurements.timelineGutter}px`,
            "--chat-lane-inset-start": `${layout.chat.insetStart}px`,
            "--chat-lane-inset-end": `${layout.chat.insetEnd}px`,
            ...(columnStart === null ? {} : { "--tempo-column-start": `${columnStart}px` }),
          } as CSSProperties
        }
      >
        <div
          ref={widthProbeRef}
          aria-hidden
          className="pointer-events-none invisible absolute h-0 w-(--chat-content-max-width) min-w-[40rem] box-content ps-3 sm:ps-12"
        />
        {children}
      </div>
    </ChatCanvasContext>
  );
}
