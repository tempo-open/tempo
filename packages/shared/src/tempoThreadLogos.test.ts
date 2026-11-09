import { describe, expect, it } from "vite-plus/test";

import {
  THREAD_LOGO_IDS,
  THREAD_LOGO_INSTRUCTIONS,
  threadIconFromModel,
  threadLogoFromChoice,
  threadLogoFromModel,
} from "./tempoThreadLogos.ts";

describe("threadLogoFromModel", () => {
  it.each([
    ["github", "github"],
    [" Stripe ", "stripe"],
    ["example.com", "example.com"],
    ["https://www.Example.org/", "example.org"],
    ["none", null],
    ["apple", null],
    ["not a domain.", null],
    ["", null],
    [undefined, null],
  ])("%j is %j", (answer, logo) => {
    expect(threadLogoFromModel(answer)).toBe(logo);
  });

  it.each([
    ["me", null],
    ["🎬", "icon:🎬"],
    ["⚖️", "icon:⚖️"],
    ["👨‍💻", "icon:👨‍💻"],
    ["🎬🎮", null],
    ["👍🏽", "icon:👍🏽"],
    ["🇺🇸", "icon:🇺🇸"],
    ["movie", null],
    ["none", null],
    ["", null],
    [undefined, null],
  ])("icon %j is %j", (answer, icon) => {
    expect(threadIconFromModel(answer)).toBe(icon);
  });

  it.each([
    ["🧪", "icon:🧪"],
    [" Stripe ", "stripe"],
    ["me", undefined],
    ["None", null],
    ["example.com", undefined],
    ["pizza", undefined],
  ])("hand-picked %j is %j", (choice, logo) => {
    expect(threadLogoFromChoice(choice)).toBe(logo);
  });

  it("lists every logo once for the model", () => {
    for (const id of THREAD_LOGO_IDS) {
      expect(
        THREAD_LOGO_INSTRUCTIONS.split("\n").filter((line) => line.startsWith(`${id}: `)),
      ).toHaveLength(1);
    }
  });
});
