/** tempo: the pieces the tempo look's Usage and Limits tabs share. */
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

export function UsageHeadline({
  figure,
  label,
  mark,
}: {
  readonly figure: ReactNode;
  readonly label: ReactNode;
  readonly mark?: ReactNode;
}) {
  return (
    <div className="mb-5.5 flex items-baseline gap-3">
      {mark}
      <span className="text-tempo-figure font-semibold tracking-tempo-figure text-foreground tabular-nums">
        {figure}
      </span>
      <span className="text-tempo-title text-muted-foreground">{label}</span>
    </div>
  );
}

export function UsageCard({
  title,
  aside,
  label,
  children,
}: {
  readonly title: ReactNode;
  readonly aside?: ReactNode;
  /** Names the card when its title is a control rather than words. */
  readonly label?: string;
  readonly children: ReactNode;
}) {
  return (
    <section
      aria-label={label}
      className="mb-6.5 rounded-xl bg-card px-4.5 pt-4 pb-4.5 ring-1 ring-border"
    >
      <header
        className={cn(
          "mb-3.5 flex text-tempo-title font-semibold text-foreground",
          typeof title === "string" ? "items-baseline" : "items-center",
        )}
      >
        {typeof title === "string" ? <h2>{title}</h2> : title}
        {aside ? (
          <span className="ms-auto text-tempo-note font-tempo-book text-secondary-label">
            {aside}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}
