import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";

const electronSafeStorageErrorFields = {
  cause: Schema.Defect(),
};

export class ElectronSafeStorageAvailabilityError extends Schema.TaggedError<ElectronSafeStorageAvailabilityError>()(
  "ElectronSafeStorageAvailabilityError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to check encryption availability.";
  }
}

export class ElectronSafeStorageEncryptError extends Schema.TaggedError<ElectronSafeStorageEncryptError>()(
  "ElectronSafeStorageEncryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to encrypt a string.";
  }
}

export class ElectronSafeStorageDecryptError extends Schema.TaggedError<ElectronSafeStorageDecryptError>()(
  "ElectronSafeStorageDecryptError",
  {
    ...electronSafeStorageErrorFields,
  },
) {
  override get message(): string {
    return "Electron safe storage failed to decrypt a string.";
  }
}

export const ElectronSafeStorageError = Schema.Union([
  ElectronSafeStorageAvailabilityError,
  ElectronSafeStorageEncryptError,
  ElectronSafeStorageDecryptError,
]);
export type ElectronSafeStorageError = typeof ElectronSafeStorageError.Type;

export class ElectronSafeStorage extends Context.Service<
  ElectronSafeStorage,
  {
    readonly isEncryptionAvailable: Effect.Effect<boolean, ElectronSafeStorageAvailabilityError>;
    readonly encryptString: (
      value: string,
    ) => Effect.Effect<Uint8Array, ElectronSafeStorageEncryptError>;
    readonly decryptString: (
      value: Uint8Array,
    ) => Effect.Effect<string, ElectronSafeStorageDecryptError>;
    readonly selectedStorageBackend: Effect.Effect<Option.Option<string>>;
  }
>()("@t3tools/desktop/electron/ElectronSafeStorage") {}

/**
 * tempo: on macOS nothing goes through the keychain. Electron keeps its key in the login keychain,
 * and macOS asks for the password again after every update of an app built without an Apple team
 * ID. Secrets are stored unencrypted, as plain text in mode 600 files only this user can read, like
 * the server's own in `~/.tempo/userdata/secrets`.
 */
const MAC_PLAIN_PREFIX = "tempoplain:";

const macPlainStorage = ElectronSafeStorage.of({
  isEncryptionAvailable: Effect.succeed(true),
  encryptString: Effect.fn("ElectronSafeStorage.encryptString")(function (value) {
    return Effect.succeed(new TextEncoder().encode(`${MAC_PLAIN_PREFIX}${value}`));
  }),
  decryptString: Effect.fn("ElectronSafeStorage.decryptString")(function* (value) {
    const text = new TextDecoder().decode(value);
    // Anything else was saved with the keychain key, which Tempo no longer reads.
    if (!text.startsWith(MAC_PLAIN_PREFIX)) {
      return yield* new ElectronSafeStorageDecryptError({
        cause: "Saved with the keychain, no longer read.",
      });
    }
    return text.slice(MAC_PLAIN_PREFIX.length);
  }),
  selectedStorageBackend: Effect.succeedNone,
});

/** @public */
export const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  if (platform === "darwin") return macPlainStorage;

  return ElectronSafeStorage.of({
    isEncryptionAvailable: Effect.try({
      try: () => Electron.safeStorage.isEncryptionAvailable(),
      catch: (cause) => new ElectronSafeStorageAvailabilityError({ cause }),
    }),
    encryptString: Effect.fn("ElectronSafeStorage.encryptString")(function (value) {
      return Effect.try({
        try: () => Electron.safeStorage.encryptString(value),
        catch: (cause) => new ElectronSafeStorageEncryptError({ cause }),
      });
    }),
    decryptString: Effect.fn("ElectronSafeStorage.decryptString")(function (value) {
      return Effect.try({
        try: () => Electron.safeStorage.decryptString(Buffer.from(value)),
        catch: (cause) => new ElectronSafeStorageDecryptError({ cause }),
      });
    }),
    selectedStorageBackend: Effect.sync(() => {
      if (platform !== "linux") {
        return Option.none();
      }
      try {
        return Option.fromNullishOr(Electron.safeStorage.getSelectedStorageBackend());
      } catch {
        return Option.none();
      }
    }),
  });
});

export const layer = Layer.effect(ElectronSafeStorage, make);
