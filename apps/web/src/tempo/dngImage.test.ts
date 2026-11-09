import { describe, expect, it } from "vite-plus/test";

import { classifyComposerAttachmentFile } from "../components/chat/composerAttachmentFiles";
import {
  dngPreviewFile,
  findDngPreview,
  isDngImageFile,
  withJpegOrientation,
  type ReadBytes,
} from "./dngImage";

type Value = number | { readonly blob: number } | { readonly ifd: number };
interface Ifd {
  readonly entries: ReadonlyArray<{ tag: number; type: 3 | 4; values: ReadonlyArray<Value> }>;
  readonly next?: number;
}

/** A TIFF laid out as header, directories (with their overflow values), then blobs. */
function buildTiff(little: boolean, ifds: ReadonlyArray<Ifd>, blobs: ReadonlyArray<Uint8Array>) {
  const width = (type: 3 | 4) => (type === 3 ? 2 : 4);
  const overflow = (ifd: Ifd) =>
    ifd.entries.reduce((sum, entry) => {
      const bytes = entry.values.length * width(entry.type);
      return sum + (bytes > 4 ? bytes : 0);
    }, 0);
  const ifdOffsets: number[] = [];
  let at = 8;
  for (const ifd of ifds) {
    ifdOffsets.push(at);
    at += 2 + ifd.entries.length * 12 + 4 + overflow(ifd);
  }
  const blobOffsets = blobs.map((blob) => {
    const offset = at;
    at += blob.length;
    return offset;
  });
  const out = new Uint8Array(at);
  const view = new DataView(out.buffer);
  out.set(little ? [0x49, 0x49] : [0x4d, 0x4d]);
  view.setUint16(2, 42, little);
  view.setUint32(4, ifdOffsets[0] ?? 0, little);
  const resolve = (value: Value) =>
    typeof value === "number"
      ? value
      : "blob" in value
        ? blobOffsets[value.blob]!
        : ifdOffsets[value.ifd]!;
  ifds.forEach((ifd, index) => {
    const start = ifdOffsets[index]!;
    let extra = start + 2 + ifd.entries.length * 12 + 4;
    view.setUint16(start, ifd.entries.length, little);
    ifd.entries.forEach((entry, entryIndex) => {
      const position = start + 2 + entryIndex * 12;
      const size = width(entry.type);
      view.setUint16(position, entry.tag, little);
      view.setUint16(position + 2, entry.type, little);
      view.setUint32(position + 4, entry.values.length, little);
      let base = position + 8;
      if (entry.values.length * size > 4) {
        view.setUint32(position + 8, extra, little);
        base = extra;
        extra += entry.values.length * size;
      }
      entry.values.forEach((value, item) => {
        if (size === 2) view.setUint16(base + item * 2, resolve(value), little);
        else view.setUint32(base + item * 4, resolve(value), little);
      });
    });
    const nextOffset = ifd.next === undefined ? 0 : ifdOffsets[ifd.next]!;
    view.setUint32(start + 2 + ifd.entries.length * 12, nextOffset, little);
  });
  blobs.forEach((blob, index) => out.set(blob, blobOffsets[index]!));
  return { bytes: out, blobOffsets };
}

const reader =
  (bytes: Uint8Array): ReadBytes =>
  async (offset, length) =>
    bytes.slice(offset, offset + length);

/** SOI, a JFIF APP0, then EOI: enough for offsets and the SOI check. */
function fakeJpeg(fill: number, size = 32) {
  const jpeg = new Uint8Array(size).fill(fill);
  jpeg.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00]);
  jpeg.set([0xff, 0xd9], size - 2);
  return jpeg;
}

const entry = (tag: number, type: 3 | 4, ...values: Value[]) => ({ tag, type, values });

/** An iPhone ProRAW layout: a JPEG preview in IFD0, the raw and two masks in SubIFDs. */
function proRaw(little: boolean, orientation = 6) {
  const preview = fakeJpeg(0x11, 64);
  return buildTiff(
    little,
    [
      {
        entries: [
          entry(0x00fe, 4, 1),
          entry(0x0100, 4, 4032),
          entry(0x0101, 4, 3024),
          entry(0x0103, 3, 7),
          entry(0x0106, 3, 6),
          entry(0x0111, 4, { blob: 0 }),
          entry(0x0112, 3, orientation),
          entry(0x0117, 4, preview.length),
          entry(0x014a, 4, { ifd: 1 }, { ifd: 2 }),
        ],
      },
      {
        entries: [
          entry(0x00fe, 4, 0),
          entry(0x0100, 4, 8064),
          entry(0x0101, 4, 6048),
          entry(0x0103, 3, 7),
          entry(0x0106, 3, 34892),
          entry(0x0111, 4, { blob: 1 }),
          entry(0x0117, 4, 32),
        ],
      },
      {
        entries: [
          entry(0x00fe, 4, 65540),
          entry(0x0100, 4, 2016),
          entry(0x0101, 4, 1512),
          entry(0x0103, 3, 34892),
          entry(0x0106, 3, 52527),
          entry(0x0111, 4, { blob: 1 }),
          entry(0x0117, 4, 32),
        ],
      },
    ],
    [preview, fakeJpeg(0x22)],
  );
}

describe("isDngImageFile", () => {
  it("accepts DNG MIME types, and the extension when the type is missing", () => {
    expect(isDngImageFile({ name: "IMG_1.DNG", type: "image/x-adobe-dng" })).toBe(true);
    expect(isDngImageFile({ name: "photo", type: "image/dng" })).toBe(true);
    expect(isDngImageFile({ name: "IMG_1.DNG", type: "" })).toBe(true);
    expect(isDngImageFile({ name: "IMG_1.dng", type: "application/octet-stream" })).toBe(true);
    expect(isDngImageFile({ name: "IMG_1.dng", type: "image/jpeg" })).toBe(false);
    expect(isDngImageFile({ name: "IMG_1.jpg", type: "" })).toBe(false);
  });

  it("puts a dropped DNG on the image path instead of refusing it", () => {
    expect(
      classifyComposerAttachmentFile({ name: "IMG_7843.DNG", type: "image/x-adobe-dng" }),
    ).toBe("image");
  });
});

describe("findDngPreview", () => {
  it.each([false, true])("finds an iPhone ProRAW preview (little-endian: %s)", async (little) => {
    const { bytes, blobOffsets } = proRaw(little);
    expect(await findDngPreview(reader(bytes), bytes.length)).toEqual({
      offset: blobOffsets[0],
      length: 64,
      width: 4032,
      height: 3024,
      orientation: 6,
    });
  });

  it("takes the largest rendered JPEG, from SubIFDs, strips or an old-style JPEG", async () => {
    const thumbnail = fakeJpeg(0x33);
    const medium = fakeJpeg(0x44, 48);
    const { bytes, blobOffsets } = buildTiff(
      true,
      [
        {
          entries: [
            entry(0x00fe, 4, 1),
            entry(0x0100, 3, 256),
            entry(0x0101, 3, 171),
            entry(0x0103, 3, 1),
            entry(0x0106, 3, 2),
            entry(0x014a, 4, { ifd: 1 }),
          ],
          next: 2,
        },
        {
          entries: [
            entry(0x0100, 4, 1024),
            entry(0x0101, 4, 683),
            entry(0x0103, 3, 7),
            entry(0x0106, 3, 6),
            entry(0x0111, 4, { blob: 1 }),
            entry(0x0117, 4, medium.length),
          ],
        },
        {
          entries: [
            entry(0x0100, 4, 160),
            entry(0x0101, 4, 120),
            entry(0x0201, 4, { blob: 0 }),
            entry(0x0202, 4, thumbnail.length),
          ],
        },
      ],
      [thumbnail, medium],
    );
    expect(await findDngPreview(reader(bytes), bytes.length)).toMatchObject({
      offset: blobOffsets[1],
      length: medium.length,
      width: 1024,
      orientation: 1,
    });
  });

  it("skips raw data, previews split over strips, and anything that is not a TIFF", async () => {
    const raw = buildTiff(
      false,
      [
        {
          entries: [
            entry(0x0100, 4, 4000),
            entry(0x0101, 4, 3000),
            entry(0x0103, 3, 7),
            entry(0x0106, 3, 32803),
            entry(0x0111, 4, { blob: 0 }),
            entry(0x0117, 4, 32),
          ],
        },
      ],
      [fakeJpeg(0x55)],
    );
    expect(await findDngPreview(reader(raw.bytes), raw.bytes.length)).toBeNull();

    const strips = buildTiff(
      false,
      [
        {
          entries: [
            entry(0x0100, 4, 640),
            entry(0x0101, 4, 480),
            entry(0x0103, 3, 7),
            entry(0x0106, 3, 6),
            entry(0x0111, 4, { blob: 0 }, { blob: 1 }),
            entry(0x0117, 4, 32, 32),
          ],
        },
      ],
      [fakeJpeg(0x66), fakeJpeg(0x77)],
    );
    expect(await findDngPreview(reader(strips.bytes), strips.bytes.length)).toBeNull();

    const jpeg = fakeJpeg(0x88);
    expect(await findDngPreview(reader(jpeg), jpeg.length)).toBeNull();
  });

  it("stops on a directory chain that loops", async () => {
    const { bytes } = buildTiff(
      true,
      [{ entries: [entry(0x0100, 4, 10), entry(0x0101, 4, 10)], next: 0 }],
      [],
    );
    expect(await findDngPreview(reader(bytes), bytes.length)).toBeNull();
  });
});

/** A JPEG whose EXIF IFD0 holds one Orientation entry. */
function jpegWithExifOrientation(little: boolean, orientation: number) {
  const exif = buildTiff(little, [{ entries: [entry(0x0112, 3, orientation)] }], []).bytes;
  const segment = new Uint8Array(4 + 6 + exif.length);
  new DataView(segment.buffer).setUint16(0, 0xffe1);
  new DataView(segment.buffer).setUint16(2, 2 + 6 + exif.length);
  segment.set([0x45, 0x78, 0x69, 0x66, 0x00, 0x00], 4);
  segment.set(exif, 10);
  const body = fakeJpeg(0x99);
  return new Uint8Array([...body.subarray(0, 2), ...segment, ...body.subarray(2)]);
}

const exifOrientation = (jpeg: Uint8Array): number | null => {
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  if (view.getUint16(2) !== 0xffe1) return null;
  const tiff = 12;
  const little = jpeg[tiff] === 0x49;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  return view.getUint16(ifd + 2 + 8, little);
};

describe("withJpegOrientation", () => {
  it.each([false, true])("rewrites an EXIF orientation in place (little-endian: %s)", (little) => {
    const jpeg = jpegWithExifOrientation(little, 1);
    const rotated = withJpegOrientation(jpeg, 6);
    expect(rotated.length).toBe(jpeg.length);
    expect(exifOrientation(rotated)).toBe(6);
    expect(exifOrientation(jpeg)).toBe(1);
  });

  it("adds an EXIF segment when the JPEG has none, and leaves an upright one alone", () => {
    const jpeg = fakeJpeg(0xaa);
    expect(exifOrientation(withJpegOrientation(jpeg, 8))).toBe(8);
    expect(withJpegOrientation(jpeg, 1)).toBe(jpeg);
  });
});

describe("dngPreviewFile", () => {
  it("returns the preview as a rotated JPEG named after the DNG", async () => {
    const { bytes } = proRaw(false);
    const file = new File([bytes], "IMG_7843.DNG", { type: "image/x-adobe-dng" });
    const preview = await dngPreviewFile(file);
    expect(preview?.name).toBe("IMG_7843.jpg");
    expect(preview?.type).toBe("image/jpeg");
    const jpeg = new Uint8Array(await preview!.arrayBuffer());
    expect([jpeg[0], jpeg[1]]).toEqual([0xff, 0xd8]);
    expect(exifOrientation(jpeg)).toBe(6);
  });

  it("returns null for a DNG without a usable preview", async () => {
    const file = new File([fakeJpeg(0xbb)], "broken.dng", { type: "image/x-adobe-dng" });
    expect(await dngPreviewFile(file)).toBeNull();
  });
});
