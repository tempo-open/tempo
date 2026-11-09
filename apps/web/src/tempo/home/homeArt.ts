import type {
  TempoHomeBackground,
  TempoHomeDots,
  TempoHomePictureColors,
  TempoHomePictureEffect,
} from "@t3tools/contracts";

export type HomeTheme = "dark" | "light";
export type HomeLight = "beam" | "crossing" | "trefoil";

/** Your own picture on this device: still being read, none saved, or the saved one as a `blob:` URL. */
export type OwnPicture = "reading" | "none" | { readonly url: string };

interface PictureArt {
  readonly kind: "picture";
  readonly theme: HomeTheme;
  readonly colors: TempoHomePictureColors;
  readonly effect: TempoHomePictureEffect;
}

/** What the home draws behind the typing bar: a light from the Tempo artwork, a picture, or nothing. */
export type HomeArt =
  | {
      readonly kind: "light";
      readonly light: HomeLight;
      readonly theme: HomeTheme;
      readonly dots: TempoHomeDots;
    }
  | (PictureArt & { readonly picture: "own"; readonly url: string })
  | { readonly kind: "plain" };

export interface HomeArtSettings {
  readonly tempoHomeBackground: TempoHomeBackground;
  readonly tempoHomeDots: TempoHomeDots;
  readonly tempoHomePictureEffect: TempoHomePictureEffect;
  readonly tempoHomePictureColors: TempoHomePictureColors;
}

export function resolveHomeArt(
  settings: HomeArtSettings,
  theme: HomeTheme,
  ownPicture: OwnPicture,
): HomeArt {
  const background = settings.tempoHomeBackground;
  const picture = {
    kind: "picture",
    theme,
    colors: settings.tempoHomePictureColors,
    effect: settings.tempoHomePictureEffect,
  } as const;
  switch (background) {
    case "plain":
      return { kind: "plain" };
    case "beam":
    case "crossing":
    case "trefoil":
      return { kind: "light", light: background, theme, dots: settings.tempoHomeDots };
    case "picture":
      // While the picture is read the page stays plain, so the light never shows for a moment first.
      if (ownPicture === "reading") return { kind: "plain" };
      if (ownPicture !== "none") return { ...picture, picture: "own", url: ownPicture.url };
      // A device with no picture of its own keeps the default light.
      return resolveHomeArt({ ...settings, tempoHomeBackground: "auto" }, theme, ownPicture);
    case "auto":
      return {
        kind: "light",
        light: theme === "dark" ? "beam" : "crossing",
        theme,
        dots: settings.tempoHomeDots,
      };
  }
}

export type PaintedHomeArt = Exclude<HomeArt, { kind: "plain" }>;

/** The art's resolution at the design size (1440 by 1028 CSS px), as the mockup's images have it. */
function designSize(art: PaintedHomeArt): { readonly cols: number; readonly rows: number } {
  return art.kind === "light" && art.dots !== "fine"
    ? { cols: 480, rows: 343 }
    : { cols: 720, rows: 514 };
}

/**
 * The art pixel grid that covers a sheet of `width` by `height` device pixels. Every art pixel is
 * `cell` device pixels square, the mockup's cover fit rounded to a whole number, so the art stays
 * crisp at any size and density. Cell edges fall on the sheet's centre line, so a resize keeps
 * every art pixel where it was relative to the middle.
 */
export interface HomeArtGrid {
  readonly cols: number;
  readonly rows: number;
  readonly cell: number;
  /** The grid's top left corner from the sheet's, in device pixels (zero or negative). */
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const middle = (length: number) => Math.floor(length / 2);

export function homeArtGrid(art: PaintedHomeArt, width: number, height: number): HomeArtGrid {
  const design = designSize(art);
  const cell = Math.max(1, Math.round(Math.max(width / design.cols, height / design.rows)));
  const left = middle(width) - Math.ceil(middle(width) / cell) * cell;
  const top = art.kind === "picture" ? 0 : middle(height) - Math.ceil(middle(height) / cell) * cell;
  return {
    cols: Math.ceil((width - left) / cell),
    rows: Math.ceil((height - top) / cell),
    cell,
    left,
    top,
    width,
    height,
  };
}

/** Where a grid painted for one sheet sits on a sheet of another size while a resize settles. */
export function placeHomeArt(
  art: PaintedHomeArt,
  grid: HomeArtGrid,
  width: number,
  height: number,
): { readonly left: number; readonly top: number } {
  return {
    left: middle(width) - (middle(grid.width) - grid.left),
    top: art.kind === "picture" ? 0 : middle(height) - (middle(grid.height) - grid.top),
  };
}

export function homeArtKey(art: PaintedHomeArt, grid: HomeArtGrid): string {
  return `${JSON.stringify(art)} ${grid.width}x${grid.height}`;
}
