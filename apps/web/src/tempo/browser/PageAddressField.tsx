import { Globe, Lock } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

import { pageAddress } from "./pageAddress";

/**
 * tempo: the tempo look's address, a filled pill (look/panel.css). At rest it shows the host and
 * then the path over the input, whose own text stays clear; while editing, the input shows the
 * whole address.
 */
export function PageAddressField(props: {
  readonly url: string;
  readonly editing: boolean;
  readonly inputProps: ComponentProps<"input">;
}) {
  const address = pageAddress(props.url);
  const Glyph = address?.secure ? Lock : Globe;
  const shown = props.editing ? null : address;
  return (
    <label
      className="mx-1.5 flex h-7 min-w-0 flex-1 cursor-text items-center gap-1.75 bg-accent px-2.5 text-secondary-label focus-within:ring-2 focus-within:ring-ring focus-within:ring-inset"
      data-page-address
    >
      <Glyph className="size-3.5 shrink-0" />
      <span className="relative flex min-w-0 flex-1">
        <input
          {...props.inputProps}
          className={cn(
            "w-full min-w-0 bg-transparent outline-none placeholder:text-secondary-label disabled:cursor-not-allowed",
            props.editing ? "text-foreground" : shown ? "text-transparent" : "text-secondary-label",
          )}
        />
        {shown ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-nowrap"
          >
            <span className="font-medium text-muted-foreground">{shown.host}</span>
            {shown.rest}
          </span>
        ) : null}
      </span>
    </label>
  );
}
