/**
 * tempo: DNG photos (raw files such as an iPhone's ProRAW) attach as the JPEG preview the camera
 * embeds, the image Finder and Photos show, since browsers cannot decode the raw data. The preview
 * is rotated the way the DNG says (its own EXIF can disagree), then sized like any other photo.
 *
 * @module dngImage
 */

const DNG_MIME_TYPE = /^image\/(?:x-adobe-)?dng$/i;
const DNG_EXTENSION = /\.dng$/i;

/** Finder hands a DNG over as image/x-adobe-dng; other sources may give it no type. */
export function isDngImageFile(file: Pick<File, "name" | "type">): boolean {
  if (DNG_MIME_TYPE.test(file.type)) return true;
  return (
    (file.type === "" || file.type.toLowerCase() === "application/octet-stream") &&
    DNG_EXTENSION.test(file.name)
  );
}

export interface DngPreview {
  readonly offset: number;
  readonly length: number;
  readonly width: number;
  readonly height: number;
  /** TIFF orientation, 1 to 8, from the DNG's first directory. */
  readonly orientation: number;
}

export type ReadBytes = (offset: number, length: number) => Promise<Uint8Array<ArrayBuffer>>;

const TAG_WIDTH = 0x0100;
const TAG_HEIGHT = 0x0101;
const TAG_COMPRESSION = 0x0103;
const TAG_PHOTOMETRIC = 0x0106;
const TAG_STRIP_OFFSETS = 0x0111;
const TAG_ORIENTATION = 0x0112;
const TAG_STRIP_BYTE_COUNTS = 0x0117;
const TAG_SUB_IFDS = 0x014a;
const TAG_JPEG_OFFSET = 0x0201;
const TAG_JPEG_LENGTH = 0x0202;

const COMPRESSION_OLD_JPEG = 6;
const COMPRESSION_JPEG = 7;
/** Grayscale, RGB and YCbCr: rendered images. Raw data is CFA (32803) or LinearRaw (34892). */
const RENDERED_PHOTOMETRIC = new Set([1, 2, 6]);
const MAX_DIRECTORIES = 32;
const MAX_ENTRIES = 1024;
/** The HEIC path's ceiling: decoding more pixels than this risks the tab's memory. */
const MAX_PREVIEW_PIXELS = 64_000_000;

/**
 * The largest rendered JPEG in a DNG (a TIFF file): IFD0 and its chain, and
 * their SubIFDs. Null when there is none, or the file is not a TIFF it can read.
 */
export async function findDngPreview(read: ReadBytes, size: number): Promise<DngPreview | null> {
  const header = await read(0, 8);
  if (header.length < 8) return null;
  const order = String.fromCharCode(header[0]!, header[1]!);
  if (order !== "II" && order !== "MM") return null;
  const view = (bytes: Uint8Array) =>
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const little = order === "II";
  if (view(header).getUint16(2, little) !== 42) return null;

  let best: DngPreview | null = null;
  let orientation = 1;
  const pending = [{ offset: view(header).getUint32(4, little), isFirst: true }];
  const visited = new Set<number>();
  while (pending.length > 0 && visited.size < MAX_DIRECTORIES) {
    const { offset, isFirst } = pending.shift()!;
    if (offset < 8 || offset + 2 > size || visited.has(offset)) continue;
    visited.add(offset);
    const countBytes = await read(offset, 2);
    if (countBytes.length < 2) continue;
    const count = view(countBytes).getUint16(0, little);
    if (count === 0 || count > MAX_ENTRIES) continue;
    const entries = await read(offset + 2, count * 12 + 4);
    if (entries.length < count * 12 + 4) continue;
    const table = view(entries);
    const tags = new Map<number, number[]>();
    for (let index = 0; index < count; index++) {
      const at = index * 12;
      const tag = table.getUint16(at, little);
      const type = table.getUint16(at + 2, little);
      const valueCount = table.getUint32(at + 4, little);
      // Only SHORT (3), LONG (4) and IFD (13) values matter here.
      const itemBytes = type === 3 ? 2 : type === 4 || type === 13 ? 4 : 0;
      if (itemBytes === 0 || valueCount === 0) continue;
      const wanted = Math.min(valueCount, 64);
      const bytes =
        itemBytes * valueCount <= 4
          ? entries.subarray(at + 8, at + 12)
          : await read(table.getUint32(at + 8, little), itemBytes * wanted);
      if (bytes.length < itemBytes * wanted) continue;
      const values = view(bytes);
      tags.set(
        tag,
        Array.from({ length: wanted }, (_, item) =>
          type === 3 ? values.getUint16(item * 2, little) : values.getUint32(item * 4, little),
        ),
      );
    }
    const first = (tag: number) => tags.get(tag)?.[0];
    if (isFirst) {
      const value = first(TAG_ORIENTATION) ?? 1;
      orientation = value >= 1 && value <= 8 ? value : 1;
    }
    const candidate = previewIn(first, tags);
    if (
      candidate &&
      candidate.offset + candidate.length <= size &&
      candidate.width * candidate.height <= MAX_PREVIEW_PIXELS &&
      (!best || candidate.width * candidate.height > best.width * best.height)
    ) {
      best = { ...candidate, orientation };
    }
    for (const sub of tags.get(TAG_SUB_IFDS) ?? []) pending.push({ offset: sub, isFirst: false });
    const next = table.getUint32(count * 12, little);
    if (next !== 0) pending.push({ offset: next, isFirst: false });
  }
  return best;
}

function previewIn(
  first: (tag: number) => number | undefined,
  tags: ReadonlyMap<number, number[]>,
): Omit<DngPreview, "orientation"> | null {
  const width = first(TAG_WIDTH);
  const height = first(TAG_HEIGHT);
  const compression = first(TAG_COMPRESSION);
  const photometric = first(TAG_PHOTOMETRIC) ?? 6;
  if (!width || !height || !RENDERED_PHOTOMETRIC.has(photometric)) return null;
  const jpegOffset = first(TAG_JPEG_OFFSET);
  const jpegLength = first(TAG_JPEG_LENGTH);
  if (jpegOffset && jpegLength) return { offset: jpegOffset, length: jpegLength, width, height };
  if (compression !== COMPRESSION_JPEG && compression !== COMPRESSION_OLD_JPEG) return null;
  // A JPEG split over strips or tiles is not one file a browser can decode.
  const offsets = tags.get(TAG_STRIP_OFFSETS);
  const lengths = tags.get(TAG_STRIP_BYTE_COUNTS);
  if (offsets?.length !== 1 || lengths?.length !== 1) return null;
  return { offset: offsets[0]!, length: lengths[0]!, width, height };
}

/**
 * The JPEG with `orientation` in its EXIF, so a decoder rotates it: patched in
 * place when the EXIF has the tag, else a minimal EXIF segment after SOI.
 */
export function withJpegOrientation(
  jpeg: Uint8Array<ArrayBuffer>,
  orientation: number,
): Uint8Array<ArrayBuffer> {
  const view = new DataView(jpeg.buffer, jpeg.byteOffset, jpeg.byteLength);
  let at = 2;
  while (at + 4 <= jpeg.length && jpeg[at] === 0xff) {
    const marker = jpeg[at + 1]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = view.getUint16(at + 2);
    const isExif =
      marker === 0xe1 &&
      length >= 16 &&
      String.fromCharCode(...jpeg.subarray(at + 4, at + 10)) === "Exif\0\0";
    if (isExif) {
      const tiff = at + 10;
      const little = jpeg[tiff] === 0x49;
      const ifd = tiff + view.getUint32(tiff + 4, little);
      const count = ifd + 2 <= at + 2 + length ? view.getUint16(ifd, little) : 0;
      for (let index = 0; index < count; index++) {
        const entry = ifd + 2 + index * 12;
        if (entry + 12 > at + 2 + length) break;
        if (view.getUint16(entry, little) === TAG_ORIENTATION) {
          const patched = jpeg.slice();
          new DataView(patched.buffer).setUint16(entry + 8, orientation, little);
          return patched;
        }
      }
      break;
    }
    at += 2 + length;
  }
  if (orientation === 1) return jpeg;
  // APP1 "Exif" with a big-endian TIFF holding one Orientation entry.
  const segment = new Uint8Array([
    0xff,
    0xe1,
    0x00,
    0x22,
    0x45,
    0x78,
    0x69,
    0x66,
    0x00,
    0x00,
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08,
    0x00,
    0x01,
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
    0x00,
  ]);
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2));
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

/** The DNG's preview as a JPEG `File` named after it, or null when it has none. */
export async function dngPreviewFile(file: File): Promise<File | null> {
  const read: ReadBytes = async (offset, length) =>
    new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
  const preview = await findDngPreview(read, file.size).catch(() => null);
  if (!preview) return null;
  const jpeg = await read(preview.offset, preview.length);
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8) return null;
  const name = `${(file.name || "image").replace(DNG_EXTENSION, "")}.jpg`;
  return new File([withJpegOrientation(jpeg, preview.orientation)], name, {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
}
