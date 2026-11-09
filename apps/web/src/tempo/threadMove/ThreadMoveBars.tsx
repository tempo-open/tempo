import type { TempoThreadMoveLink } from "@t3tools/contracts";
import { ArrowUpRightIcon, MonitorUpIcon } from "lucide-react";

import { Button } from "../../components/ui/button";
import { useEnvironmentPresentation } from "../../state/presentation";

function movedOn(movedAt: string): string {
  const date = new Date(movedAt);
  return Number.isNaN(date.getTime())
    ? ""
    : ` on ${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * Stands in for the composer on a thread that moved to another machine. The
 * history stays readable here; new turns happen on the copy it links to.
 */
export function MovedAwayThreadBar(props: {
  readonly movedTo: TempoThreadMoveLink;
  /** Offered only while this client is connected to the machine the thread moved to. */
  readonly onOpen: () => void;
}) {
  const { presentation } = useEnvironmentPresentation(props.movedTo.environmentId);
  const connected = presentation?.connection.phase === "connected";
  return (
    <div
      role="status"
      className="flex min-h-12 items-center gap-3 rounded-3xl py-2 ps-5 pe-2 text-sm"
    >
      <MonitorUpIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-foreground">
        Moved to <span className="font-medium">{props.movedTo.environmentLabel}</span>
        {movedOn(props.movedTo.movedAt)}
      </span>
      <span className="ms-auto shrink-0 text-muted-foreground max-sm:hidden">
        {connected ? "Read only" : `Connect to ${props.movedTo.environmentLabel} to open it`}
      </span>
      {connected ? (
        <Button size="sm" variant="ghost" onClick={props.onOpen}>
          <ArrowUpRightIcon />
          Open there
        </Button>
      ) : null}
    </div>
  );
}

/** One line above the composer until the moved thread's first new turn. */
export function MovedFromThreadNotice(props: { readonly movedFrom: TempoThreadMoveLink }) {
  return (
    <p className="px-5 pb-1 text-muted-foreground text-xs">
      Moved from {props.movedFrom.environmentLabel}
      {movedOn(props.movedFrom.movedAt)}. The next message starts a fresh session that gets this
      history.
    </p>
  );
}
