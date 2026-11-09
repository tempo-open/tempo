/**
 * tempo: passkeys from the person's Mac for server browser tabs. A profile whose passkey provider
 * is `icloud-keychain` hands each ceremony of its tabs to the laptop of the person driving the tab
 * over the laptop-tools bridge, where macOS AuthenticationServices shows the system passkey sheet
 * (iCloud Keychain, 1Password and other credential providers, phones, security keys).
 */
import * as Schema from "effect/Schema";

import { PositiveInt, ThreadId } from "./baseSchemas.ts";

/**
 * Whether this laptop answers passkey requests; anything but `available` falls back to the
 * profile's saved passkeys. `awaiting-entitlement`: the build lacks Apple's managed browser passkey
 * entitlement (dev builds, or before Apple approves it). `unsupported-os`: before macOS 15. `off`:
 * turned off in Laptop tools settings. `failed`: entitled, but macOS passkeys did not load.
 */
export const TempoLaptopPasskeyStatus = Schema.Literals([
  "available",
  "awaiting-entitlement",
  "unsupported-os",
  "not-mac",
  "off",
  "failed",
]);
export type TempoLaptopPasskeyStatus = typeof TempoLaptopPasskeyStatus.Type;

export const TempoPasskeyCeremonyKind = Schema.Literals(["create", "get"]);
export type TempoPasskeyCeremonyKind = typeof TempoPasskeyCeremonyKind.Type;

/**
 * Who started a ceremony: the person holding the tab, an agent the profile
 * lets use passkeys, or a page nobody is driving (such as a sign-in on load).
 * The laptop asks before any ceremony but the person's own.
 */
export const TempoPasskeyRequester = Schema.Literals(["person", "agent", "page"]);
export type TempoPasskeyRequester = typeof TempoPasskeyRequester.Type;

/** The largest options a page may send, as JSON characters. */
export const TEMPO_PASSKEY_MAX_OPTIONS_CHARS = 64 * 1024;

export const LaptopPasskeyRequest = Schema.TaggedStruct("passkey", {
  ceremony: TempoPasskeyCeremonyKind,
  /**
   * The requesting page's origin, read by the environment from the browser,
   * never from the page. Always https: the environment's own localhost is not
   * the laptop's, so local pages keep to saved passkeys.
   */
  origin: Schema.String.check(Schema.isMaxLength(2048)),
  /** The relying party, already checked against `origin`. */
  rpId: Schema.String.check(Schema.isMaxLength(253)),
  /**
   * The page's `PublicKeyCredentialCreationOptions` or
   * `PublicKeyCredentialRequestOptions`. Binary members arrive as
   * `{ "$b64u": "<base64url>" }`.
   */
  publicKey: Schema.Unknown,
  threadId: ThreadId,
  /** The thread's title, for the laptop to show; an agent can set it. */
  threadTitle: Schema.String.check(Schema.isMaxLength(500)),
  requester: TempoPasskeyRequester,
  timeoutMs: PositiveInt,
});
export type LaptopPasskeyRequest = typeof LaptopPasskeyRequest.Type;

/** A new passkey, as AuthenticationServices reports it; binary values in base64url. */
export const TempoPasskeyCreatedData = Schema.Struct({
  credentialId: Schema.String,
  clientDataJSON: Schema.String,
  attestationObject: Schema.String,
  authData: Schema.String,
  publicKey: Schema.String,
  publicKeyAlgorithm: Schema.Number,
  transports: Schema.Array(Schema.String),
  extensions: Schema.Struct({
    credProps: Schema.optionalKey(Schema.Struct({ rk: Schema.Boolean })),
    prf: Schema.optionalKey(
      Schema.Struct({
        enabled: Schema.optionalKey(Schema.Boolean),
        results: Schema.optionalKey(
          Schema.Struct({
            first: Schema.optionalKey(Schema.String),
            second: Schema.optionalKey(Schema.String),
          }),
        ),
      }),
    ),
    largeBlob: Schema.optionalKey(Schema.Struct({ supported: Schema.optionalKey(Schema.Boolean) })),
  }),
});
export type TempoPasskeyCreatedData = typeof TempoPasskeyCreatedData.Type;

/** A sign-in with an existing passkey; binary values in base64url. */
export const TempoPasskeyAssertedData = Schema.Struct({
  credentialId: Schema.String,
  clientDataJSON: Schema.String,
  authenticatorData: Schema.String,
  signature: Schema.String,
  userHandle: Schema.String,
  extensions: Schema.optionalKey(
    Schema.Struct({
      prf: Schema.optionalKey(
        Schema.Struct({
          results: Schema.optionalKey(
            Schema.Struct({ first: Schema.String, second: Schema.optionalKey(Schema.String) }),
          ),
        }),
      ),
      largeBlob: Schema.optionalKey(
        Schema.Struct({
          blob: Schema.optionalKey(Schema.String),
          written: Schema.optionalKey(Schema.Boolean),
        }),
      ),
    }),
  ),
});
export type TempoPasskeyAssertedData = typeof TempoPasskeyAssertedData.Type;

/** The DOMException (or TypeError) a refused ceremony rejects with in the page. */
export const TempoPasskeyErrorName = Schema.Literals([
  "NotAllowedError",
  "InvalidStateError",
  "NotSupportedError",
  "SecurityError",
  "AbortError",
  "TypeError",
]);
export type TempoPasskeyErrorName = typeof TempoPasskeyErrorName.Type;

export const LaptopPasskeyOutcome = Schema.TaggedStruct("passkey", {
  result: Schema.Union([
    Schema.TaggedStruct("created", { data: TempoPasskeyCreatedData }),
    Schema.TaggedStruct("asserted", { data: TempoPasskeyAssertedData }),
    /** The person cancelled, the sheet timed out, or the request was invalid. */
    Schema.TaggedStruct("refused", { error: TempoPasskeyErrorName }),
    /** This laptop cannot run passkeys now; the environment falls back to saved passkeys. */
    Schema.TaggedStruct("unavailable", { status: TempoLaptopPasskeyStatus }),
  ]),
});
export type LaptopPasskeyOutcome = typeof LaptopPasskeyOutcome.Type;
export type LaptopPasskeyResult = LaptopPasskeyOutcome["result"];

/** A ceremony the laptop is running, for the in-window cue of who asked. */
export const DesktopPasskeyRequestState = Schema.Struct({
  key: Schema.String,
  environmentLabel: Schema.String,
  threadTitle: Schema.String,
  rpId: Schema.String,
  ceremony: TempoPasskeyCeremonyKind,
  requester: TempoPasskeyRequester,
});
export type DesktopPasskeyRequestState = typeof DesktopPasskeyRequestState.Type;

export const DesktopPasskeysState = Schema.Struct({
  status: TempoLaptopPasskeyStatus,
  pending: Schema.Array(DesktopPasskeyRequestState),
});
export type DesktopPasskeysState = typeof DesktopPasskeysState.Type;
