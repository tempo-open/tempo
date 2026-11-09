import {
  classifyComposerAttachmentFile,
  normalizeComposerImageFileMimeType,
} from "~/components/chat/composerAttachmentFiles";
import type { MediaActionSource } from "~/components/media/MediaActions";
import { resolveProtocolRelativeMediaUrl } from "~/components/media/mediaContent";

/** Applies the composer's paste check to fetched image bytes: an image File, or the error to show. */
export function chatImageFile(blob: Blob, name: string): File | string {
  const file = normalizeComposerImageFileMimeType(new File([blob], name, { type: blob.type }));
  const kind = classifyComposerAttachmentFile(file);
  if (kind === "image") return file;
  // Same wording as the composer's paste path (ChatComposer.tsx).
  return kind === "unsupported-image"
    ? `'${name}' is not a supported image type. Attach DNG, GIF, HEIC, HEIF, JPEG, PNG, or WebP images.`
    : "This image type can't be added to chat.";
}

export type NewTabTarget =
  | { readonly kind: "url"; readonly url: string }
  | { readonly kind: "asset" };

/**
 * The authored web address wins (a GitHub image opens on GitHub, not through the proxy).
 * A server asset's minted link carries an hour-long token, so only the in-app browser gets it;
 * the system browser would keep it in its history. null hides the menu item.
 */
export function newTabTarget(
  source: Pick<MediaActionSource, "reference" | "asset" | "src">,
  opensInPreview: boolean,
): NewTabTarget | null {
  if (source.reference?.kind === "url")
    return { kind: "url", url: resolveProtocolRelativeMediaUrl(source.reference.url) };
  if (source.asset !== undefined) return opensInPreview ? { kind: "asset" } : null;
  // A blob: or data: URL means nothing outside this page.
  if (source.src === null || /^(?:blob|data):/i.test(source.src)) return null;
  return { kind: "url", url: source.src };
}
