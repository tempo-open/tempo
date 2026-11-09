/**
 * tempo laptop tools: MCP servers on the person's laptop (the desktop app) that agents on a remote
 * environment may call with their consent. The desktop registers as a host over the environment
 * WebSocket, gets requests on that stream, and answers each one with `clientTools.respond`.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  EnvironmentId,
  PositiveInt,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  DesktopPasskeysState,
  LaptopPasskeyOutcome,
  LaptopPasskeyRequest,
} from "./tempoPasskeys.ts";

export const LAPTOP_TOOLS_WS_METHODS = {
  connect: "clientTools.connect",
  respond: "clientTools.respond",
} as const;

/** Stable id of one configured MCP server, such as `computer-use`. */
export const LaptopToolServerId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
);
export type LaptopToolServerId = typeof LaptopToolServerId.Type;

/** One desktop window's registration with one environment; new on every app launch. */
export const LaptopToolHostId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type LaptopToolHostId = typeof LaptopToolHostId.Type;

export const LaptopToolServer = Schema.Struct({
  id: LaptopToolServerId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
});
export type LaptopToolServer = typeof LaptopToolServer.Type;

/** The `_tag` of a `LaptopToolsRequest`; kept open so a newer request kind still decodes. */
export const LaptopToolsRequestKind = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/**
 * What a desktop offers an environment when it connects, even with no tool turned on. `accepts`
 * lists the request kinds it understands and the environment sends it no other, so new kinds
 * (such as passkeys) never reach a desktop that cannot decode them.
 */
export const LaptopToolsHostRegistration = Schema.Struct({
  hostId: LaptopToolHostId,
  /** The laptop's name, as the agent and the consent prompt show it. */
  hostLabel: TrimmedNonEmptyString.check(Schema.isMaxLength(120)),
  servers: Schema.Array(LaptopToolServer).check(Schema.isMaxLength(32)),
  accepts: Schema.Array(LaptopToolsRequestKind).check(Schema.isMaxLength(32)),
});
export type LaptopToolsHostRegistration = typeof LaptopToolsHostRegistration.Type;

export const LaptopToolDescriptor = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  description: Schema.optional(Schema.String),
  inputSchema: Schema.optional(Schema.Unknown),
});
export type LaptopToolDescriptor = typeof LaptopToolDescriptor.Type;

export const LaptopToolServerTools = Schema.Struct({
  id: LaptopToolServerId,
  name: Schema.String,
  tools: Schema.Array(LaptopToolDescriptor),
  /** Set when the server could not be started or listed; `tools` is then empty. */
  error: Schema.optional(Schema.String),
});
export type LaptopToolServerTools = typeof LaptopToolServerTools.Type;

/**
 * MCP content blocks the environment passes to the agent unchanged. The
 * desktop turns any other block kind into a text block.
 */
export const LaptopToolContent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("image"),
    /** Base64, as MCP carries it. */
    data: Schema.String,
    mimeType: Schema.String.check(Schema.isMaxLength(100)),
  }),
]);
export type LaptopToolContent = typeof LaptopToolContent.Type;

export const LaptopToolCallResult = Schema.Struct({
  content: Schema.Array(LaptopToolContent),
  isError: Schema.optional(Schema.Boolean),
  structuredContent: Schema.optional(Schema.Unknown),
});
export type LaptopToolCallResult = typeof LaptopToolCallResult.Type;

export const LaptopToolsListRequest = Schema.TaggedStruct("listTools", {});

export const LaptopToolsCallRequest = Schema.TaggedStruct("callTool", {
  threadId: ThreadId,
  /** The thread's title, for the consent prompt. */
  threadTitle: Schema.String,
  /** The thread's active run. Grants last one run: a new run asks again. */
  runId: RunId,
  serverId: LaptopToolServerId,
  tool: Schema.String.check(Schema.isMaxLength(128)),
  arguments: Schema.Record(Schema.String, Schema.Unknown),
  timeoutMs: PositiveInt,
});
export type LaptopToolsCallRequest = typeof LaptopToolsCallRequest.Type;

export const LaptopToolsRequest = Schema.Union([
  LaptopToolsListRequest,
  LaptopToolsCallRequest,
  // tempo passkeys: a server tab's passkey ceremony, run on the person's Mac (tempoPasskeys.ts).
  LaptopPasskeyRequest,
]);
export type LaptopToolsRequest = typeof LaptopToolsRequest.Type;

/**
 * The request kinds this build's desktop answers. A desktop that cannot run
 * passkeys right now leaves `passkey` out of its registration.
 */
export const LAPTOP_TOOLS_REQUEST_KINDS: ReadonlyArray<LaptopToolsRequest["_tag"]> = [
  "listTools",
  "callTool",
  "passkey",
];

export const LaptopToolsConnectionId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const LaptopToolsStreamEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("connected"), connectionId: LaptopToolsConnectionId }),
  Schema.Struct({
    type: Schema.Literal("request"),
    connectionId: LaptopToolsConnectionId,
    requestId: TrimmedNonEmptyString,
    request: LaptopToolsRequest,
  }),
  /** The agent stopped waiting: stop the call and drop its answer. */
  Schema.Struct({
    type: Schema.Literal("cancel"),
    connectionId: LaptopToolsConnectionId,
    requestId: TrimmedNonEmptyString,
  }),
]);
export type LaptopToolsStreamEvent = typeof LaptopToolsStreamEvent.Type;

export const LaptopToolsFailureCode = Schema.Literals([
  /** The person said no, or stopped the tool. */
  "denied",
  "server-not-found",
  "server-unavailable",
  "timeout",
  "cancelled",
  "too-large",
  "failed",
]);
export type LaptopToolsFailureCode = typeof LaptopToolsFailureCode.Type;

export const LaptopToolsOutcome = Schema.Union([
  Schema.TaggedStruct("tools", { servers: Schema.Array(LaptopToolServerTools) }),
  Schema.TaggedStruct("result", { result: LaptopToolCallResult }),
  Schema.TaggedStruct("failure", {
    code: LaptopToolsFailureCode,
    message: Schema.String.check(Schema.isMaxLength(500)),
  }),
  LaptopPasskeyOutcome,
]);
export type LaptopToolsOutcome = typeof LaptopToolsOutcome.Type;

export const LaptopToolsResponse = Schema.Struct({
  hostId: LaptopToolHostId,
  connectionId: LaptopToolsConnectionId,
  requestId: TrimmedNonEmptyString,
  outcome: LaptopToolsOutcome,
});
export type LaptopToolsResponse = typeof LaptopToolsResponse.Type;

export const WsLaptopToolsConnectRpc = Rpc.make(LAPTOP_TOOLS_WS_METHODS.connect, {
  payload: LaptopToolsHostRegistration,
  success: LaptopToolsStreamEvent,
  error: EnvironmentAuthorizationError,
  stream: true,
});

export const WsLaptopToolsRespondRpc = Rpc.make(LAPTOP_TOOLS_WS_METHODS.respond, {
  payload: LaptopToolsResponse,
  error: EnvironmentAuthorizationError,
});

// Agent-facing MCP tools.

export const LaptopToolsListInput = Schema.Struct({
  hostId: Schema.optional(
    LaptopToolHostId.annotate({
      description: "Only this laptop. Defaults to every connected laptop.",
    }),
  ),
});

export const LaptopToolsHostTools = Schema.Struct({
  hostId: LaptopToolHostId,
  hostLabel: Schema.String,
  servers: Schema.Array(LaptopToolServerTools),
});

export const LaptopToolsListResult = Schema.Struct({
  hosts: Schema.Array(LaptopToolsHostTools),
});
export type LaptopToolsListResult = typeof LaptopToolsListResult.Type;

export const LAPTOP_TOOL_CALL_DEFAULT_TIMEOUT_MS = 120_000;
/**
 * Below the shortest wait a provider gives one MCP tool call: Codex stops
 * after 300 s unless `tool_timeout_sec` is set, Claude after 65 minutes (set
 * by its adapter). ACP providers have not been measured; a longer wait there
 * fails as that provider's own timeout.
 */
const LAPTOP_TOOL_CALL_MAX_TIMEOUT_MS = 270_000;

export const LaptopToolCallInput = Schema.Struct({
  server: LaptopToolServerId.annotate({
    description: "The laptop tool server id from laptop_tools_list, such as computer-use.",
  }),
  tool: Schema.String.check(Schema.isMaxLength(128)).annotate({
    description: "The tool name on that server.",
  }),
  arguments: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown).annotate({
      description: "The tool's arguments, matching its inputSchema.",
    }),
  ),
  hostId: Schema.optional(
    LaptopToolHostId.annotate({
      description: "Which laptop, when more than one is connected.",
    }),
  ),
  timeoutMs: Schema.optional(
    PositiveInt.check(Schema.isLessThanOrEqualTo(LAPTOP_TOOL_CALL_MAX_TIMEOUT_MS)).annotate({
      description: `How long to wait in milliseconds, including for the person to allow the call. Default ${LAPTOP_TOOL_CALL_DEFAULT_TIMEOUT_MS}, at most ${LAPTOP_TOOL_CALL_MAX_TIMEOUT_MS}.`,
    }),
  ),
});
export type LaptopToolCallInput = typeof LaptopToolCallInput.Type;

/** Every laptop tool failure an agent sees; the reason says what to do next. */
export class LaptopToolsUnavailableError extends Schema.TaggedError<LaptopToolsUnavailableError>()(
  "LaptopToolsUnavailableError",
  {
    reason: Schema.String,
    code: Schema.optional(LaptopToolsFailureCode),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason;
  }
}

// Desktop configuration, shared by the desktop main process and its renderer.

export const LAPTOP_COMPUTER_USE_SERVER_ID = "computer-use";
export const LAPTOP_BROWSER_SERVER_ID = "laptop-browser";

export const DesktopLaptopToolServerConfig = Schema.Struct({
  id: LaptopToolServerId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  command: TrimmedNonEmptyString.check(Schema.isMaxLength(1024)),
  args: Schema.Array(Schema.String.check(Schema.isMaxLength(4096))).check(Schema.isMaxLength(64)),
  enabled: Schema.Boolean,
});
export type DesktopLaptopToolServerConfig = typeof DesktopLaptopToolServerConfig.Type;

export const DesktopLaptopToolsConfig = Schema.Struct({
  /** Built-ins are present with their defaults until the person changes them. */
  servers: Schema.Array(DesktopLaptopToolServerConfig).check(Schema.isMaxLength(32)),
  /** The laptop browser uses the person's own Chrome profile instead of an isolated one. */
  laptopBrowserUsesRealProfile: Schema.Boolean,
  /** tempo passkeys: false stops this Mac answering server tabs' passkey requests. On when absent. */
  answerPasskeys: Schema.optionalKey(Schema.Boolean),
  /**
   * Ask on this laptop before a thread's run first uses a tool. Off when
   * absent: turning a tool on is the consent, and Stop still ends a run's use.
   */
  askBeforeUse: Schema.optionalKey(Schema.Boolean),
});
export type DesktopLaptopToolsConfig = typeof DesktopLaptopToolsConfig.Type;

export const DesktopLaptopToolServerStatus = Schema.Struct({
  id: LaptopToolServerId,
  name: Schema.String,
  enabled: Schema.Boolean,
  builtIn: Schema.Boolean,
  /** The command resolved on PATH, or null when it was not found. */
  resolvedCommand: Schema.NullOr(Schema.String),
  /** Why the command was refused before looking it up. */
  invalidReason: Schema.optional(Schema.String),
  running: Schema.Boolean,
  /** How many tools agents see for it, or null before it was ever listed. */
  toolCount: Schema.NullOr(Schema.Number),
  /** Why listing its tools failed, when it last did. */
  listError: Schema.optional(Schema.String),
});
export type DesktopLaptopToolServerStatus = typeof DesktopLaptopToolServerStatus.Type;

export const DesktopLaptopToolGrant = Schema.Struct({
  key: Schema.String,
  environmentId: EnvironmentId,
  environmentLabel: Schema.String,
  threadId: ThreadId,
  threadTitle: Schema.String,
  serverId: LaptopToolServerId,
  serverName: Schema.String,
  runId: RunId,
  grantedAt: Schema.Number,
  lastUsedAt: Schema.Number,
  inFlight: Schema.Number,
});
export type DesktopLaptopToolGrant = typeof DesktopLaptopToolGrant.Type;

export const DesktopLaptopToolsState = Schema.Struct({
  hostLabel: Schema.String,
  config: DesktopLaptopToolsConfig,
  servers: Schema.Array(DesktopLaptopToolServerStatus),
  grants: Schema.Array(DesktopLaptopToolGrant),
  /** tempo passkeys: whether this laptop can run passkeys for server tabs, and the ones it is running. */
  passkeys: Schema.optionalKey(DesktopPasskeysState),
});
export type DesktopLaptopToolsState = typeof DesktopLaptopToolsState.Type;

export const DesktopLaptopToolsHandleInput = Schema.Struct({
  environmentId: EnvironmentId,
  /** The environment's name on this laptop, for the consent prompt. */
  environmentLabel: Schema.String.check(Schema.isMaxLength(200)),
  requestId: TrimmedNonEmptyString,
  request: LaptopToolsRequest,
});
export type DesktopLaptopToolsHandleInput = typeof DesktopLaptopToolsHandleInput.Type;

export const DesktopLaptopToolsCancelInput = Schema.Struct({
  environmentId: EnvironmentId,
  requestId: TrimmedNonEmptyString,
});
export type DesktopLaptopToolsCancelInput = typeof DesktopLaptopToolsCancelInput.Type;

/** Revokes one grant, or every grant when `key` is absent, and stops their calls. */
export const DesktopLaptopToolsStopInput = Schema.Struct({
  key: Schema.optional(Schema.String),
});
export type DesktopLaptopToolsStopInput = typeof DesktopLaptopToolsStopInput.Type;

/** A thread's run is no longer the one its grants were given for. */
export const DesktopLaptopToolsRunChangedInput = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  activeRunId: Schema.NullOr(RunId),
});
export type DesktopLaptopToolsRunChangedInput = typeof DesktopLaptopToolsRunChangedInput.Type;

/** `window.desktopBridge.laptopTools`, present in desktop builds that host laptop tools. */
export interface DesktopLaptopToolsBridge {
  readonly getState: () => Promise<DesktopLaptopToolsState>;
  readonly setConfig: (config: DesktopLaptopToolsConfig) => Promise<DesktopLaptopToolsState>;
  readonly handleRequest: (input: DesktopLaptopToolsHandleInput) => Promise<LaptopToolsOutcome>;
  readonly cancelRequest: (input: DesktopLaptopToolsCancelInput) => Promise<void>;
  readonly stop: (input: DesktopLaptopToolsStopInput) => Promise<void>;
  readonly runChanged: (input: DesktopLaptopToolsRunChangedInput) => Promise<void>;
  readonly onState: (listener: (state: DesktopLaptopToolsState) => void) => () => void;
}
