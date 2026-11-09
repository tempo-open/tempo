import { describe, expect, it } from "vite-plus/test";

import { buildMediaMenuItems, type MediaMenuInput } from "./mediaMenu";

const base: MediaMenuInput = {
  kind: "image",
  reference: undefined,
  isUnavailable: false,
  canReadMedia: true,
  canCopyImage: true,
  canOpenInNewTab: true,
  canAddToChat: true,
  revealLabel: undefined,
  hasOpenFile: false,
};

const labels = (input: MediaMenuInput) =>
  buildMediaMenuItems(input).map((item) =>
    item.separatorBefore === true ? `--- ${item.label}` : item.label,
  );

describe("buildMediaMenuItems", () => {
  it("leads a local file image with the chat items, then the file extras", () => {
    expect(
      labels({
        ...base,
        reference: { kind: "file", path: "/repo/shot.png", relativePath: "shot.png" },
        revealLabel: "Reveal in Finder",
        hasOpenFile: true,
      }),
    ).toEqual([
      "Open image in new tab",
      "Add to chat",
      "Copy image",
      "Reveal in Finder",
      "Download a copy",
      "--- Copy full path",
      "Copy relative path",
      "Open in file viewer",
    ]);
  });

  it("offers no reveal for a web image", () => {
    expect(
      labels({
        ...base,
        reference: { kind: "url", url: "https://cdn.test/shot.png" },
        revealLabel: "Reveal in Finder",
      }),
    ).toEqual([
      "Open image in new tab",
      "Add to chat",
      "Copy image",
      "Download a copy",
      "--- Copy URL",
    ]);
  });

  it("hides Add to chat and the new tab when they cannot work", () => {
    expect(labels({ ...base, canAddToChat: false, canOpenInNewTab: false })).toEqual([
      "Copy image",
      "Download a copy",
    ]);
  });

  it("gives a video only the download and its extras", () => {
    expect(
      labels({
        ...base,
        kind: "video",
        reference: { kind: "file", path: "/repo/clip.mp4" },
        revealLabel: "Reveal in Finder",
      }),
    ).toEqual(["Download a copy", "--- Copy full path"]);
  });

  it("disables byte actions while the connection may not read the media", () => {
    const items = buildMediaMenuItems({
      ...base,
      isUnavailable: true,
      canReadMedia: false,
      reference: { kind: "file", path: "/repo/shot.png", relativePath: "shot.png" },
      revealLabel: "Reveal in Finder",
      hasOpenFile: true,
    });
    const disabled = Object.fromEntries(items.map((item) => [item.id, item.disabled === true]));
    expect(disabled).toEqual({
      "open-in-new-tab": true,
      "add-to-chat": true,
      "copy-image": true,
      "reveal-in-folder": false,
      save: true,
      "copy-full-path": false,
      "copy-relative-path": false,
      "open-file": true,
    });
  });
});
