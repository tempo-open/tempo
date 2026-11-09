/**
 * Tempo: the structured tool detail an approval card describes in plain words (see `TempoApprovalTool`
 * for why the prompt string is not enough). Every field is cut here, before it goes to clients, so
 * a 100 KB heredoc never rides along; file tools send the path and sizes, never their content.
 */
import { TEMPO_APPROVAL_TOOL_INPUT_LIMIT, type TempoApprovalTool } from "@t3tools/contracts";

const COMMAND_LIMIT = 2_000;
const TEXT_LIMIT = 500;
const FIRST_ARG_LIMIT = 200;

/** Tools whose input carries file content; the approval carries sizes instead. */
const FILE_CONTENT_FIELDS: Readonly<Record<string, ReadonlyArray<string>>> = {
  Write: ["content"],
  Edit: ["old_string", "new_string"],
  MultiEdit: ["edits"],
  NotebookEdit: ["new_source"],
};

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/** Counts code points, so a cut never splits an emoji's surrogate pair. */
function cut(value: string, limit: number): string {
  let end = 0;
  let count = 0;
  for (const point of value) {
    if (count === limit) return `${value.slice(0, end)}…`;
    end += point.length;
    count += 1;
  }
  return value;
}

function firstScalar(record: Record<string, unknown> | undefined): string | undefined {
  for (const value of Object.values(record ?? {})) {
    if (typeof value === "string" && value.trim().length > 0) {
      return cut(value.replace(/\s+/g, " ").trim(), FIRST_ARG_LIMIT);
    }
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function sizeOnly(value: unknown): string {
  if (typeof value === "string") return `[${value.length} chars]`;
  if (Array.isArray(value)) return `[${value.length} edits]`;
  return "[omitted]";
}

function serializeInput(
  toolName: string,
  toolInput: unknown,
  record: Record<string, unknown> | undefined,
): string | undefined {
  const contentFields = FILE_CONTENT_FIELDS[toolName];
  const shown =
    contentFields !== undefined && record !== undefined
      ? Object.fromEntries(
          Object.entries(record).map(([key, value]) => [
            key,
            contentFields.includes(key) ? sizeOnly(value) : value,
          ]),
        )
      : toolInput;
  const serialized = typeof shown === "string" ? shown : JSON.stringify(shown);
  return serialized === undefined ? undefined : cut(serialized, TEMPO_APPROVAL_TOOL_INPUT_LIMIT);
}

export function tempoApprovalTool(
  toolName: string,
  toolInput: unknown,
  providerSubtitle: string | undefined,
): TempoApprovalTool {
  const record =
    toolInput !== null && typeof toolInput === "object" && !Array.isArray(toolInput)
      ? (toolInput as Record<string, unknown>)
      : undefined;
  const input = serializeInput(toolName, toolInput, record);
  const command = trimmedString(record?.command ?? record?.cmd ?? record?.script);
  const path = trimmedString(
    record?.file_path ?? record?.notebook_path ?? record?.path ?? record?.filename,
  );
  const description = toolName === "Bash" ? trimmedString(record?.description) : undefined;
  const subtitle = trimmedString(providerSubtitle);
  const firstArg = firstScalar(record);
  return {
    name: toolName,
    ...(input === undefined ? {} : { input }),
    ...(command === undefined ? {} : { command: cut(command, COMMAND_LIMIT) }),
    ...(path === undefined ? {} : { path: cut(path, TEXT_LIMIT) }),
    ...(firstArg === undefined || contentFields(toolName) ? {} : { firstArg }),
    ...(description === undefined ? {} : { description: cut(description, TEXT_LIMIT) }),
    ...(subtitle === undefined ? {} : { subtitle: cut(subtitle, TEXT_LIMIT) }),
  };
}

function contentFields(toolName: string): boolean {
  return FILE_CONTENT_FIELDS[toolName] !== undefined;
}
