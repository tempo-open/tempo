/**
 * tempo: services agents reach without seeing their keys. Each connection keeps its secret in one
 * environment's secret store. Secrets never leave the server: clients and agents see names, base
 * URLs, and policy only.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

/** `openrouter` and `cloudflare` get typed agent tools; `http` is any other API. */
export const TempoServiceKind = Schema.Literals(["openrouter", "cloudflare", "http"]);
export type TempoServiceKind = typeof TempoServiceKind.Type;

export const TempoServiceMethod = Schema.Literals([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
export type TempoServiceMethod = typeof TempoServiceMethod.Type;

/** Methods that only read. Everything else counts as a write. */
export const TEMPO_SERVICE_READ_METHODS: ReadonlySet<TempoServiceMethod> = new Set(["GET", "HEAD"]);

/** Lowercase letters, digits, and dashes. Tools address it as `local/<name>`. */
const TempoServiceConnectionName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(40),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);

export const TempoServiceConnection = Schema.Struct({
  /** `local/<name>`: what agent tools take as `service`. */
  id: Schema.String,
  name: Schema.String,
  kind: TempoServiceKind,
  description: Schema.String,
  baseUrl: Schema.String,
  allowedMethods: Schema.Array(TempoServiceMethod),
  /** Paths below `baseUrl` requests may reach; empty allows every path. */
  allowedPathPrefixes: Schema.Array(Schema.String),
  /** Whether a write method is allowed. */
  writable: Schema.Boolean,
});
export type TempoServiceConnection = typeof TempoServiceConnection.Type;

/** A local connection as settings shows it. The secret itself is write-only. */
export const TempoLocalServiceConnection = Schema.Struct({
  ...TempoServiceConnection.fields,
  authHeader: Schema.String,
  /** Written before the secret, such as `Bearer`; empty sends the secret alone. */
  authScheme: Schema.String,
});
export type TempoLocalServiceConnection = typeof TempoLocalServiceConnection.Type;

export const TempoServiceConnectionsSnapshot = Schema.Struct({
  local: Schema.Array(TempoLocalServiceConnection),
});
export type TempoServiceConnectionsSnapshot = typeof TempoServiceConnectionsSnapshot.Type;

export const TempoLocalServiceConnectionInput = Schema.Struct({
  name: TempoServiceConnectionName,
  kind: TempoServiceKind,
  description: Schema.optionalKey(TrimmedString.check(Schema.isMaxLength(500))),
  /** https, or http only for loopback hosts. No credentials, query, or fragment. */
  baseUrl: TrimmedNonEmptyString.check(Schema.isMaxLength(2_048)),
  authHeader: TrimmedNonEmptyString.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[A-Za-z0-9-]+$/),
  ),
  authScheme: Schema.optionalKey(
    TrimmedString.check(Schema.isMaxLength(40), Schema.isPattern(/^[A-Za-z0-9._-]*$/)),
  ),
  /** Required for a new connection and when the host changes; omitted keeps the saved one. */
  secret: Schema.optionalKey(
    TrimmedNonEmptyString.check(Schema.isMinLength(8), Schema.isMaxLength(8_192)),
  ),
  /** Defaults to GET only. */
  allowedMethods: Schema.optionalKey(Schema.Array(TempoServiceMethod).check(Schema.isMaxLength(6))),
  /** Empty or omitted allows every path below the base URL. */
  allowedPathPrefixes: Schema.optionalKey(
    Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(512))).check(
      Schema.isMaxLength(50),
    ),
  ),
});
export type TempoLocalServiceConnectionInput = typeof TempoLocalServiceConnectionInput.Type;

export const TempoServiceTestResult = Schema.Struct({
  ok: Schema.Boolean,
  status: Schema.optionalKey(Schema.Int),
  message: Schema.String,
});
export type TempoServiceTestResult = typeof TempoServiceTestResult.Type;

/** A response as agents see it: secrets redacted, headers trimmed to a safe subset. */
export const TempoServiceRequestResult = Schema.Struct({
  /** The connection id the request went through. */
  service: Schema.String,
  status: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  /** Parsed JSON, text, or null for an empty or binary body. */
  body: Schema.Unknown,
  bodyFormat: Schema.Literals(["json", "text", "empty", "binary"]),
  /** The body was cut at 1 MB; it is returned as text. */
  truncated: Schema.Boolean,
});
export type TempoServiceRequestResult = typeof TempoServiceRequestResult.Type;

export const TempoServiceFailureReason = Schema.Literals([
  "not_found",
  "ambiguous",
  "not_configured",
  "method_not_allowed",
  "path_not_allowed",
  "invalid_request",
  "invalid_connection",
  "secret_required",
  "unreachable",
  "bad_response",
  "storage",
  "key_not_saved",
]);
export type TempoServiceFailureReason = typeof TempoServiceFailureReason.Type;

const TEMPO_SERVICE_KIND_LABELS: Readonly<Record<TempoServiceKind, string>> = {
  openrouter: "OpenRouter",
  cloudflare: "Cloudflare",
  http: "HTTP",
};

export function tempoServiceKindLabel(kind: TempoServiceKind): string {
  return TEMPO_SERVICE_KIND_LABELS[kind];
}

const SETTINGS_PATH = "Settings → Integrations → Service connections";

/** Who can change a connection's policy, for refusals an agent cannot fix itself. */
const POLICY_OWNER = ` Ask the user to allow it in ${SETTINGS_PATH}.`;

/** A service connection could not be used, saved, or removed. The message is for people and agents. */
export class TempoServiceError extends Schema.TaggedError<TempoServiceError>()(
  "TempoServiceError",
  {
    reason: TempoServiceFailureReason,
    /** The connection the caller named, as they named it. */
    service: Schema.optionalKey(Schema.String),
    kind: Schema.optionalKey(TempoServiceKind),
    method: Schema.optionalKey(TempoServiceMethod),
    /** What would work instead: allowed methods, path prefixes, or matching connection ids. */
    options: Schema.optionalKey(Schema.Array(Schema.String)),
    /** One fixed sentence from the server saying what to change; never upstream text. */
    detail: Schema.optionalKey(Schema.String),
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    const service = this.service ?? "This service";
    const options = this.options && this.options.length > 0 ? this.options.join(", ") : null;
    const base = (() => {
      switch (this.reason) {
        case "not_found":
          return `No service connection is named ${service}.${options ? ` Known connections: ${options}.` : ""} Call services_list to see what is configured.`;
        case "ambiguous":
          return `${service} matches several connections${options ? `: ${options}` : ""}. Pass one of those ids as service.`;
        case "not_configured":
          return `No ${this.kind ? `${tempoServiceKindLabel(this.kind)} ` : ""}service connection is configured on this environment. Ask the user to add one in ${SETTINGS_PATH}.`;
        case "method_not_allowed":
          return `${service} does not allow ${this.method ?? "that"} requests.${options ? ` Allowed: ${options}.` : ""}${POLICY_OWNER}`;
        case "path_not_allowed":
          return `${service} does not allow that path.${options ? ` Allowed path prefixes: ${options}.` : ""}${POLICY_OWNER}`;
        case "invalid_request":
          return "The request is not valid.";
        case "invalid_connection":
          return "The connection is not valid.";
        case "secret_required":
          return `Enter the secret for ${service}.`;
        case "unreachable":
          return `Could not reach ${service}.`;
        case "bad_response":
          return `${service} answered in an unexpected way. Try again later.`;
        case "storage":
          return "Could not access the service connections saved on this environment.";
        case "key_not_saved":
          return "The new key was created but could not be saved to the file.";
      }
    })();
    return this.detail ? `${base} ${this.detail}` : base;
  }
}

/** Spread into WS_METHODS so every caller names these as `WS_METHODS.tempo*`. */
export const TEMPO_SERVICE_WS_METHODS = {
  tempoListServiceConnections: "tempo.listServiceConnections",
  tempoSaveLocalServiceConnection: "tempo.saveLocalServiceConnection",
  tempoRemoveLocalServiceConnection: "tempo.removeLocalServiceConnection",
  tempoTestServiceConnection: "tempo.testServiceConnection",
} as const;

export const WsTempoListServiceConnectionsRpc = Rpc.make(
  TEMPO_SERVICE_WS_METHODS.tempoListServiceConnections,
  {
    payload: Schema.Struct({}),
    success: TempoServiceConnectionsSnapshot,
    error: Schema.Union([TempoServiceError, EnvironmentAuthorizationError]),
  },
);

/** Adds or replaces the local connection with this name. */
export const WsTempoSaveLocalServiceConnectionRpc = Rpc.make(
  TEMPO_SERVICE_WS_METHODS.tempoSaveLocalServiceConnection,
  {
    payload: TempoLocalServiceConnectionInput,
    success: TempoServiceConnectionsSnapshot,
    error: Schema.Union([TempoServiceError, EnvironmentAuthorizationError]),
  },
);

export const WsTempoRemoveLocalServiceConnectionRpc = Rpc.make(
  TEMPO_SERVICE_WS_METHODS.tempoRemoveLocalServiceConnection,
  {
    payload: Schema.Struct({ name: TempoServiceConnectionName }),
    success: TempoServiceConnectionsSnapshot,
    error: Schema.Union([TempoServiceError, EnvironmentAuthorizationError]),
  },
);

/** Sends one read through the connection, with its secret, and says whether it worked. */
export const WsTempoTestServiceConnectionRpc = Rpc.make(
  TEMPO_SERVICE_WS_METHODS.tempoTestServiceConnection,
  {
    payload: Schema.Struct({ id: TrimmedNonEmptyString.check(Schema.isMaxLength(200)) }),
    success: TempoServiceTestResult,
    error: Schema.Union([TempoServiceError, EnvironmentAuthorizationError]),
  },
);
