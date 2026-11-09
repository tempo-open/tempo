import type { HomeArt, HomeArtGrid, HomeLight, HomeTheme } from "./homeArt";

type LightArt = Extract<HomeArt, { kind: "light" }>;
type PictureArt = Extract<HomeArt, { kind: "picture" }>;
type Rgb = readonly [number, number, number];

/**
 * Where each light sits in the Tempo artwork, as fractions of its side: the view's centre, its
 * width at the design aspect, and its turn in degrees, as the Tempo design mockup places them.
 * The view covers the sheet as the mockup's cover fit does: a sheet wider than the design aspect
 * crops the view's top and bottom, a narrower one its sides.
 */
const LIGHTS: Record<HomeLight, { x: number; y: number; width: number; turn: number }> = {
  beam: { x: 0.48, y: 0.85, width: 2300 / 4096, turn: -26 },
  crossing: { x: 0.5, y: 0.905, width: 2500 / 4096, turn: 0 },
  trefoil: { x: 0.4, y: 0.44, width: 5000 / 4096, turn: -8 },
};
const DESIGN_ASPECT = 480 / 343;
/** The Trefoil shows the whole mark, so the icon's faint rounded square edge is cut by this disc. */
const TREFOIL_DISC = { x: 0.5, y: 0.515, radius: 0.43 };

const hexes = (...list: string[]): Rgb[] =>
  list.map((hex) => [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]);

const BLUE: Record<HomeTheme, Rgb[]> = {
  dark: hexes(
    "#020308",
    "#04081a",
    "#081536",
    "#0f2463",
    "#183a9e",
    "#2552d6",
    "#3f74ff",
    "#7aa6ff",
    "#bcd4ff",
    "#ffffff",
  ),
  light: hexes(
    "#ffffff",
    "#f3f6ff",
    "#dfe8ff",
    "#bccfff",
    "#8faeff",
    "#5a85f5",
    "#2f5fe0",
    "#1d44b8",
    "#132f86",
    "#0b1d58",
  ),
};
const LIGHT_DOTS: Record<HomeTheme, Rgb[]> = {
  dark: hexes("#07122e", "#0a1838", "#081a3a", "#0d1442", "#10245e", "#0b2a55"),
  light: hexes("#e9effe", "#e3eafd", "#edf2ff", "#e6ecfe", "#dbe5fd", "#eef3ff"),
};
const PICTURE_DOTS: Record<HomeTheme, Rgb[]> = {
  dark: hexes("#0a1a4a", "#10276a", "#0c2f5e", "#1a1f5c", "#1d3fb0", "#0d3b73"),
  light: hexes("#cfdcff", "#bfd0ff", "#d8e4ff", "#c6d8ff", "#a9c1ff", "#dbe6ff"),
};
const DOT_SHARE = { many: 1, few: 0.25, none: 0, fine: 0 } as const;

const BAYER = (() => {
  let matrix = [[0]];
  for (let size = 1; size < 8; size *= 2) {
    const next: number[][] = [];
    for (let y = 0; y < size * 2; y++) {
      const row: number[] = [];
      for (let x = 0; x < size * 2; x++) {
        const quadrant = [
          [0, 2],
          [3, 1],
        ][Math.floor(y / size)]![Math.floor(x / size)]!;
        row.push(matrix[y % size]![x % size]! * 4 + quadrant);
      }
      next.push(row);
    }
    matrix = next;
  }
  return matrix.map((row) => row.map((value) => (value + 0.5) / 64));
})();

/**
 * White noise keyed by an art pixel's place from the sheet's centre, so a resize that keeps the
 * pixel size keeps every grain where it was.
 */
function noise(x: number, y: number, salt: number): number {
  let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(salt, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function canvasFor(grid: HomeArtGrid) {
  const canvas = new OffscreenCanvas(grid.cols, grid.rows);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas in this worker.");
  context.imageSmoothingQuality = "high";
  return { canvas, context };
}

/** The sheet's centre, in art pixels from the grid's corner. */
function sheetCenter(grid: HomeArtGrid) {
  return {
    centerX: (grid.width / 2 - grid.left) / grid.cell,
    centerY: (grid.height / 2 - grid.top) / grid.cell,
  };
}

export function paintLight(art: LightArt, grid: HomeArtGrid, artwork: ImageBitmap): ImageBitmap {
  const { canvas, context } = canvasFor(grid);
  const light = LIGHTS[art.light];
  const side = artwork.width;
  const { centerX, centerY } = sheetCenter(grid);
  const artPixelsPerSide =
    Math.max(grid.width, grid.height * DESIGN_ASPECT) / grid.cell / light.width;
  context.translate(centerX, centerY);
  context.rotate((-light.turn * Math.PI) / 180);
  context.scale(artPixelsPerSide / side, artPixelsPerSide / side);
  context.translate(-light.x * side, -light.y * side);
  context.drawImage(artwork, 0, 0);
  if (art.light === "trefoil") {
    context.globalCompositeOperation = "destination-in";
    context.beginPath();
    context.arc(
      TREFOIL_DISC.x * side,
      TREFOIL_DISC.y * side,
      TREFOIL_DISC.radius * side,
      0,
      2 * Math.PI,
    );
    context.fill();
  }
  const image = context.getImageData(0, 0, grid.cols, grid.rows);
  const pixels = image.data;
  const palette = BLUE[art.theme];
  const dots = LIGHT_DOTS[art.theme];
  const top = palette.length - 1;
  const dotShare = DOT_SHARE[art.dots];
  const sparkShare = (art.theme === "dark" ? 0.0016 : 0.0008) * dotShare;
  const offsetX = Math.floor(centerX);
  const offsetY = Math.floor(centerY);
  for (let y = 0; y < grid.rows; y++) {
    for (let x = 0; x < grid.cols; x++) {
      const i = (y * grid.cols + x) * 4;
      const lum = (pixels[i]! / 255) * (pixels[i + 3]! / 255);
      const nx = x - offsetX;
      const ny = y - offsetY;
      const level = lum * top + (noise(nx, ny, 1) - 0.5) * 1.15;
      const index = Math.max(0, Math.min(top, Math.round(level)));
      let color = palette[index]!;
      const near = Math.min(1, lum * 3);
      const dotChance = (art.theme === "dark" ? 0.1 + 0.12 * near : 0.07 + 0.08 * near) * dotShare;
      if (index <= 2 && noise(nx, ny, 2) < dotChance) {
        color = dots[Math.floor(noise(nx, ny, 3) * dots.length)]!;
      }
      if (index <= 1 && noise(nx, ny, 4) < sparkShare) color = palette[4]!;
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
      pixels[i + 3] = 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.transferToImageBitmap();
}

/** Sixteen colours of the picture by median cut, plus black and a near black for its shadows. */
export function picturePalette(picture: ImageBitmap): Rgb[] {
  const width = 240;
  const height = Math.max(1, Math.round((picture.height / picture.width) * width));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("No 2D canvas in this worker.");
  context.drawImage(picture, 0, 0, width, height);
  const data = context.getImageData(0, 0, width, height).data;
  const sample: Rgb[] = [];
  for (let i = 0; i < data.length; i += 4) {
    sample.push([data[i]!, data[i + 1]!, data[i + 2]!]);
  }
  const boxes: Rgb[][] = [sample];
  while (boxes.length < 16) {
    let widest = -1;
    let boxIndex = -1;
    let channel = 0;
    boxes.forEach((box, index) => {
      if (box.length < 2) return;
      for (let c = 0; c < 3; c++) {
        let low = 255;
        let high = 0;
        for (const pixel of box) {
          low = Math.min(low, pixel[c]!);
          high = Math.max(high, pixel[c]!);
        }
        if (high - low > widest) {
          widest = high - low;
          boxIndex = index;
          channel = c;
        }
      }
    });
    if (boxIndex < 0) break;
    const sorted = boxes[boxIndex]!.toSorted((a, b) => a[channel]! - b[channel]!);
    const middle = sorted.length >> 1;
    boxes.splice(boxIndex, 1, sorted.slice(0, middle), sorted.slice(middle));
  }
  const palette = boxes.map((box): Rgb => {
    const sum = box.reduce(
      (total, pixel) => [total[0] + pixel[0], total[1] + pixel[1], total[2] + pixel[2]],
      [0, 0, 0],
    );
    return [sum[0] / box.length, sum[1] / box.length, sum[2] / box.length];
  });
  return [...palette, [0, 0, 0], [5, 5, 8]];
}

/** Dissolve: down the sheet each pixel stays only while the ordered threshold is under the fade; gone by 76%. */
function dissolveAlpha(x: number, y: number, depth: number): number {
  const u = Math.min(1, Math.max(0, (depth - 0.2) / 0.56));
  const keep = 1 - u * u * (3 - 2 * u);
  return BAYER[y & 7]![x & 7]! < keep ? Math.round(255 * (0.45 + 0.55 * keep)) : 0;
}

export function paintPicture(
  art: PictureArt,
  grid: HomeArtGrid,
  picture: ImageBitmap,
  palette: readonly Rgb[],
): ImageBitmap {
  const { canvas, context } = canvasFor(grid);
  const { centerX } = sheetCenter(grid);
  const scale = Math.max(grid.width / picture.width, grid.height / picture.height) / grid.cell;
  const drawnWidth = picture.width * scale;
  context.drawImage(picture, centerX - drawnWidth / 2, 0, drawnWidth, picture.height * scale);
  const image = context.getImageData(0, 0, grid.cols, grid.rows);
  const pixels = image.data;
  const blue = BLUE[art.theme];
  const dots = PICTURE_DOTS[art.theme];
  const top = blue.length - 1;
  for (let y = 0; y < grid.rows; y++) {
    const depth = (grid.top + (y + 0.5) * grid.cell) / grid.height;
    for (let column = 0; column < grid.cols; column++) {
      const i = (y * grid.cols + column) * 4;
      const x = column - Math.floor(centerX);
      let color: Rgb;
      if (art.colors === "blue") {
        const lum = (0.2126 * pixels[i]! + 0.7152 * pixels[i + 1]! + 0.0722 * pixels[i + 2]!) / 255;
        const index = Math.max(
          0,
          Math.min(top, Math.round(lum * top + (noise(x, y, 5) - 0.5) * 1.15)),
        );
        color = blue[index]!;
        if (index <= 2 && noise(x, y, 6) < 0.13 + 0.2 * Math.min(1, lum * 3)) {
          color = dots[Math.floor(noise(x, y, 7) * dots.length)]!;
        }
      } else {
        const offset = (BAYER[y & 7]![x & 7]! - 0.5) * 0.16 * 255;
        const r = pixels[i]! + offset;
        const g = pixels[i + 1]! + offset;
        const b = pixels[i + 2]! + offset;
        color = palette[0]!;
        let nearest = Number.POSITIVE_INFINITY;
        for (const candidate of palette) {
          const distance =
            (candidate[0] - r) ** 2 + (candidate[1] - g) ** 2 + (candidate[2] - b) ** 2;
          if (distance < nearest) {
            nearest = distance;
            color = candidate;
          }
        }
      }
      pixels[i] = color[0];
      pixels[i + 1] = color[1];
      pixels[i + 2] = color[2];
      pixels[i + 3] = art.effect === "dissolve" ? dissolveAlpha(x, y, depth) : 255;
    }
  }
  context.putImageData(image, 0, 0);
  return canvas.transferToImageBitmap();
}
