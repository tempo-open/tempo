import type { HomeArtGrid, PaintedHomeArt } from "./homeArt";
import { paintLight, paintPicture, picturePalette } from "./paintHomeArt";

export interface HomeArtRequest {
  readonly id: number;
  readonly art: PaintedHomeArt;
  readonly grid: HomeArtGrid;
  readonly source: string;
}

export type HomeArtResponse =
  | { readonly id: number; readonly bitmap: ImageBitmap }
  | { readonly id: number; readonly error: string };

/** The light and your own picture; a replaced picture's source drops out. */
const SOURCES_KEPT = 2;
const sources = new Map<string, Promise<ImageBitmap>>();
const palettes = new Map<string, ReturnType<typeof picturePalette>>();

function load(url: string) {
  const source =
    sources.get(url) ??
    fetch(url)
      .then((response) => response.blob())
      .then((blob) => createImageBitmap(blob));
  sources.delete(url);
  sources.set(url, source);
  for (const [oldUrl, old] of sources) {
    if (sources.size <= SOURCES_KEPT) break;
    sources.delete(oldUrl);
    palettes.delete(oldUrl);
    void old.then((image) => image.close()).catch(() => undefined);
  }
  return source;
}

self.addEventListener("message", (event: MessageEvent<HomeArtRequest>) => {
  const { id, art, grid, source } = event.data;
  void load(source)
    .then((image) => {
      if (art.kind === "light") return paintLight(art, grid, image);
      let palette = palettes.get(source);
      if (!palette) {
        palette = picturePalette(image);
        palettes.set(source, palette);
      }
      return paintPicture(art, grid, image, palette);
    })
    .then(
      (bitmap) =>
        self.postMessage({ id, bitmap } satisfies HomeArtResponse, { transfer: [bitmap] }),
      (error: unknown) => {
        sources.delete(source);
        self.postMessage({ id, error: String(error) } satisfies HomeArtResponse);
      },
    );
});
