import {
  ClientSettingsSchema,
  type ClientSettings,
  withoutOldClientSettingsDefaults,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { getLocalStorageItem, setLocalStorageItem } from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";

// tempo: the saved snapshot pins every value, so values still equal to a changed default move to the
// new one, as the desktop settings file does.
const SavedClientSettings = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.decodeTo(
    ClientSettingsSchema,
    SchemaTransformation.transform<
      typeof ClientSettingsSchema.Encoded,
      Readonly<Record<string, unknown>>
    >({
      decode: (saved) =>
        withoutOldClientSettingsDefaults(saved) as typeof ClientSettingsSchema.Encoded,
      encode: (settings) => settings,
    }),
  ),
);

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  return getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, SavedClientSettings);
}

export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  setLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, settings, ClientSettingsSchema);
}
