/**
 * tempo: extensions, saved passkeys and saved passwords for the server browser, per profile and
 * kept on the environment. Extensions come from a Chrome Web Store URL or id or an unpacked folder;
 * passkeys live in a virtual authenticator whose credentials the server stores. Clients only ever
 * see metadata, never key material or a password.
 */
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { BrowserProfileId } from "./browserProfile.ts";

/** Chrome extension ids are 32 letters from a to p. */
export const TempoBrowserExtensionId = Schema.String.check(Schema.isPattern(/^[a-p]{32}$/));
export type TempoBrowserExtensionId = typeof TempoBrowserExtensionId.Type;

export const TempoBrowserExtensionSource = Schema.Literals(["webStore", "unpacked"]);
export type TempoBrowserExtensionSource = typeof TempoBrowserExtensionSource.Type;

export const TempoBrowserExtension = Schema.Struct({
  id: TempoBrowserExtensionId,
  name: Schema.String,
  version: Schema.String,
  description: Schema.optionalKey(Schema.String),
  /** A small `data:` image from the manifest's icons. */
  iconDataUrl: Schema.optionalKey(Schema.String),
  source: TempoBrowserExtensionSource,
  /** The folder on the environment an unpacked extension loads from. */
  folder: Schema.optionalKey(Schema.String),
  /** The toolbar popup, relative to the extension root. */
  popupPage: Schema.optionalKey(Schema.String),
  /** The options page, relative to the extension root. */
  optionsPage: Schema.optionalKey(Schema.String),
  enabled: Schema.Boolean,
  installedAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type TempoBrowserExtension = typeof TempoBrowserExtension.Type;

/**
 * Who answers a page's passkey requests in a profile. `saved` keeps passkeys in
 * this browser; `icloud-keychain` hands them to the Mac of the person driving
 * the tab (tempoPasskeys.ts), and falls back to saved passkeys when none can.
 */
export const TempoPasskeyProvider = Schema.Literals(["saved", "icloud-keychain"]);
export type TempoPasskeyProvider = typeof TempoPasskeyProvider.Type;

export const TempoPasskeySettings = Schema.Struct({
  /** "Save passkeys in this browser". On by default. */
  savePasskeys: Schema.Boolean,
  /** "Let agents use passkeys". Off by default: agent sign-ins fail, whichever provider answers. */
  agentsMayUse: Schema.Boolean,
  provider: TempoPasskeyProvider,
});
export type TempoPasskeySettings = typeof TempoPasskeySettings.Type;

export const TEMPO_DEFAULT_PASSKEY_SETTINGS: TempoPasskeySettings = {
  savePasskeys: true,
  agentsMayUse: false,
  provider: "saved",
};

/** A saved passkey as clients see it: no key material. */
export const TempoSavedPasskey = Schema.Struct({
  credentialId: Schema.String,
  rpId: Schema.String,
  userName: Schema.optionalKey(Schema.String),
  userDisplayName: Schema.optionalKey(Schema.String),
  createdAt: IsoDateTime,
  lastUsedAt: Schema.NullOr(IsoDateTime),
});
export type TempoSavedPasskey = typeof TempoSavedPasskey.Type;

export const TempoPasswordSettings = Schema.Struct({
  /** "Save passwords". On by default: each sign-in, sign-up or password change in the profile's tabs. */
  savePasswords: Schema.Boolean,
  /** "Let agents use passwords". On by default; off, pages an agent opened or acted in get no fills. */
  agentsMayUse: Schema.Boolean,
});
export type TempoPasswordSettings = typeof TempoPasswordSettings.Type;

export const TEMPO_DEFAULT_PASSWORD_SETTINGS: TempoPasswordSettings = {
  savePasswords: true,
  agentsMayUse: true,
};

/** A saved password as clients see it: never the password. */
export const TempoSavedPassword = Schema.Struct({
  /** The exact origin it was saved on, and the only one it fills on, such as `https://github.com`. */
  origin: Schema.String,
  /** Empty for a site that asked for a password only. */
  username: Schema.String,
  createdAt: IsoDateTime,
  lastUsedAt: IsoDateTime,
});
export type TempoSavedPassword = typeof TempoSavedPassword.Type;

/**
 * The browser that runs extensions on the environment: a full Chrome build,
 * downloaded once (about 200 MB) when a profile first needs it. Tabs of a
 * profile with extensions reload with them once it is `ready`.
 */
export const TempoExtensionBrowserState = Schema.Literals(["ready", "installing", "notInstalled"]);
export type TempoExtensionBrowserState = typeof TempoExtensionBrowserState.Type;

export const TempoBrowserProfileState = Schema.Struct({
  profileId: BrowserProfileId,
  extensions: Schema.Array(TempoBrowserExtension),
  // Hosts from before this field do not send it; a client must still read their profiles.
  extensionBrowser: TempoExtensionBrowserState.pipe(
    Schema.withDecodingDefault(Effect.succeed("notInstalled" as const)),
  ),
  passkeys: Schema.Struct({
    settings: TempoPasskeySettings,
    saved: Schema.Array(TempoSavedPasskey),
    /** Providers this environment can use now. */
    availableProviders: Schema.Array(TempoPasskeyProvider),
  }),
  /** Absent from hosts from before saved passwords, which keep none. */
  passwords: Schema.optionalKey(
    Schema.Struct({
      settings: TempoPasswordSettings,
      saved: Schema.Array(TempoSavedPassword),
    }),
  ),
});
export type TempoBrowserProfileState = typeof TempoBrowserProfileState.Type;

const TEMPO_BROWSER_FAILURE_MESSAGES = {
  invalid_source:
    "Enter a Chrome Web Store link, a 32-letter extension id, or the absolute path of an unpacked extension folder on this environment.",
  not_found: "That extension, passkey or password is not in this profile.",
  download_failed: "Could not download the extension from the Chrome Web Store. Try again.",
  invalid_package: "The extension package is damaged or not signed for this extension id.",
  too_large: "The extension is larger than the browser accepts.",
  unsupported_manifest:
    "This extension does not run in the Tempo browser: it needs Manifest V3 and a name and version.",
  no_page: "This extension has no page of that kind.",
  provider_unavailable: "That passkey provider is not available on this environment yet.",
  storage: "Could not read or save this profile's browser data on the environment.",
  launch: "The server browser could not open that page.",
  incognito: "Incognito tabs keep no extensions, saved passkeys or saved passwords.",
} as const;

export const TempoBrowserFailureReason = Schema.Literals([
  "invalid_source",
  "not_found",
  "download_failed",
  "invalid_package",
  "too_large",
  "unsupported_manifest",
  "no_page",
  "provider_unavailable",
  "storage",
  "launch",
  "incognito",
]);
export type TempoBrowserFailureReason = typeof TempoBrowserFailureReason.Type;

/** A browser profile operation failed. The message is shown to users and agents. */
export class TempoBrowserProfileError extends Schema.TaggedError<TempoBrowserProfileError>()(
  "TempoBrowserProfileError",
  {
    reason: TempoBrowserFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return TEMPO_BROWSER_FAILURE_MESSAGES[this.reason];
  }
}

export const TempoBrowserProfileInput = Schema.Struct({ profileId: BrowserProfileId });
export type TempoBrowserProfileInput = typeof TempoBrowserProfileInput.Type;

export const TempoBrowserAddExtensionInput = Schema.Struct({
  profileId: BrowserProfileId,
  /** A Chrome Web Store URL, an extension id, or an absolute folder path on the environment. */
  source: TrimmedNonEmptyString.check(Schema.isMaxLength(4_096)),
});
export type TempoBrowserAddExtensionInput = typeof TempoBrowserAddExtensionInput.Type;

export const TempoBrowserSetExtensionEnabledInput = Schema.Struct({
  profileId: BrowserProfileId,
  extensionId: TempoBrowserExtensionId,
  enabled: Schema.Boolean,
});
export type TempoBrowserSetExtensionEnabledInput = typeof TempoBrowserSetExtensionEnabledInput.Type;

export const TempoBrowserExtensionInput = Schema.Struct({
  profileId: BrowserProfileId,
  extensionId: TempoBrowserExtensionId,
});
export type TempoBrowserExtensionInput = typeof TempoBrowserExtensionInput.Type;

export const TempoBrowserCheckUpdatesResult = Schema.Struct({
  profile: TempoBrowserProfileState,
  /** Extensions that changed version. */
  updated: Schema.Array(TempoBrowserExtensionId),
  /** Extensions that could not be checked; the others still were. */
  failed: Schema.Array(
    Schema.Struct({ extensionId: TempoBrowserExtensionId, reason: TempoBrowserFailureReason }),
  ),
});
export type TempoBrowserCheckUpdatesResult = typeof TempoBrowserCheckUpdatesResult.Type;

export const TempoBrowserSetPasskeySettingsInput = Schema.Struct({
  profileId: BrowserProfileId,
  savePasskeys: Schema.optionalKey(Schema.Boolean),
  agentsMayUse: Schema.optionalKey(Schema.Boolean),
  provider: Schema.optionalKey(TempoPasskeyProvider),
});
export type TempoBrowserSetPasskeySettingsInput = typeof TempoBrowserSetPasskeySettingsInput.Type;

export const TempoBrowserRemovePasskeyInput = Schema.Struct({
  profileId: BrowserProfileId,
  credentialId: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)),
});
export type TempoBrowserRemovePasskeyInput = typeof TempoBrowserRemovePasskeyInput.Type;

export const TempoBrowserSetPasswordSettingsInput = Schema.Struct({
  profileId: BrowserProfileId,
  savePasswords: Schema.optionalKey(Schema.Boolean),
  agentsMayUse: Schema.optionalKey(Schema.Boolean),
});
export type TempoBrowserSetPasswordSettingsInput = typeof TempoBrowserSetPasswordSettingsInput.Type;

/** A saved password is one site's one username. */
export const TempoBrowserRemovePasswordInput = Schema.Struct({
  profileId: BrowserProfileId,
  origin: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  username: Schema.String.check(Schema.isMaxLength(1_024)),
});
export type TempoBrowserRemovePasswordInput = typeof TempoBrowserRemovePasswordInput.Type;

export const TempoBrowserExtensionPage = Schema.Literals(["popup", "options"]);
export type TempoBrowserExtensionPage = typeof TempoBrowserExtensionPage.Type;

export const TempoBrowserOpenExtensionPageInput = Schema.Struct({
  threadId: ThreadId,
  profileId: BrowserProfileId,
  extensionId: TempoBrowserExtensionId,
  page: TempoBrowserExtensionPage,
});
export type TempoBrowserOpenExtensionPageInput = typeof TempoBrowserOpenExtensionPageInput.Type;

export const TempoBrowserOpenExtensionPageResult = Schema.Struct({ tabId: Schema.String });
export type TempoBrowserOpenExtensionPageResult = typeof TempoBrowserOpenExtensionPageResult.Type;

/** Spread into WS_METHODS so every caller names these as `WS_METHODS.tempoBrowser*`. */
export const TEMPO_BROWSER_WS_METHODS = {
  tempoBrowserGetProfile: "tempo.browser.getProfile",
  tempoBrowserAddExtension: "tempo.browser.addExtension",
  tempoBrowserSetExtensionEnabled: "tempo.browser.setExtensionEnabled",
  tempoBrowserRemoveExtension: "tempo.browser.removeExtension",
  tempoBrowserCheckExtensionUpdates: "tempo.browser.checkExtensionUpdates",
  tempoBrowserSetPasskeySettings: "tempo.browser.setPasskeySettings",
  tempoBrowserRemovePasskey: "tempo.browser.removePasskey",
  tempoBrowserSetPasswordSettings: "tempo.browser.setPasswordSettings",
  tempoBrowserRemovePassword: "tempo.browser.removePassword",
  tempoBrowserOpenExtensionPage: "tempo.browser.openExtensionPage",
  tempoBrowserForgetProfile: "tempo.browser.forgetProfile",
} as const;

const profileError = Schema.Union([TempoBrowserProfileError, EnvironmentAuthorizationError]);

export const WsTempoBrowserGetProfileRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserGetProfile,
  {
    payload: TempoBrowserProfileInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

/** Downloads (or reads) and verifies the extension, then restarts the profile's server tabs with it. */
export const WsTempoBrowserAddExtensionRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserAddExtension,
  {
    payload: TempoBrowserAddExtensionInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

export const WsTempoBrowserSetExtensionEnabledRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserSetExtensionEnabled,
  {
    payload: TempoBrowserSetExtensionEnabledInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

export const WsTempoBrowserRemoveExtensionRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserRemoveExtension,
  { payload: TempoBrowserExtensionInput, success: TempoBrowserProfileState, error: profileError },
);

export const WsTempoBrowserCheckExtensionUpdatesRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserCheckExtensionUpdates,
  {
    payload: TempoBrowserProfileInput,
    success: TempoBrowserCheckUpdatesResult,
    error: profileError,
  },
);

export const WsTempoBrowserSetPasskeySettingsRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserSetPasskeySettings,
  {
    payload: TempoBrowserSetPasskeySettingsInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

export const WsTempoBrowserRemovePasskeyRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserRemovePasskey,
  {
    payload: TempoBrowserRemovePasskeyInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

export const WsTempoBrowserSetPasswordSettingsRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserSetPasswordSettings,
  {
    payload: TempoBrowserSetPasswordSettingsInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

export const WsTempoBrowserRemovePasswordRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserRemovePassword,
  {
    payload: TempoBrowserRemovePasswordInput,
    success: TempoBrowserProfileState,
    error: profileError,
  },
);

/** Opens an extension's popup or options page as a server tab in the thread. */
export const WsTempoBrowserOpenExtensionPageRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserOpenExtensionPage,
  {
    payload: TempoBrowserOpenExtensionPageInput,
    success: TempoBrowserOpenExtensionPageResult,
    error: profileError,
  },
);

/** Deletes a removed profile's extensions, saved passkeys and saved passwords from the environment. */
export const WsTempoBrowserForgetProfileRpc = Rpc.make(
  TEMPO_BROWSER_WS_METHODS.tempoBrowserForgetProfile,
  {
    payload: TempoBrowserProfileInput,
    error: profileError,
  },
);
