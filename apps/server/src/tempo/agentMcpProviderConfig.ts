/**
 * How the Claude and Codex adapters attach the MCP servers configured in settings, and the hold on
 * MCP tools that send a message to a person: in full access they still wait for the person. Reads
 * never ask. Keep the hold out of `t3_environment_preferences_update`: no agent may switch it off.
 */
import type {
  CanUseTool,
  HookCallbackMatcher,
  HookEvent,
  HookJSONOutput,
  PermissionResult,
} from "@anthropic-ai/claude-agent-sdk";
import {
  type McpProviderSessionConfig,
  mcpExtraServerEntries,
} from "@t3tools/provider-core/server/mcpSession";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/** Tempo: any word of a tool's name that says it sends something to a person. */
const PERSON_MESSAGE_WORD =
  /^(send|sms|reply|replies|respond|invite|invites|post|posts|comment|comments|forward|dm|tweet|notify)$/;
/** Tempo: these say so only first: `modify_doc_text` edits a doc, `apply_labels_to_emails` files mail. */
const PERSON_MESSAGE_VERB = /^(text|texts|email|emails|mail)$/;
/** Tempo: the earliest of these or of the words above decides, so `list_document_comments` only reads. */
const NOT_A_MESSAGE_WORD =
  /^(get|list|read|search|find|fetch|query|check|count|view|lookup|describe|export|delete|remove)$/;
/** Tempo: names that mention a message and send none: a draft, a reaction, code or an agent session. */
const NOT_A_MESSAGE_NAME = /(^|_)(reactions?|session|send_code)(_|$)/;
const DRAFT_NAME = /(^|_)drafts?(_|$)/;
const SEND_DRAFT_NAME = /(^|_)send_drafts?(_|$)/;
const SCHEDULED_MESSAGE_NAME = /(^|_)schedule_message(_|$)/;
/** Tempo: calendar writes reach people only through their invites, so these look at the attendees. */
const CALENDAR_WRITE_NAME = /(^|_)(manage_event|calendar_(create|update|cancel)_events?)$/;
const NAMES_ATTENDEES = /"attendees":\s*\[\s*[^\]\s]/;

/**
 * Tempo: whether a tool's name or title reads as sending to a person. It takes names and the titles
 * Codex shows ("Send message"), and judges words, not the server: no list can name every connector.
 */
function readsAsPersonMessage(tool: string, toolInput?: unknown): boolean {
  const words = tool
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
  const name = words.join("_");
  if (CALENDAR_WRITE_NAME.test(name)) {
    return toolInput !== undefined && NAMES_ATTENDEES.test(JSON.stringify(toolInput));
  }
  if (NOT_A_MESSAGE_NAME.test(name)) return false;
  if (DRAFT_NAME.test(name) && !SEND_DRAFT_NAME.test(name)) return false;
  if (SCHEDULED_MESSAGE_NAME.test(name)) return true;
  const first = words[0] === "tool" || words[0] === "action" ? words[1] : words[0];
  if (first !== undefined && PERSON_MESSAGE_VERB.test(first)) return true;
  for (const word of words) {
    if (NOT_A_MESSAGE_WORD.test(word)) return false;
    if (PERSON_MESSAGE_WORD.test(word)) return true;
  }
  return false;
}

const CLAUDE_MCP_TOOL_NAME = /^mcp__(.+?)__(.+)$/;

/**
 * Tempo: whether a Claude tool is an MCP tool that sends to a person, so it waits for a yes in full
 * access. t3-code talks to other threads.
 */
export function isClaudePeopleMessageTool(toolName: string, toolInput?: unknown): boolean {
  const match = CLAUDE_MCP_TOOL_NAME.exec(toolName);
  if (match === null) return false;
  const [, server, tool] = match;
  if (server === "t3-code") return false;
  return readsAsPersonMessage(tool!, toolInput);
}

const CODEX_APPROVAL_TOOL = /\brun tool "([^"]+)"/;

/**
 * Tempo: full access runs an MCP tool Codex asks about at once, unless it sends to a person. Codex asks
 * in `Allow the x MCP server to run tool "y"?`; a question in any other form still reaches the person.
 */
export function codexFullAccessAnswersMcpApproval(request: {
  readonly serverName: string;
  readonly message: string;
  readonly meta: unknown;
}): boolean {
  if (!isRecord(request.meta) || request.meta["codex_approval_kind"] !== "mcp_tool_call") {
    return false;
  }
  if (request.serverName === "t3-code") return true;
  const tool = CODEX_APPROVAL_TOOL.exec(request.message)?.[1];
  return tool !== undefined && !readsAsPersonMessage(tool, request.meta["tool_params"]);
}

const extraServers = (session: McpProviderSessionConfig | undefined) =>
  mcpExtraServerEntries(session, ["t3-code"]);

/** Claude `mcpServers` entries for the configured servers. Their tools follow the thread's mode. */
export function claudeTempoMcpServers(session: McpProviderSessionConfig | undefined): Readonly<
  Record<
    string,
    {
      readonly type: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  >
> {
  return Object.fromEntries(
    extraServers(session).map((server) => [
      server.name,
      { type: "http" as const, url: server.url, headers: { ...server.headers } },
    ]),
  );
}

/**
 * How long Claude waits on the hook, and so on the person. A hook that times out
 * does not stop the tool, so the hook itself denies a little before this.
 */
const CLAUDE_APPROVAL_HOOK_TIMEOUT_SECONDS = 24 * 60 * 60;
const CLAUDE_APPROVAL_DEADLINE = Duration.seconds(CLAUDE_APPROVAL_HOOK_TIMEOUT_SECONDS - 10 * 60);

/** Asks the person about one tool call, the way the thread's permission callback would. */
export type ClaudeApprove<E = never> = (request: {
  readonly toolName: string;
  readonly toolInput: Record<string, unknown>;
  readonly toolUseId: string;
  readonly signal: AbortSignal;
}) => Effect.Effect<PermissionResult | null, E>;

const preToolUseDecision = (
  decision: "allow" | "deny",
  extra: { readonly reason?: string; readonly updatedInput?: Record<string, unknown> } = {},
): HookJSONOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: decision,
    ...(extra.reason === undefined ? {} : { permissionDecisionReason: extra.reason }),
    ...(extra.updatedInput === undefined ? {} : { updatedInput: extra.updatedInput }),
  },
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Claude `hooks`: Tempo: full access holds any MCP tool that sends to a person. PreToolUse hooks run
 * before settings allow rules, so a project's settings cannot change the answer. Claude may still
 * call the permission callback after a hook "allow": wrap it with `skipHookApprovedToolUses` and the
 * same `approvedToolUses`.
 */
export function claudePeopleMessageHooks<E>(input: {
  /** Tempo: the thread is in full access, so only messages to people still ask. */
  readonly fullAccess?: boolean;
  readonly approve: ClaudeApprove<E>;
  /** Tool use ids the hook allowed, for `skipHookApprovedToolUses`. */
  readonly approvedToolUses?: Set<string>;
  /** Runs `approve` with the adapter's services. */
  readonly runPromise: <A>(effect: Effect.Effect<A>) => Promise<A>;
}): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  const approvedForSession = new Set<string>();
  const askPerson = async (request: {
    readonly toolName: string;
    readonly toolInput: unknown;
    readonly toolUseId: string;
    readonly signal: AbortSignal;
  }): Promise<HookJSONOutput> => {
    // Fails closed: a hook that throws or times out would let the tool run.
    const result = await input
      .runPromise(
        input
          .approve({
            toolName: request.toolName,
            toolInput: isRecord(request.toolInput) ? request.toolInput : {},
            toolUseId: request.toolUseId,
            signal: request.signal,
          })
          .pipe(
            Effect.timeoutOption(CLAUDE_APPROVAL_DEADLINE),
            Effect.map(Option.getOrNull),
            Effect.catchCause(() => Effect.succeed(null)),
          ),
      )
      .catch(() => null);
    if (result?.behavior !== "allow") {
      return preToolUseDecision("deny", {
        reason:
          result?.behavior === "deny" ? result.message : "The person did not approve this message.",
      });
    }
    if ((result.updatedPermissions?.length ?? 0) > 0) approvedForSession.add(request.toolName);
    input.approvedToolUses?.add(request.toolUseId);
    return preToolUseDecision(
      "allow",
      result.updatedInput === undefined ? {} : { updatedInput: result.updatedInput },
    );
  };
  return {
    PreToolUse: [
      {
        matcher: "mcp__.*",
        timeout: CLAUDE_APPROVAL_HOOK_TIMEOUT_SECONDS,
        hooks: [
          async (hookInput, toolUseId, { signal }) => {
            if (hookInput.hook_event_name !== "PreToolUse") return {};
            const toolName = hookInput.tool_name;
            if (!isClaudePeopleMessageTool(toolName, hookInput.tool_input)) return {};
            // Any other mode asks by itself. The mode on the hook is the live one; the session may
            // have opened in another, such as plan.
            const fullAccess =
              hookInput.permission_mode === undefined
                ? input.fullAccess === true
                : hookInput.permission_mode === "bypassPermissions";
            if (!fullAccess) return {};
            const useId = toolUseId ?? hookInput.tool_use_id;
            if (approvedForSession.has(toolName)) {
              input.approvedToolUses?.add(useId);
              return preToolUseDecision("allow");
            }
            return askPerson({
              toolName,
              toolInput: hookInput.tool_input,
              toolUseId: useId,
              signal,
            });
          },
        ],
      },
    ],
  };
}

/**
 * The thread's permission callback, answering "allow" at once for a tool call an approval hook just
 * allowed (each allow is used once).
 */
export function skipHookApprovedToolUses(
  canUseTool: CanUseTool,
  approvedToolUses: Set<string>,
): CanUseTool {
  return (toolName, toolInput, options) =>
    approvedToolUses.delete(options.toolUseID)
      ? Promise.resolve({ behavior: "allow", updatedInput: toolInput })
      : canUseTool(toolName, toolInput, options);
}

/**
 * Codex `mcp_servers` entries for the configured servers. Codex reads them when the session starts;
 * their tools follow the thread's mode.
 */
export function codexTempoMcpServers(
  session: McpProviderSessionConfig | undefined,
): Readonly<
  Record<string, { readonly url: string; readonly http_headers: Readonly<Record<string, string>> }>
> {
  return Object.fromEntries(
    extraServers(session).map((server) => [
      server.name,
      { url: server.url, http_headers: { ...server.headers } },
    ]),
  );
}
