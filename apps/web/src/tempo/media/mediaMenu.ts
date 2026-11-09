import type { MediaActionId } from "@t3tools/client-runtime/media-actions";
import type { MediaReference } from "@t3tools/client-runtime/media-reference";
import type { ContextMenuItem } from "@t3tools/contracts";

export interface MediaMenuInput {
  readonly kind: "image" | "video";
  readonly reference: MediaReference | undefined;
  /** No bytes to act on, or the connection may not read them. */
  readonly isUnavailable: boolean;
  readonly canReadMedia: boolean;
  readonly canCopyImage: boolean;
  readonly canOpenInNewTab: boolean;
  readonly canAddToChat: boolean;
  /** Set only when this machine can reveal files; applies to file references only. */
  readonly revealLabel: string | undefined;
  readonly hasOpenFile: boolean;
}

export function buildMediaMenuItems(input: MediaMenuInput): ContextMenuItem<MediaActionId>[] {
  const items: ContextMenuItem<MediaActionId>[] = [];
  if (input.kind === "image") {
    if (input.canOpenInNewTab)
      items.push({
        id: "open-in-new-tab",
        label: "Open image in new tab",
        disabled: input.isUnavailable,
      });
    if (input.canAddToChat)
      items.push({ id: "add-to-chat", label: "Add to chat", disabled: input.isUnavailable });
    items.push({
      id: "copy-image",
      label: "Copy image",
      disabled: input.isUnavailable || !input.canCopyImage,
    });
    if (input.revealLabel !== undefined && input.reference?.kind === "file")
      items.push({ id: "reveal-in-folder", label: input.revealLabel });
  }
  items.push({ id: "save", label: "Download a copy", disabled: input.isUnavailable });

  const extras: ContextMenuItem<MediaActionId>[] = [];
  const reference = input.reference;
  if (reference?.kind === "file") {
    extras.push({ id: "copy-full-path", label: "Copy full path" });
    if (reference.relativePath)
      extras.push({ id: "copy-relative-path", label: "Copy relative path" });
  } else if (reference?.kind === "url") {
    extras.push({ id: "copy-url", label: "Copy URL" });
  }
  if (input.hasOpenFile)
    extras.push({ id: "open-file", label: "Open in file viewer", disabled: !input.canReadMedia });
  const [firstExtra, ...restExtras] = extras;
  if (firstExtra !== undefined) items.push({ ...firstExtra, separatorBefore: true }, ...restExtras);
  return items;
}
