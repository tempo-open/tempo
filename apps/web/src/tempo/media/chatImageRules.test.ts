import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { chatImageFile, newTabTarget } from "./chatImageRules";

describe("chatImageFile", () => {
  it("accepts a supported image and keeps its type", () => {
    const file = chatImageFile(new Blob(["x"], { type: "image/png" }), "shot.png");
    expect(file).toBeInstanceOf(File);
    expect((file as File).type).toBe("image/png");
  });

  it("infers the type from the name when the server sends none", () => {
    const file = chatImageFile(new Blob(["x"]), "shot.jpg");
    expect((file as File).type).toBe("image/jpeg");
  });

  it("refuses an unsupported image with the composer's wording", () => {
    // The composer now attaches an SVG as a file, so this uses a type it still refuses.
    expect(chatImageFile(new Blob(["x"], { type: "image/jxl" }), "photo.jxl")).toBe(
      "'photo.jxl' is not a supported image type. Attach DNG, GIF, HEIC, HEIF, JPEG, PNG, or WebP images.",
    );
  });

  it("refuses bytes that are not an image", () => {
    expect(chatImageFile(new Blob(["x"], { type: "text/html" }), "image")).toBe(
      "This image type can't be added to chat.",
    );
    expect(chatImageFile(new Blob(["x"]), "image")).toBe("This image type can't be added to chat.");
  });
});

describe("newTabTarget", () => {
  const asset = {
    environmentId: "env" as EnvironmentId,
    resource: { _tag: "attachment", attachmentId: "a1" },
  } as const;

  it("opens a GitHub image at its original address, not the proxy", () => {
    const source = {
      src: "https://env.test/api/assets/signed?token=t",
      asset,
      reference: { kind: "url", url: "https://github.com/user-attachments/assets/1" },
    } as const;
    const expected = { kind: "url", url: "https://github.com/user-attachments/assets/1" };
    expect(newTabTarget(source, true)).toEqual(expected);
    expect(newTabTarget(source, false)).toEqual(expected);
  });

  it("gives a server image's signed link only to the in-app browser", () => {
    const source = { src: "https://env.test/api/assets/signed?token=t", asset } as const;
    expect(newTabTarget(source, true)).toEqual({ kind: "asset" });
    expect(newTabTarget(source, false)).toBeNull();
  });

  it("opens a plain web image anywhere and never a page-local URL", () => {
    expect(newTabTarget({ src: "https://cdn.test/a.png" }, false)).toEqual({
      kind: "url",
      url: "https://cdn.test/a.png",
    });
    expect(newTabTarget({ src: "blob:https://app/1" }, true)).toBeNull();
    expect(newTabTarget({ src: null }, true)).toBeNull();
  });
});
