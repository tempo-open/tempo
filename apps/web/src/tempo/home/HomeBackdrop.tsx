import type { ClientSettings } from "@t3tools/contracts/settings";
import { useLayoutEffect, useRef, type ComponentProps } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";

import tempoLightUrl from "./art/tempo-light.webp";
import {
  homeArtGrid,
  homeArtKey,
  placeHomeArt,
  resolveHomeArt,
  type HomeArtGrid,
  type HomeTheme,
  type PaintedHomeArt,
} from "./homeArt";
import type { HomeArtRequest, HomeArtResponse } from "./homeArt.worker";
import { useOwnPicture } from "./homePicture";

/** Room for the home, the preview in Settings, Appearance and its six thumbnails. */
const CACHE_SIZE = 12;

interface Paint {
  readonly bitmap: Promise<ImageBitmap>;
  /** The bitmap has arrived, so the art shows at once instead of fading in. */
  ready: boolean;
}

let worker: Worker | null = null;
let nextRequestId = 0;
const waiting = new Map<number, (response: HomeArtResponse) => void>();
const paintCache = new Map<string, Paint>();

function artWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL("./homeArt.worker.ts", import.meta.url), { type: "module" });
  worker.addEventListener("message", (event: MessageEvent<HomeArtResponse>) => {
    waiting.get(event.data.id)?.(event.data);
    waiting.delete(event.data.id);
  });
  // The worker catches its own errors, so this is a script that did not load: the home stays plain.
  worker.addEventListener("error", () => {
    for (const [id, settle] of waiting) settle({ id, error: "The home art worker did not load." });
    waiting.clear();
  });
  return worker;
}

/** The art for one sheet size, painted off the main thread; the last few stay for a theme or page switch. */
function paintHomeArt(art: PaintedHomeArt, grid: HomeArtGrid, source: string): Paint {
  const key = homeArtKey(art, grid);
  const hit = paintCache.get(key);
  if (hit) {
    paintCache.delete(key);
    paintCache.set(key, hit);
    return hit;
  }
  const id = nextRequestId++;
  const bitmap = new Promise<ImageBitmap>((resolve, reject) => {
    waiting.set(id, (response) =>
      "bitmap" in response ? resolve(response.bitmap) : reject(new Error(response.error)),
    );
  });
  const paint: Paint = { bitmap, ready: false };
  paintCache.set(key, paint);
  bitmap.then(
    () => {
      paint.ready = true;
    },
    () => paintCache.delete(key),
  );
  for (const [oldKey, old] of paintCache) {
    if (paintCache.size <= CACHE_SIZE) break;
    paintCache.delete(oldKey);
    void old.bitmap.then((image) => image.close()).catch(() => undefined);
  }
  artWorker().postMessage({ id, art, grid, source } satisfies HomeArtRequest);
  return paint;
}

const selectHomeArtSettings = (settings: ClientSettings) => ({
  tempoHomeBackground: settings.tempoHomeBackground,
  tempoHomeDots: settings.tempoHomeDots,
  tempoHomePictureEffect: settings.tempoHomePictureEffect,
  tempoHomePictureColors: settings.tempoHomePictureColors,
});

/**
 * `art` filling its box, a whole number of device pixels per art pixel. The box must be sized by
 * its parent; the canvas inside is placed by the art's grid (home.css, `data-tempo-home-art-layer`).
 */
export function HomeArtCanvas({
  art,
  ...props
}: { readonly art: PaintedHomeArt } & ComponentProps<"div">) {
  const source = art.kind === "light" ? tempoLightUrl : art.url;
  const boxRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Observing before the first frame lets art painted earlier show in that frame.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- paints the art in a worker for the box's device pixel size, again on every resize
  useLayoutEffect(() => {
    const box = boxRef.current;
    const canvas = canvasRef.current;
    if (!box || !canvas) return;
    let boxSize: { width: number; height: number; pixelRatio: number } | null = null;
    let shown: HomeArtGrid | null = null;
    let attempted = "";
    let painting = false;
    let disposed = false;

    const place = () => {
      if (!shown || !boxSize) return;
      const { left, top } = placeHomeArt(art, shown, boxSize.width, boxSize.height);
      const ratio = boxSize.pixelRatio;
      canvas.style.left = `${left / ratio}px`;
      canvas.style.top = `${top / ratio}px`;
      canvas.style.width = `${(shown.cols * shown.cell) / ratio}px`;
      canvas.style.height = `${(shown.rows * shown.cell) / ratio}px`;
    };
    // One paint at a time; a resize meanwhile paints its latest size next.
    const paintLatest = () => {
      if (!boxSize || painting || disposed) return;
      const grid = homeArtGrid(art, boxSize.width, boxSize.height);
      const size = `${grid.width}x${grid.height}`;
      if (size === attempted) return;
      attempted = size;
      painting = true;
      const paint = paintHomeArt(art, grid, source);
      const fresh = !paint.ready;
      void paint.bitmap
        .then(
          (bitmap) => {
            if (disposed) return;
            canvas.width = grid.cols;
            canvas.height = grid.rows;
            canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
            shown = grid;
            place();
            if (fresh) canvas.dataset.fade = "";
            canvas.dataset.painted = "";
          },
          () => {
            if (!disposed) delete canvas.dataset.painted;
          },
        )
        .finally(() => {
          painting = false;
          paintLatest();
        });
    };

    // observeResize has no device pixel box, and nothing here sets React state.
    // oxlint-disable-next-line t3code/no-raw-resize-observer -- observes the box in device pixels
    const observer = new ResizeObserver(([entry]) => {
      const css = entry?.contentBoxSize[0];
      if (!css || css.inlineSize === 0 || css.blockSize === 0) return;
      // Safari reports no device pixel box; there the ratio is the window's.
      const device = entry.devicePixelContentBoxSize?.[0];
      const pixelRatio = device ? device.inlineSize / css.inlineSize : window.devicePixelRatio;
      boxSize = {
        width: Math.round(device?.inlineSize ?? css.inlineSize * pixelRatio),
        height: Math.round(device?.blockSize ?? css.blockSize * pixelRatio),
        pixelRatio,
      };
      place();
      paintLatest();
    });
    try {
      observer.observe(box, { box: "device-pixel-content-box" });
    } catch {
      observer.observe(box);
    }
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [art, source]);

  return (
    <div ref={boxRef} data-tempo-home-art-layer {...props}>
      <canvas ref={canvasRef} />
    </div>
  );
}

/**
 * The home page's background: the chosen art for the app's theme, or for `theme` (the preview in
 * Settings, Appearance).
 */
export function HomeBackdrop({ theme }: { readonly theme?: HomeTheme }) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings(selectHomeArtSettings);
  // The saved picture is read only for a home that shows it.
  const ownPicture = useOwnPicture(settings.tempoHomeBackground === "picture");
  const art = resolveHomeArt(settings, theme ?? resolvedTheme, ownPicture);
  return (
    <div
      aria-hidden
      data-tempo-home-art={art.kind}
      {...(art.kind === "picture" ? { "data-effect": art.effect, "data-colors": art.colors } : {})}
      className="pointer-events-none absolute inset-0 overflow-hidden bg-tempo-home-ground"
    >
      {art.kind === "plain" ? null : <HomeArtCanvas art={art} className="absolute inset-0" />}
    </div>
  );
}
