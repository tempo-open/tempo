/**
 * tempo: "Load full file" in the file preview. A preview shows a file's first MiB;
 * the full read returns the rest up to TEMPO_FULL_FILE_READ_MAX_BYTES. These decide
 * what the preview's limited bar offers and how much of the text gets rich
 * rendering.
 */
import { TEMPO_FULL_FILE_READ_MAX_BYTES } from "@t3tools/contracts";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";

/** Where a person's request for the whole file stands. */
export type FullFileRequest = "idle" | "loading" | "failed" | "loaded";

/**
 * `complete`: nothing on screen was cut, so there is no bar. `offer`: the whole file fits a full
 * read. `too-large`: the file is bigger than a full read returns. `unsupported`: the full read came
 * back cut at the preview size, as from a server that predates full reads and drops the request.
 */
export type LimitedPreviewState =
  | "complete"
  | "offer"
  | "loading"
  | "failed"
  | "too-large"
  | "unsupported";

export function limitedPreviewState(input: {
  /** The read on screen was cut short. */
  readonly truncated: boolean;
  /** The whole file's size, or null when unknown. */
  readonly byteLength: number | null;
  readonly request: FullFileRequest;
}): LimitedPreviewState {
  if (!input.truncated) return "complete";
  if (input.byteLength !== null && input.byteLength > TEMPO_FULL_FILE_READ_MAX_BYTES) {
    return "too-large";
  }
  // A full read that is still cut either hit the cap (the size was unknown) or
  // was answered as a preview.
  if (input.request === "loaded") return input.byteLength === null ? "too-large" : "unsupported";
  if (input.request === "loading" || input.request === "failed") return input.request;
  return "offer";
}

/**
 * Text longer than a preview renders plain: no syntax highlighting and no
 * rendered Markdown. The highlighter's worker returns its whole tree to the main
 * thread in one structured clone, measured at about 150 ms per MB of source and
 * 830 ms for a 5 MB log, and rendered Markdown lays out every block at once.
 */
export function rendersAsPlainText(text: string): boolean {
  return text.length > FILE_TEXT_PREVIEW_MAX_BYTES;
}
