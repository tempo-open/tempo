import type { BrowserLinkTarget } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { type LinkOrigin, resolveLinkTarget } from "./browserLinkTarget";

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: vi.fn(async () => undefined),
  getClientSettings: () => ({ browserLinkTarget: "work" }),
}));

const CANVAS = "http://127.0.0.1:5173/c/design-board";
const DEV_SERVER = "http://localhost:5173/";
const PAGE = "https://example.pages.dev/p/release-notes-k3v9q2m8x7tb";
const PULL_REQUEST = "https://github.com/acme/app/pull/4";

const click = { metaKey: false, ctrlKey: false };
const commandClick = { metaKey: true, ctrlKey: false };
const ctrlClick = { metaKey: false, ctrlKey: true };
const middleClick = { metaKey: false, ctrlKey: false, button: 1 };

const input = (preference: BrowserLinkTarget, origin: LinkOrigin, url: string, event = click) => ({
  preference,
  origin,
  url,
  event,
  canOpenInApp: true,
});

describe("resolveLinkTarget", () => {
  it.each([
    ["⌘ click", input("app", "panel", CANVAS, commandClick), "system"],
    ["Ctrl click", input("app", "panel", CANVAS, ctrlClick), "system"],
    ["middle click", input("app", "chat", CANVAS, middleClick), "system"],
    ["not a web address", input("app", "panel", "mailto:someone@example.com"), "system"],
    ["no side panel to open", { ...input("app", "panel", CANVAS), canOpenInApp: false }, "system"],
    ["a side panel click, system", input("system", "panel", PULL_REQUEST), "app"],
    ["app", input("app", "chat", PULL_REQUEST), "app"],
    ["work, the canvas", input("work", "chat", CANVAS), "app"],
    ["work, a dev server", input("work", "chat", DEV_SERVER), "app"],
    ["work, a shared page", input("work", "chat", PAGE), "app"],
    ["work, any other link", input("work", "chat", PULL_REQUEST), "system"],
    ["system", input("system", "chat", CANVAS), "system"],
  ] as const)("%s", (_case, linkInput, target) => {
    expect(resolveLinkTarget(linkInput)).toBe(target);
  });
});
