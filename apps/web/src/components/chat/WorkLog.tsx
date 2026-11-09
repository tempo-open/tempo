import {
  createContext,
  use,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
} from "react";
import { cn } from "../../lib/utils";

const GroupedRows = createContext(false);

/** Groups may span virtualized timeline items. Each part owns its trailing space. */
export function WorkLogBlock({
  layout = "standalone",
  continues = false,
  children,
}: {
  layout?: "standalone" | "group-header" | "group-content";
  continues?: boolean | undefined;
  children: ReactNode;
}) {
  return (
    <div
      className={
        continues || layout === "group-header"
          ? "pb-0"
          : layout === "group-content"
            ? "pb-1"
            : "pb-2"
      }
    >
      {children}
    </div>
  );
}

export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

type RowContent = {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
};

/** tempo: a row's hover time keeps its space in the tempo look, so the fill does not grow on hover. */
export const WORK_LOG_TIMESTAMP_CLASS_NAME = "tempo:static";

/**
 * tempo: in the tempo look a one line row hugs its words, 30 px tall, and fills on hover; the row
 * takes the pointer and draws its focus ring only here, so all three are this one box.
 */
function WorkLogLine({ icon, label, trailing, wrapLabel }: RowContent) {
  return (
    <div
      className={cn(
        "flex min-h-6 min-w-0 gap-1.5 text-sm leading-relaxed select-none [&_*]:select-none",
        "tempo:-ms-2 tempo:min-h-7.5 tempo:rounded-lg tempo:px-2 tempo:transition-colors tempo:hover:bg-muted tempo:hover:[&_.text-secondary-label]:text-muted-foreground",
        "tempo:group-focus-visible/timeline-row:ring-2 tempo:group-focus-visible/timeline-row:ring-ring/70 tempo:group-focus-visible/timeline-row:ring-inset",
        wrapLabel
          ? "items-start tempo:items-baseline tempo:w-[calc(100%+1rem)] tempo:py-1"
          : "items-center tempo:w-max tempo:max-w-[calc(100%+1rem)]",
      )}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5 tempo:gap-2.25">
        {icon ? (
          <span className="relative w-6 shrink-0 leading-0 tempo:w-3.75">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)] tempo:size-3.75 tempo:align-[calc(0.5cap_-_0.46875rem)] tempo:[&_img]:size-3.75 tempo:[&_svg]:size-3.75">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        ) : null}
        <div
          className={cn(
            "min-w-0 flex-1 text-secondary-label",
            !wrapLabel && "truncate [&_*]:whitespace-nowrap",
          )}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

const interactionClassName =
  "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70";

function useRowClassName(interactive: boolean) {
  const grouped = use(GroupedRows);
  return cn(
    "group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors",
    // tempo: the tempo look's row is only its line and details to the pointer (see WorkLogLine), with
    // the icon on the prose's edge.
    "tempo:pointer-events-none tempo:px-0 tempo:*:pointer-events-auto",
    grouped ? "py-0" : "py-0.5",
    interactive && interactionClassName,
    interactive && "tempo:focus-visible:ring-0",
  );
}

export function WorkLogButton({
  icon,
  label,
  trailing,
  wrapLabel = false,
  ...buttonProps
}: RowContent & Omit<ComponentProps<"button">, "className" | "style" | "children">) {
  const className = useRowClassName(true);
  return (
    <button {...buttonProps} type="button" className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
    </button>
  );
}

/** Div disclosure permits selectable detail and nested actions. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel = false,
  children,
  ...rowProps
}: RowContent & Omit<ComponentProps<"div">, "className" | "style">) {
  const className = useRowClassName(rowProps.onClick !== undefined);
  return (
    <div {...rowProps} className={className}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
      {children}
    </div>
  );
}

const LIVE_EDGE_PX = 4;

export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel" | "media";

  followLive?: boolean;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const atLiveEdgeRef = useRef(true);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pins the scroller's scrollTop to the bottom after each commit while following live output
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (followLive && atLiveEdgeRef.current && scroller) {
      scroller.scrollTop = scroller.scrollHeight;
    }
  });
  return (
    <div
      ref={scrollerRef}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdgeRef.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
      className={cn(
        "cursor-auto",
        kind === "text"
          ? "ms-7 flex max-h-96 flex-col gap-3 overflow-auto px-0.5 py-1 select-text tempo:ms-5.5"
          : kind === "panel"
            ? "mt-0.5 mb-1.5 pb-2"
            : "mt-1",
      )}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}
