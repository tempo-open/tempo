/**
 * tempo: the MCP servers (connectors) a thread's Claude has, and signing in to the ones that ask for
 * it. Sign in runs `claude mcp login`, so the token stays in Claude Code's own store.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TempoMcpConnectorStatus = Schema.Literals([
  "connected",
  "needs-auth",
  "failed",
  "pending",
  "disabled",
]);
export type TempoMcpConnectorStatus = typeof TempoMcpConnectorStatus.Type;

export const TempoMcpConnector = Schema.Struct({
  name: Schema.String,
  status: TempoMcpConnectorStatus,
  /** An HTTP or SSE server's address; null for a local command. */
  url: Schema.NullOr(Schema.String),
  toolCount: Schema.Number,
  /** Why it could not connect. */
  error: Schema.NullOr(Schema.String),
});
export type TempoMcpConnector = typeof TempoMcpConnector.Type;

export const TempoMcpConnectorsList = Schema.Struct({
  connectors: Schema.Array(TempoMcpConnector),
  /** False when no Claude was running to ask, so the list is empty. */
  live: Schema.Boolean,
  /** A sign in under way, by server name. */
  signingIn: Schema.NullOr(Schema.String),
});
export type TempoMcpConnectorsList = typeof TempoMcpConnectorsList.Type;

export const TempoMcpConnectorsFailure = Schema.Literals([
  "already-signing-in",
  "cancelled",
  "timed-out",
  "sign-in-failed",
  "not-installed",
  "request-failed",
]);
export type TempoMcpConnectorsFailure = typeof TempoMcpConnectorsFailure.Type;

const FAILURE_MESSAGES: Readonly<Record<TempoMcpConnectorsFailure, string>> = {
  "already-signing-in": "Another sign in is under way. Finish or cancel it first.",
  cancelled: "The sign in was cancelled.",
  "timed-out": "The sign in did not finish within ten minutes.",
  "sign-in-failed": "Claude Code could not sign in to this server.",
  "not-installed": "Could not start Claude Code on this Mac. Check that it is installed.",
  "request-failed": "Claude did not answer. Try again.",
};

export class TempoMcpConnectorsError extends Schema.TaggedError<TempoMcpConnectorsError>()(
  "TempoMcpConnectorsError",
  {
    reason: TempoMcpConnectorsFailure,
    /** Claude Code's own last words, when it says why. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.detail === undefined
      ? FAILURE_MESSAGES[this.reason]
      : `${FAILURE_MESSAGES[this.reason]} ${this.detail}`;
  }
}

export const TEMPO_MCP_CONNECTORS_WS_METHODS = {
  list: "tempo.mcpConnectors.list",
  signIn: "tempo.mcpConnectors.signIn",
  cancelSignIn: "tempo.mcpConnectors.cancelSignIn",
  reconnect: "tempo.mcpConnectors.reconnect",
} as const;

const TempoMcpConnectorsRpcError = Schema.Union([
  TempoMcpConnectorsError,
  EnvironmentAuthorizationError,
]);

/** The thread's own Claude when it runs, else any running Claude on this Mac. */
const TempoMcpConnectorsTarget = Schema.Struct({ threadId: Schema.NullOr(ThreadId) });

export const TempoMcpConnectorsListRpc = Rpc.make(TEMPO_MCP_CONNECTORS_WS_METHODS.list, {
  payload: TempoMcpConnectorsTarget,
  success: TempoMcpConnectorsList,
  error: TempoMcpConnectorsRpcError,
});

/**
 * Runs `claude mcp login`, which opens the server's sign-in page in this Mac's browser, and answers
 * once it ends. Every running Claude that lacked the server then connects it again.
 */
export const TempoMcpConnectorsSignInRpc = Rpc.make(TEMPO_MCP_CONNECTORS_WS_METHODS.signIn, {
  payload: Schema.Struct({ ...TempoMcpConnectorsTarget.fields, name: TrimmedNonEmptyString }),
  success: TempoMcpConnectorsList,
  error: TempoMcpConnectorsRpcError,
});

export const TempoMcpConnectorsCancelSignInRpc = Rpc.make(
  TEMPO_MCP_CONNECTORS_WS_METHODS.cancelSignIn,
  {
    payload: Schema.Struct({}),
    success: Schema.Void,
    error: EnvironmentAuthorizationError,
  },
);

/** Connects a server again in every running Claude where it is not connected. */
export const TempoMcpConnectorsReconnectRpc = Rpc.make(TEMPO_MCP_CONNECTORS_WS_METHODS.reconnect, {
  payload: Schema.Struct({ ...TempoMcpConnectorsTarget.fields, name: TrimmedNonEmptyString }),
  success: TempoMcpConnectorsList,
  error: TempoMcpConnectorsRpcError,
});
