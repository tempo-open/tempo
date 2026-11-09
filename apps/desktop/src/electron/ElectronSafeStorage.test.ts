import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import { vi } from "vite-plus/test";

const { safeStorageMock } = vi.hoisted(() => ({
  safeStorageMock: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
}));

vi.mock("electron", () => ({ safeStorage: safeStorageMock }));

import * as ElectronSafeStorage from "./ElectronSafeStorage.ts";

describe("ElectronSafeStorage on macOS", () => {
  it.effect("never touches Electron's keychain-backed safeStorage", () =>
    Effect.gen(function* () {
      const storage = yield* ElectronSafeStorage.make.pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
      );
      assert.isTrue(yield* storage.isEncryptionAvailable);
      const saved = yield* storage.encryptString("stored_secret");
      assert.equal(yield* storage.decryptString(saved), "stored_secret");
      const legacy = yield* storage
        .decryptString(new TextEncoder().encode("v10keychain-encrypted"))
        .pipe(Effect.flip);
      assert.equal(legacy._tag, "ElectronSafeStorageDecryptError");
      assert.equal(safeStorageMock.isEncryptionAvailable.mock.calls.length, 0);
      assert.equal(safeStorageMock.encryptString.mock.calls.length, 0);
      assert.equal(safeStorageMock.decryptString.mock.calls.length, 0);
    }),
  );
});
