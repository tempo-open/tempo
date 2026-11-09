import type { TempoHomeWidget } from "@t3tools/contracts";
import type { ReactNode } from "react";

/** One widget under the typing bar: a glass card, its title and what it counts, then its content. */
export function WidgetFrame(props: {
  readonly widget: TempoHomeWidget;
  readonly icon: ReactNode;
  readonly title: string;
  readonly aside?: ReactNode;
  readonly children: ReactNode;
}) {
  return (
    <section
      data-tempo-home-widget={props.widget}
      className="flex min-w-0 flex-1 flex-col rounded-2xl px-4.5 pt-3.75 pb-4 leading-[normal]"
    >
      <h3 className="mb-3.5 flex items-center gap-2 font-medium text-muted-foreground">
        {props.icon}
        {props.title}
        {props.aside ? (
          <span className="ms-auto text-tempo-caption font-book text-secondary-label tabular-nums">
            {props.aside}
          </span>
        ) : null}
      </h3>
      {props.children}
    </section>
  );
}

/** Where a number will stand once its data arrives, so nothing moves when it does. */
export function Placeholder({ className }: { readonly className: string }) {
  return <span aria-hidden data-tempo-home-placeholder="" className={className} />;
}
