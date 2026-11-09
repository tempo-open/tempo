/**
 * Tempo: what a tool-approval card needs to say in plain words.
 *
 * The approval's `prompt` is one string, `Tool: {json}` cut at 400 characters,
 * which cannot be parsed back reliably. The Claude adapter carries these fields
 * beside it so clients can write a sentence and keep the raw input reachable.
 */
import * as Schema from "effect/Schema";

/** Characters of the tool's JSON input an approval carries for display. */
export const TEMPO_APPROVAL_TOOL_INPUT_LIMIT = 8_000;

export const TempoApprovalTool = Schema.Struct({
  /** The provider's tool id, e.g. `Bash` or `mcp__github__list_issues`. */
  name: Schema.String,
  /** The tool input as JSON, cut at the display limit. */
  input: Schema.optional(Schema.String),
  /** The file the tool reads or changes; taken before any cut. */
  path: Schema.optional(Schema.String),
  /** The first plain argument value, taken before any cut (not set for file-content tools). */
  firstArg: Schema.optional(Schema.String),
  /** The shell command, for a command tool, cut at about 2,000 characters. */
  command: Schema.optional(Schema.String),
  /** The model's own one-line description of what the call does (Bash `description`). */
  description: Schema.optional(Schema.String),
  /** A second plain line the provider supplied for the request, when it has one. */
  subtitle: Schema.optional(Schema.String),
});
export type TempoApprovalTool = typeof TempoApprovalTool.Type;
