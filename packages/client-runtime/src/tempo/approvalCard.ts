/**
 * Tempo: what a tool-approval card says on web and mobile: a plain-sentence title, an optional second
 * line, a mono line for the command or tool, and the raw input for Details. Older approvals carry
 * only the `Tool: {json}` prompt string, so the tool is read back out of it when `tool` is missing.
 */
import type { TempoApprovalTool, ProviderRequestKind } from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import { T3_MCP_SERVER_ALIASES } from "@t3tools/shared/t3McpToolPresentation";

export interface ApprovalCardInput {
  readonly requestKind: ProviderRequestKind;
  readonly detail?: string | undefined;
  readonly appName?: string | undefined;
  readonly tool?: TempoApprovalTool | undefined;
}

export interface ApprovalCardView {
  /** A plain sentence of what will happen. */
  readonly title: string;
  /** A second muted line, only when the provider supplied one. */
  readonly subtitle: string | null;
  /** The command (`$ git push`) or `App · action · first value`. */
  readonly summaryLine: string | null;
  /** True when `summaryLine` is a shell command rather than a tool summary. */
  readonly isCommand: boolean;
  /** What "Always allow" covers, e.g. `Bash` or `Linear › Create issue`; null when unknown. */
  readonly scopeLabel: string | null;
  /** The complete raw request, for a Details disclosure. */
  readonly rawDetails: string | null;
}

const SUMMARY_VALUE_LIMIT = 80;
const FILE_VERBS: Readonly<Record<string, string>> = {
  Edit: "Edit",
  MultiEdit: "Edit",
  Write: "Write",
  NotebookEdit: "Edit",
  Read: "Read",
  NotebookRead: "Read",
};

/** Cuts before `end`, stepping back one unit so an emoji's surrogate pair stays whole. */
function sliceWhole(text: string, end: number): string {
  const code = text.charCodeAt(end - 1);
  return code >= 0xd800 && code <= 0xdbff ? text.slice(0, end - 1) : text.slice(0, end);
}

/** Keeps line breaks; cuts at the limit. */
function cutText(value: string, limit: number): string {
  const text = value.trim();
  return text.length <= limit ? text : `${sliceWhole(text, limit - 1)}…`;
}

function oneLine(value: string, limit = SUMMARY_VALUE_LIMIT): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${sliceWhole(flat, limit - 1)}…`;
}

function capitalize(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function words(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * `mcp__linear__linear_list_issues` → `{ app: "Linear", action: "List issues" }`. The app's own
 * server (`t3-code`) is Tempo, and the `t3_` its tools repeat (`t3_thread_launch`) is dropped.
 */
export function humanizeMcpToolName(
  name: string,
): { readonly app: string; readonly action: string } | null {
  if (!name.startsWith("mcp__")) return null;
  const rest = name.slice("mcp__".length);
  const split = rest.indexOf("__");
  if (split <= 0) return null;
  const server = rest.slice(0, split);
  const own = T3_MCP_SERVER_ALIASES.has(server.toLowerCase());
  let tool = rest.slice(split + 2);
  for (const prefix of own ? ["t3_"] : [`${server}_`, `${server}-`]) {
    if (tool.toLowerCase().startsWith(prefix.toLowerCase()) && tool.length > prefix.length) {
      tool = tool.slice(prefix.length);
      break;
    }
  }
  const action = capitalize(words(tool).toLowerCase());
  if (own) return { app: TEMPO_APP_BASE_NAME, action };
  const serverWords = words(server);
  const app = serverWords.length <= 3 ? serverWords.toUpperCase() : capitalize(serverWords);
  return { app, action };
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstArgValue(input: Record<string, unknown> | undefined): string | null {
  if (input === undefined) return null;
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim().length > 0) return oneLine(value);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return null;
}

function stringField(input: Record<string, unknown> | undefined, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

/**
 * Claude's own tool names. An older approval's `Tool: ...` prompt is only read
 * back as a tool when it starts with one of these or `mcp__`, so a Codex reason
 * such as "Escalation: needs network" is left as it was.
 */
const KNOWN_CLAUDE_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "BashOutput",
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
  "Read",
  "NotebookRead",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "Task",
  "Agent",
  "Skill",
  "SlashCommand",
  "TodoWrite",
  "KillShell",
  "Monitor",
  "Workflow",
]);

/** Older approvals only have `Tool: {json}`; read the tool back out when it is that shape. */
function toolFromPrompt(detail: string | undefined): TempoApprovalTool | undefined {
  const match = detail === undefined ? null : /^([A-Za-z][\w.-]*): ([\s\S]+)$/.exec(detail);
  if (match === null) return undefined;
  const name = match[1]!;
  if (!KNOWN_CLAUDE_TOOLS.has(name) && !name.startsWith("mcp__")) return undefined;
  const rest = match[2]!;
  if (rest.startsWith("{") || rest.startsWith("[")) return { name, input: rest };
  // `Bash: <command>` and `Edit: <path>` are plain text.
  if (name === "Bash") return { name, command: rest };
  return { name, path: rest };
}

function prettyInput(input: string | undefined): string | null {
  if (input === undefined) return null;
  const parsed = parseJson(input);
  return parsed === undefined ? input : JSON.stringify(parsed, null, 2);
}

function rawDetails(
  tool: TempoApprovalTool | undefined,
  detail: string | undefined,
): string | null {
  if (tool === undefined) return detail ?? null;
  const input = prettyInput(tool.input ?? tool.command);
  const body = input === null ? tool.name : `${tool.name}\n${input}`;
  return detail === undefined ? body : `${body}\n\n${detail}`;
}

/** Claude's tools that run a shell command, so the card shows that command. */
const SHELL_TOOLS: ReadonlySet<string> = new Set(["Bash", "Monitor", "PowerShell"]);

/**
 * Claude usually answers "always" for a file edit by suggesting accept-edits
 * mode for the chat, which covers every file tool. With no suggestion, the
 * adapter's fallback allows only the asking tool, on any file.
 */
const FILE_EDIT_TOOLS: ReadonlySet<string> = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "NotebookEdit",
]);

/** What "Always allow" covers: the tool, named the way the card names it. */
function scopeLabel(tool: TempoApprovalTool): string {
  if (FILE_EDIT_TOOLS.has(tool.name)) return "file edits";
  const mcp = humanizeMcpToolName(tool.name);
  return mcp === null ? tool.name : `${mcp.app} › ${mcp.action}`;
}

const COMMAND_SUMMARY_LIMIT = 400;

export function approvalCardView(input: ApprovalCardInput): ApprovalCardView {
  const detail = input.detail?.trim() === "" ? undefined : input.detail;
  const tool =
    input.tool ?? (input.requestKind === "mcp-elicitation" ? undefined : toolFromPrompt(detail));
  const raw = input.tool === undefined ? (detail ?? null) : rawDetails(tool, detail);
  const base = {
    subtitle: null,
    summaryLine: null,
    isCommand: false,
    rawDetails: raw,
    scopeLabel: null,
  };

  if (tool === undefined) {
    switch (input.requestKind) {
      case "mcp-elicitation":
        return {
          ...base,
          title: detail ?? `${input.appName ?? "An app"} needs your approval`,
          rawDetails: null,
        };
      case "command":
        return {
          ...base,
          title: "Run a command",
          summaryLine: detail === undefined ? null : `$ ${cutText(detail, COMMAND_SUMMARY_LIMIT)}`,
          isCommand: true,
        };
      case "file-read":
        return { ...base, title: "Read a file", summaryLine: detail ?? null };
      case "permission":
        return { ...base, title: detail ?? "Use an app permission", rawDetails: null };
      default:
        return { ...base, title: "Change files", summaryLine: detail ?? null };
    }
  }

  const record = asRecord(parseJson(tool.input));
  const subtitle = tool.subtitle ?? null;
  const scope = scopeLabel(tool);

  // Only Claude's shell tools run a shell; an MCP tool's `command` argument is just an argument.
  if (SHELL_TOOLS.has(tool.name)) {
    const command = tool.command ?? stringField(record, ["command", "cmd", "script"]);
    return {
      ...base,
      title: tool.description ?? "Run a shell command",
      subtitle,
      summaryLine: command === undefined ? null : `$ ${cutText(command, COMMAND_SUMMARY_LIMIT)}`,
      isCommand: true,
      scopeLabel: scope,
    };
  }

  const mcp = humanizeMcpToolName(tool.name);
  if (mcp !== null) {
    const arg = tool.firstArg ?? firstArgValue(record);
    return {
      ...base,
      title: `Use ${mcp.app} › ${mcp.action}`,
      subtitle,
      summaryLine: [mcp.app, mcp.action, arg].filter((part) => part !== null).join(" · "),
      scopeLabel: scope,
    };
  }

  // A cut input has no path left; the prompt string still names it.
  const promptTool = toolFromPrompt(detail);
  const path =
    tool.path ??
    stringField(record, ["file_path", "path", "filename", "fileName", "notebook_path"]) ??
    (promptTool?.name === tool.name ? promptTool.path : undefined);
  const verb = FILE_VERBS[tool.name];
  if (path !== undefined && (verb !== undefined || input.requestKind !== "command")) {
    return {
      ...base,
      title: `${verb ?? (input.requestKind === "file-read" ? "Read" : "Change")} ${path}`,
      subtitle,
      scopeLabel: scope,
    };
  }

  const arg = tool.firstArg ?? firstArgValue(record);
  return {
    ...base,
    title: `Use ${tool.name}`,
    subtitle,
    summaryLine: arg === null ? tool.name : `${tool.name} · ${arg}`,
    scopeLabel: scope,
  };
}

/** The default label of the always-allow button, naming what it covers. */
export function alwaysAllowLabel(view: Pick<ApprovalCardView, "scopeLabel">): string {
  return view.scopeLabel === null
    ? "Always allow in this chat"
    : `Always allow ${view.scopeLabel} in this chat`;
}
