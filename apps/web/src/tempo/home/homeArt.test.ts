import { describe, expect, it } from "vite-plus/test";

import {
  homeArtGrid,
  placeHomeArt,
  resolveHomeArt,
  type HomeArtSettings,
  type PaintedHomeArt,
} from "./homeArt";

const settings: HomeArtSettings = {
  tempoHomeBackground: "auto",
  tempoHomeDots: "few",
  tempoHomePictureEffect: "fade",
  tempoHomePictureColors: "original",
};

describe("resolveHomeArt", () => {
  it("draws Tempo light in dark and The crossing in light by default", () => {
    expect(resolveHomeArt(settings, "dark", "none")).toEqual({
      kind: "light",
      light: "beam",
      theme: "dark",
      dots: "few",
    });
    expect(resolveHomeArt(settings, "light", "none")).toMatchObject({ light: "crossing" });
  });

  it("paints your own picture once it is read, and keeps the default light without one", () => {
    const own = { ...settings, tempoHomeBackground: "picture" } as const;
    expect(resolveHomeArt(own, "light", "reading")).toEqual({ kind: "plain" });
    expect(resolveHomeArt(own, "light", "none")).toEqual(resolveHomeArt(settings, "light", "none"));
    expect(resolveHomeArt(own, "dark", { url: "blob:own" })).toEqual({
      kind: "picture",
      picture: "own",
      url: "blob:own",
      theme: "dark",
      colors: "original",
      effect: "fade",
    });
  });
});

describe("homeArtGrid", () => {
  const light: PaintedHomeArt = { kind: "light", light: "beam", theme: "dark", dots: "few" };
  const picture: PaintedHomeArt = {
    kind: "picture",
    picture: "own",
    url: "blob:picture",
    theme: "dark",
    colors: "original",
    effect: "fade",
  };

  it.each([
    ["the MacBook sheet at 2x", 2880, 2056, 6],
    ["an ultrawide sheet at 1x", 3200, 1340, 7],
    ["an odd sized sheet", 2901, 1777, 6],
    ["a short window", 900, 300, 2],
  ])("covers %s with art pixels a whole number of device pixels wide", (_, width, height, cell) => {
    const grid = homeArtGrid(light, width, height);
    expect(grid.cell).toBe(cell);
    for (const [start, count, length] of [
      [grid.left, grid.cols, width],
      [grid.top, grid.rows, height],
    ] as const) {
      expect(start).toBeLessThanOrEqual(0);
      expect(start).toBeGreaterThan(-cell);
      expect(start + count * cell).toBeGreaterThanOrEqual(length);
      expect(start + count * cell - length).toBeLessThan(cell);
      expect((Math.floor(length / 2) - start) % cell).toBe(0);
    }
  });

  it("draws the fine dots and pictures at a finer grain", () => {
    expect(
      homeArtGrid({ kind: "light", light: "beam", theme: "dark", dots: "fine" }, 2880, 2056).cell,
    ).toBe(4);
    expect(homeArtGrid(picture, 2880, 2056).cell).toBe(4);
  });

  it("hangs a picture from the top of the sheet", () => {
    expect(homeArtGrid(picture, 3145, 1390)).toMatchObject({
      cols: 787,
      rows: 348,
      left: 0,
      top: 0,
    });
  });

  it("keeps art painted for another size on the new centre line while a resize settles", () => {
    const grid = homeArtGrid(light, 2880, 2056);
    expect(grid).toMatchObject({ left: 0, top: -4 });
    expect(placeHomeArt(light, grid, 2900, 2050)).toEqual({ left: 10, top: -7 });
  });
});
