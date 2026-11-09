import type { PullRequestState } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { resolvePullRequestState } from "~/components/pullRequest/pullRequestPresentation";
import { cn } from "~/lib/utils";

/** One labeled line of the card; a thread with no value for it passes null. */
export type SidebarRowHoverCardField = {
  readonly label: string;
  readonly value: ReactNode;
  readonly tone?: "warning" | "error" | undefined;
};

/** The thread's current pull request in its state color, and how many more it links. */
export function HoverCardPullRequest(props: {
  number: number;
  state: PullRequestState;
  isDraft: boolean;
  others: number;
}) {
  const state = resolvePullRequestState(props);
  return (
    <>
      <span className={cn("font-medium", state.toneClassName)}>
        #{props.number} {state.label}
      </span>
      {props.others > 0 ? ` and ${props.others} more` : null}
    </>
  );
}

/**
 * The tempo look's hover card of a one-line row: what the old two and three line rows showed and
 * everything else the old card listed, one labeled field per line.
 */
export function SidebarRowHoverCard(props: {
  icon: ReactNode;
  title: string;
  fields: ReadonlyArray<SidebarRowHoverCardField | null>;
}) {
  return (
    <div className="flex w-[260px] min-w-0 flex-col text-tempo-note leading-4.5">
      <div className="mb-2.5 flex min-w-0 items-start gap-2.25">
        <span className="mt-px flex shrink-0">{props.icon}</span>
        <span className="min-w-0 text-tempo-heading font-semibold text-foreground">
          {props.title}
        </span>
      </div>
      <dl className="grid grid-cols-[minmax(92px,auto)_minmax(0,1fr)] gap-x-2.5">
        {props.fields.map((field) =>
          field === null ? null : (
            <div key={field.label} className="contents">
              <dt className="py-0.75 text-secondary-label">{field.label}</dt>
              <dd
                className={cn(
                  "min-w-0 py-0.75 wrap-break-word",
                  field.tone === "warning"
                    ? "text-warning"
                    : field.tone === "error"
                      ? "text-error"
                      : "text-foreground",
                )}
              >
                {field.value}
              </dd>
            </div>
          ),
        )}
      </dl>
    </div>
  );
}
