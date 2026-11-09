import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import { vi } from "vite-plus/test";

import { whenDocumentVisible } from "./documentVisibility";

describe("whenDocumentVisible", () => {
  let page: EventTarget & { visibilityState: DocumentVisibilityState };

  beforeEach(() => {
    page = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
    vi.stubGlobal("document", page);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("completes at once while the window shows", () => whenDocumentVisible);

  it.effect("waits while the window is hidden and completes when it is shown", () =>
    Effect.gen(function* () {
      page.visibilityState = "hidden";
      const shown = yield* Effect.forkChild(whenDocumentVisible, { startImmediately: true });
      page.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.yieldNow;
      expect(shown.pollUnsafe()).toBeUndefined();

      page.visibilityState = "visible";
      page.dispatchEvent(new Event("visibilitychange"));
      yield* Fiber.join(shown);
    }),
  );
});
