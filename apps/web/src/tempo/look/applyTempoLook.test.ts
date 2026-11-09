import type { TempoLook } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const persistenceMocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
}));

vi.mock("~/localApi", () => ({
  ensureLocalApi: () => ({ persistence: persistenceMocks }),
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { getTempoLook, subscribeTempoLook } from "./applyTempoLook";

beforeEach(() => {
  __resetClientSettingsPersistenceForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getTempoLook", () => {
  it("keeps the look the boot script painted until the saved settings arrive", async () => {
    vi.stubGlobal("document", { documentElement: { dataset: { look: "tempo" } } });
    let finishRead!: (settings: ClientSettings) => void;
    persistenceMocks.getClientSettings.mockReturnValueOnce(
      new Promise((resolve) => {
        finishRead = resolve;
      }),
    );
    const seen: TempoLook[] = [];
    const unsubscribe = subscribeTempoLook(() => seen.push(getTempoLook()));
    expect(getTempoLook()).toBe("tempo");

    finishRead({ ...DEFAULT_CLIENT_SETTINGS, tempoLook: "classic" });
    await ensureClientSettingsHydrated();
    unsubscribe();
    expect(getTempoLook()).toBe("classic");
    expect(seen.at(-1)).toBe("classic");
  });
});
