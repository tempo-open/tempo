import { afterEach, beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { vi } from "vite-plus/test";

import { shellCacheWritePause } from "./shellCacheWrites";

describe("shellCacheWritePause", () => {
  let page: EventTarget & { visibilityState: DocumentVisibilityState };
  let frame: EventTarget;

  beforeEach(() => {
    page = Object.assign(new EventTarget(), { visibilityState: "visible" as const });
    frame = new EventTarget();
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", frame);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.effect("waits a minute while the window shows", () =>
    Effect.gen(function* () {
      const pause = yield* Effect.forkChild(shellCacheWritePause, { startImmediately: true });
      yield* TestClock.adjust("59 seconds");
      page.dispatchEvent(new Event("visibilitychange"));
      yield* Effect.yieldNow;
      expect(pause.pollUnsafe()).toBeUndefined();

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(pause);
    }),
  );

  it.effect("ends at once when the window hides", () =>
    Effect.gen(function* () {
      const pause = yield* Effect.forkChild(shellCacheWritePause, { startImmediately: true });
      page.visibilityState = "hidden";
      page.dispatchEvent(new Event("visibilitychange"));
      yield* Fiber.join(pause);
    }),
  );

  it.effect("ends at once when the page unloads", () =>
    Effect.gen(function* () {
      const pause = yield* Effect.forkChild(shellCacheWritePause, { startImmediately: true });
      frame.dispatchEvent(new Event("pagehide"));
      yield* Fiber.join(pause);
    }),
  );
});
