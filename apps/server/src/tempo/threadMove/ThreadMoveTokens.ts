import { TempoThreadMoveId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  base64UrlDecodeUtf8,
  base64UrlEncode,
  signPayload,
  timingSafeEqualBase64Url,
} from "../../auth/utils.ts";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";

/** Signed transfer URLs live under here; their token is in the path, so requests stay untraced. */
export const THREAD_MOVE_ROUTE_PREFIX = "/api/tempo/thread-moves";
export const THREAD_MOVE_DOWNLOAD_PREFIX = `${THREAD_MOVE_ROUTE_PREFIX}/download`;
export const THREAD_MOVE_UPLOAD_PREFIX = `${THREAD_MOVE_ROUTE_PREFIX}/upload`;

const SIGNING_SECRET_NAME = "tempo-thread-move-signing-key";
// Long enough for a slow link to move a large bundle; the URL only works for one move.
const THREAD_MOVE_TOKEN_TTL_MS = 30 * 60_000;

/**
 * Claims inside a signed transfer URL. A download names an archive this
 * environment prepared; an upload admits exactly `sizeBytes` for one move.
 */
const ThreadMoveTransferClaims = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("download"),
    moveId: TempoThreadMoveId,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    kind: Schema.Literal("upload"),
    moveId: TempoThreadMoveId,
    sizeBytes: Schema.Number,
    expiresAt: Schema.Number,
  }),
]);
type ThreadMoveTransferClaims = typeof ThreadMoveTransferClaims.Type;

const claimsJson = Schema.fromJsonString(ThreadMoveTransferClaims);
const encodeClaims = Schema.encodeSync(claimsJson);
const decodeClaims = Schema.decodeUnknownOption(claimsJson);

const loadSecret = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  return yield* secrets.getOrCreateRandom(SIGNING_SECRET_NAME, 32);
});

/** Signs claims into a relative URL under `prefix`. */
export const issueTransferUrl = Effect.fn("ThreadMoveTokens.issue")(function* (
  claims: ThreadMoveTransferClaims,
) {
  const secret = yield* loadSecret;
  const payload = base64UrlEncode(encodeClaims(claims));
  const prefix =
    claims.kind === "download" ? THREAD_MOVE_DOWNLOAD_PREFIX : THREAD_MOVE_UPLOAD_PREFIX;
  return `${prefix}/${payload}.${signPayload(payload, secret)}`;
});

export const transferExpiry = Clock.currentTimeMillis.pipe(
  Effect.map((now) => now + THREAD_MOVE_TOKEN_TTL_MS),
);

/** The claims of a valid, unexpired token of `kind`, or null. */
export const validateTransferToken = Effect.fn("ThreadMoveTokens.validate")(function* (
  token: string,
  kind: ThreadMoveTransferClaims["kind"],
) {
  const [payload, signature, extra] = token.split(".");
  if (!payload || !signature || extra !== undefined) return null;
  const secret = yield* loadSecret.pipe(Effect.orElseSucceed(() => null));
  if (secret === null || !timingSafeEqualBase64Url(signature, signPayload(payload, secret))) {
    return null;
  }
  const json = yield* Effect.try(() => base64UrlDecodeUtf8(payload)).pipe(Effect.option);
  if (Option.isNone(json)) return null;
  const claims = Option.getOrNull(decodeClaims(json.value));
  if (claims === null || claims.kind !== kind) return null;
  if (claims.expiresAt <= (yield* Clock.currentTimeMillis)) return null;
  return claims;
});
