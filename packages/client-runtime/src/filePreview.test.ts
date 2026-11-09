import { describe, expect, it } from "vite-plus/test";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { readFilePreviewResponse } from "./filePreview.ts";

describe("readFilePreviewResponse", () => {
  it("cancels a pending read when its preview closes", async () => {
    const controller = new AbortController();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    });
    const result = readFilePreviewResponse(new Response(body), controller.signal);
    controller.abort();
    await expect(result).rejects.toThrow();
    expect(cancelled).toBe(true);
  });
  it("supports native AbortSignal implementations without throwIfAborted", async () => {
    const signal = new AbortController().signal;
    Object.defineProperty(signal, "throwIfAborted", { value: undefined });
    await expect(readFilePreviewResponse(new Response("native text"), signal)).resolves.toEqual({
      text: "native text",
      truncated: false,
    });
  });

  it("stops consuming an unbounded response and cancels its stream", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(FILE_TEXT_PREVIEW_MAX_BYTES).fill(97));
      },
      cancel() {
        cancelled = true;
      },
    });
    const result = await readFilePreviewResponse(new Response(body), new AbortController().signal);
    expect(result.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES);
    expect(result.truncated).toBe(true);
    expect(cancelled).toBe(true);
  });

  it("reads a whole file past the preview size up to a larger limit", async () => {
    const signal = new AbortController().signal;
    const text = "a".repeat(FILE_TEXT_PREVIEW_MAX_BYTES * 2);
    const full = await readFilePreviewResponse(
      new Response(text),
      signal,
      FILE_TEXT_PREVIEW_MAX_BYTES * 3,
    );
    expect(full.text.length).toBe(text.length);
    expect(full.truncated).toBe(false);
    const capped = await readFilePreviewResponse(
      new Response(text),
      signal,
      FILE_TEXT_PREVIEW_MAX_BYTES + 5,
    );
    expect(capped.text.length).toBe(FILE_TEXT_PREVIEW_MAX_BYTES + 5);
    expect(capped.truncated).toBe(true);
  });
});
