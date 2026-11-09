import { TEMPO_FULL_FILE_READ_MAX_BYTES } from "@t3tools/contracts";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";
import { describe, expect, it } from "vite-plus/test";

import { limitedPreviewState, rendersAsPlainText } from "./fullFilePreview.ts";

const fiveMegabytes = 5_235_760;

describe("limitedPreviewState", () => {
  it("shows no bar once nothing on screen is cut", () => {
    expect(
      limitedPreviewState({ truncated: false, byteLength: fiveMegabytes, request: "loaded" }),
    ).toBe("complete");
    expect(limitedPreviewState({ truncated: false, byteLength: 12, request: "idle" })).toBe(
      "complete",
    );
  });

  it("offers the full file while it fits a full read", () => {
    expect(
      limitedPreviewState({ truncated: true, byteLength: fiveMegabytes, request: "idle" }),
    ).toBe("offer");
    expect(
      limitedPreviewState({
        truncated: true,
        byteLength: TEMPO_FULL_FILE_READ_MAX_BYTES,
        request: "idle",
      }),
    ).toBe("offer");
    // An attachment of unknown size can still try.
    expect(limitedPreviewState({ truncated: true, byteLength: null, request: "idle" })).toBe(
      "offer",
    );
  });

  it("never offers a file bigger than a full read returns", () => {
    for (const request of ["idle", "loading", "failed", "loaded"] as const) {
      expect(
        limitedPreviewState({
          truncated: true,
          byteLength: TEMPO_FULL_FILE_READ_MAX_BYTES + 1,
          request,
        }),
      ).toBe("too-large");
    }
  });

  it("reports the request while it loads or after it fails", () => {
    expect(
      limitedPreviewState({ truncated: true, byteLength: fiveMegabytes, request: "loading" }),
    ).toBe("loading");
    expect(
      limitedPreviewState({ truncated: true, byteLength: fiveMegabytes, request: "failed" }),
    ).toBe("failed");
  });

  it("explains a full read that came back cut", () => {
    // An older server drops the request and answers with the preview again.
    expect(
      limitedPreviewState({ truncated: true, byteLength: fiveMegabytes, request: "loaded" }),
    ).toBe("unsupported");
    // Without a known size, a cut full read means the file passed the cap.
    expect(limitedPreviewState({ truncated: true, byteLength: null, request: "loaded" })).toBe(
      "too-large",
    );
  });
});

describe("rendersAsPlainText", () => {
  it("keeps rich rendering up to a preview's size", () => {
    expect(rendersAsPlainText("a".repeat(FILE_TEXT_PREVIEW_MAX_BYTES))).toBe(false);
    expect(rendersAsPlainText("a".repeat(FILE_TEXT_PREVIEW_MAX_BYTES + 1))).toBe(true);
  });
});
