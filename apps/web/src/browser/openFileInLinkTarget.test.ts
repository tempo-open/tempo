import type { BrowserLinkTarget, EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { openFileInLinkTarget } from "./openFileInPreview";

const state = vi.hoisted(() => ({
  linkTarget: "system" as BrowserLinkTarget,
  openExternal: vi.fn(async (_url: string) => undefined),
}));

vi.mock("~/hooks/useSettings", () => ({
  ensureClientSettingsHydrated: async () => undefined,
  getClientSettings: () => ({ browserLinkTarget: state.linkTarget }),
}));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: async () => ({ viewport: { _tag: "fill" }, profileId: "default" }),
}));
vi.mock("~/browser/previewRuntime", () => ({
  isPreviewAvailableFor: () => true,
  previewRuntimeFor: () => undefined,
}));
vi.mock("~/localApi", () => ({
  readLocalApi: () => ({ shell: { openExternal: state.openExternal } }),
}));

const input = () => ({
  origin: "chat" as const,
  threadRef: { environmentId: "env" as EnvironmentId, threadId: "thread" } as ScopedThreadRef,
  filePath: "/repo/report.html",
  workspaceRoot: "/repo",
  httpBaseUrl: "http://127.0.0.1:3773/",
  createAssetUrl: vi.fn(async () =>
    AsyncResult.success({ relativeUrl: "/assets/token/report.html" } as never),
  ),
  openPreview: vi.fn(async () =>
    AsyncResult.success({
      threadId: "thread",
      tabId: "tab",
      navStatus: { _tag: "Idle" },
      canGoBack: false,
      canGoForward: false,
      updatedAt: "2026-11-03T12:00:00.000Z",
    } as never),
  ),
});

describe("openFileInLinkTarget", () => {
  beforeEach(() => state.openExternal.mockClear());

  it("gives the default browser the file's address", async () => {
    state.linkTarget = "system";
    const request = input();

    const result = await openFileInLinkTarget(request);

    expect(result._tag).toBe("Success");
    expect(state.openExternal).toHaveBeenCalledWith(
      "http://127.0.0.1:3773/assets/token/report.html",
    );
    expect(request.openPreview).not.toHaveBeenCalled();
  });

  it.each(["app", "work"] as const)(
    "opens the side panel when links open in %s, as a file is on this Mac",
    async (linkTarget) => {
      state.linkTarget = linkTarget;
      const request = input();

      await openFileInLinkTarget(request);

      expect(state.openExternal).not.toHaveBeenCalled();
      expect(request.openPreview).toHaveBeenCalledOnce();
    },
  );

  it("reports an address it could not get, and opens nothing", async () => {
    state.linkTarget = "system";
    const request = input();
    request.createAssetUrl.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("no"))) as never,
    );

    const result = await openFileInLinkTarget(request);

    expect(result._tag).toBe("Failure");
    expect(state.openExternal).not.toHaveBeenCalled();
  });
});
