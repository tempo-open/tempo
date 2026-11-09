/**
 * Tempo: Claude workflows and ultracode. Claude Code gates its Workflow tool by plan; Tempo turns
 * workflows on from these provider settings. Ultracode is a per-turn model option (`ultracode: true`), not an effort level, so it
 * composes with any effort the person picked.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { ProviderOptionSelection } from "./model.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// ── Provider settings ─────────────────────────────────────────────────

/** Claude's advisory `workflowSizeGuideline`. The first entry is the form's default. */
const TEMPO_CLAUDE_WORKFLOW_SIZES = [
  { value: "medium", label: "Medium (fewer than 10 agents)" },
  { value: "small", label: "Small (fewer than 5 agents)" },
  { value: "large", label: "Large (fewer than 50 agents)" },
  { value: "unrestricted", label: "Unrestricted" },
] as const;
export const TempoClaudeWorkflowSize = Schema.Literals(
  TEMPO_CLAUDE_WORKFLOW_SIZES.map((size) => size.value),
);
export type TempoClaudeWorkflowSize = typeof TempoClaudeWorkflowSize.Type;

/** Spread into `ClaudeSettings`; the schema-driven settings form renders them. */
export const TempoClaudeWorkflowSettingsFields = {
  workflows: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({
      title: "Workflows",
      description: "Let Claude run multi-agent workflows and ultracode.",
      providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
    }),
  ),
  workflowSize: TempoClaudeWorkflowSize.pipe(
    Schema.withDecodingDefault(Effect.succeed("medium" as const)),
    Schema.annotateKey({
      title: "Workflow size",
      description: "How many agents Claude aims for when it writes a workflow. A guideline only.",
      providerSettingsForm: {
        control: "select",
        options: TEMPO_CLAUDE_WORKFLOW_SIZES,
        clearWhenEmpty: "omit",
      },
    }),
  ),
  ultracodeKeyword: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(true)),
    Schema.annotateKey({
      title: "Ultracode keyword",
      description: 'Writing "ultracode" in a message runs that turn as a workflow.',
      providerSettingsForm: { control: "switch", clearWhenEmpty: "omit" },
    }),
  ),
} as const;

export const TEMPO_CLAUDE_WORKFLOW_SETTINGS_ORDER = [
  "workflows",
  "workflowSize",
  "ultracodeKeyword",
] as const;

// ── Ultracode model option ────────────────────────────────────────────

/** The boolean model option Claude threads carry when ultracode is on. */
export const TEMPO_CLAUDE_ULTRACODE_OPTION_ID = "ultracode";
/** Effort id older threads used before ultracode became its own toggle. */
export const TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT = "ultracode";

/** Whether a Claude selection asks for ultracode, including the legacy effort spelling. */
export function isTempoClaudeUltracodeSelected(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): boolean {
  return (options ?? []).some(
    (option) =>
      (option.id === TEMPO_CLAUDE_ULTRACODE_OPTION_ID && option.value === true) ||
      (option.id === "effort" && option.value === TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT),
  );
}

/** Returns the options with ultracode set, dropping the legacy effort spelling. */
export function withTempoClaudeUltracode(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
  enabled: boolean,
): ReadonlyArray<ProviderOptionSelection> {
  const rest = (options ?? []).filter(
    (option) =>
      option.id !== TEMPO_CLAUDE_ULTRACODE_OPTION_ID &&
      !(option.id === "effort" && option.value === TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT),
  );
  return [...rest, { id: TEMPO_CLAUDE_ULTRACODE_OPTION_ID, value: enabled }];
}

// ── Workflow approval ─────────────────────────────────────────────────

/** Characters of a workflow script an approval carries for display. */
export const TEMPO_CLAUDE_WORKFLOW_APPROVAL_SCRIPT_LIMIT = 32_000;

/**
 * What a Claude Workflow tool call asks to run, set by the Claude adapter on its approval so
 * clients can show the workflow instead of its raw input. `script` is what the CLI will run (the
 * file at `scriptPath` when there is one, which the CLI prefers, else the inline script), cut to
 * the display limit; `scriptLength` is the full length whenever it was cut.
 */
export const TempoClaudeWorkflowApproval = Schema.Struct({
  /** A saved workflow run by name. */
  name: Schema.optional(Schema.String),
  scriptPath: Schema.optional(Schema.String),
  script: Schema.optional(Schema.String),
  scriptLength: Schema.optional(Schema.Number),
  resumeFromRunId: Schema.optional(Schema.String),
});
export type TempoClaudeWorkflowApproval = typeof TempoClaudeWorkflowApproval.Type;

// ── Saved workflows ───────────────────────────────────────────────────

/**
 * A saved workflow script from `.claude/workflows/*.js`. Claude Code reads its
 * `export const meta = { name, description, phases }` header and the model
 * runs it through the Workflow tool's `name` argument.
 */
export const TempoClaudeSavedWorkflow = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  phases: Schema.Array(TrimmedNonEmptyString),
  scope: Schema.Literals(["project", "user"]),
  path: TrimmedNonEmptyString,
});
export type TempoClaudeSavedWorkflow = typeof TempoClaudeSavedWorkflow.Type;

export const TempoListClaudeSavedWorkflowsInput = Schema.Struct({
  /** The thread's working directory; a worktree reads its main checkout's workflows. */
  cwd: TrimmedNonEmptyString,
  /** The Claude instance whose config dir holds the user-level workflows. */
  instanceId: Schema.optional(ProviderInstanceId),
});
export type TempoListClaudeSavedWorkflowsInput = typeof TempoListClaudeSavedWorkflowsInput.Type;

export const TempoListClaudeSavedWorkflowsResult = Schema.Struct({
  workflows: Schema.Array(TempoClaudeSavedWorkflow),
});
export type TempoListClaudeSavedWorkflowsResult = typeof TempoListClaudeSavedWorkflowsResult.Type;

export class TempoClaudeWorkflowsError extends Schema.TaggedError<TempoClaudeWorkflowsError>()(
  "TempoClaudeWorkflowsError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to list saved Claude workflows.";
  }
}

export const TEMPO_CLAUDE_WORKFLOWS_WS_METHODS = {
  listSaved: "tempo.claudeWorkflows.listSaved",
} as const;

/** The prompt that asks Claude to run a saved workflow by name. */
export function tempoRunSavedWorkflowPrompt(name: string): string {
  return `Run the "${name}" workflow.`;
}
