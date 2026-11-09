import { describe, expect, it } from "vite-plus/test";

import {
  resolveThreadLogo,
  threadFallbackIcon,
  THREAD_LOGOS,
  threadLetter,
} from "./threadLogo.logic";

describe("resolveThreadLogo", () => {
  it.each([
    ["github", "/Users/ada/code/acme-app", "github"],
    [null, "/Users/ada/code/stripe-sync", "stripe"],
    [undefined, "/Users/ada/code/supabase/", "supabase"],
    [null, "/Users/ada/code/Tempo", "tempo"],
    [null, "/Users/ada/code/acme-app", null],
    ["icon:📦", "/Users/ada/code/stripe-sync", "stripe"],
    ["icon:📦", "/Users/ada/code/acme-app", null],
    [undefined, undefined, null],
  ])("the pick %s in %s shows %s", (chosen, projectRoot, logo) => {
    expect(resolveThreadLogo(chosen, projectRoot)).toBe(logo);
  });

  it.each([
    ["icon:📦", "📦"],
    ["github", null],
    [null, null],
    [undefined, null],
  ])("the pick %s has the fallback icon %s", (chosen, icon) => {
    expect(threadFallbackIcon(chosen)).toBe(icon);
  });

  it.each([
    ["Fix this", "F"],
    ["  zero value bug", "Z"],
    ["https://www.example.com/p/x", "E"],
    ["<command-name>/design-login</command-name>", "D"],
    ["[Earlier in this conversation", "E"],
    ["42 failing tests", "4"],
    ["...", ""],
  ])("%s has the letter %s", (title, letter) => {
    expect(threadLetter(title)).toBe(letter);
  });

  it("has a file for every logo the model or a folder can pick, and no other file", () => {
    const files = new Set(
      Object.keys(import.meta.glob("./logos/*.png")).map((file) =>
        file.replace("./logos/", "").replace(".png", ""),
      ),
    );
    const missing = [...THREAD_LOGOS].filter((logo) => logo !== "tempo" && !files.has(logo));
    expect(missing).toEqual([]);
    expect([...files].filter((file) => !THREAD_LOGOS.has(file))).toEqual([]);
  });
});
