/**
 * Tempo: how Claude sessions get workflows and ultracode. Claude Code enables the Workflow tool "by
 * plan", so every Tempo session states the workflow flags explicitly, whatever plan its login has. The
 * Artifact tool is always off.
 */
import {
  ClaudeSettings,
  TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT,
  TEMPO_CLAUDE_ULTRACODE_OPTION_ID,
  TEMPO_CLAUDE_WORKFLOW_APPROVAL_SCRIPT_LIMIT,
  TEMPO_CLAUDE_WORKFLOW_SETTINGS_ORDER,
  type TempoClaudeWorkflowApproval,
  type TempoClaudeWorkflowSize,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { parseClaudeWorkflowMeta } from "@t3tools/shared/tempoClaudeWorkflowMeta";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

/** The Claude provider settings Tempo applies to sessions without restarting them. */
export type TempoClaudeWorkflowSettings = Pick<
  ClaudeSettings,
  "workflows" | "workflowSize" | "ultracodeKeyword"
>;

export function tempoClaudeWorkflowSettingsOf(settings: TempoClaudeWorkflowSettings) {
  return {
    workflows: settings.workflows,
    workflowSize: settings.workflowSize,
    ultracodeKeyword: settings.ultracodeKeyword,
  } satisfies TempoClaudeWorkflowSettings;
}

const decodeClaudeSettings = Schema.decodeUnknownEffect(ClaudeSettings);

/**
 * The workflow settings of a Claude instance, live: the instance registry
 * applies a change to them in place (`ProviderInstance.liveConfig`) rather
 * than rebuilding the instance, which would stop every running workflow.
 * Sessions pick the new values up on their next turn.
 */
export const makeTempoClaudeLiveWorkflowSettings = Effect.fn("makeTempoClaudeLiveWorkflowSettings")(
  function* (settings: TempoClaudeWorkflowSettings) {
    const ref = yield* Ref.make(tempoClaudeWorkflowSettingsOf(settings));
    const liveConfig = {
      keys: TEMPO_CLAUDE_WORKFLOW_SETTINGS_ORDER,
      apply: (config: unknown) =>
        decodeClaudeSettings(config ?? {}).pipe(
          Effect.flatMap((decoded) => Ref.set(ref, tempoClaudeWorkflowSettingsOf(decoded))),
          Effect.catch((cause) =>
            Effect.logWarning("Ignoring an invalid Claude workflow settings change", { cause }),
          ),
        ),
    };
    return { ref, liveConfig };
  },
);

export interface TempoClaudeWorkflowFlagSettings {
  readonly enableWorkflows: boolean;
  readonly workflowSizeGuideline?: TempoClaudeWorkflowSize;
  readonly workflowKeywordTriggerEnabled?: boolean;
  readonly enableArtifact: false;
}

/** The flag-layer settings every Tempo Claude session starts with. */
export function tempoClaudeWorkflowFlagSettings(
  settings: TempoClaudeWorkflowSettings,
): TempoClaudeWorkflowFlagSettings {
  if (!settings.workflows) return { enableWorkflows: false, enableArtifact: false };
  return {
    enableWorkflows: true,
    workflowSizeGuideline: settings.workflowSize,
    workflowKeywordTriggerEnabled: settings.ultracodeKeyword,
    enableArtifact: false,
  };
}

/**
 * The settings a session opens with: Tempo's workflow flags under the model
 * selection's own. Ultracode runs as a workflow, so it is dropped while the
 * instance has workflows off.
 */
export function tempoClaudeQuerySettings(
  settings: TempoClaudeWorkflowSettings,
  selectionSettings: Readonly<Record<string, boolean>> | undefined,
): Readonly<Record<string, unknown>> {
  const { ultracode, ...rest } = selectionSettings ?? {};
  return {
    ...tempoClaudeWorkflowFlagSettings(settings),
    ...rest,
    ...(ultracode === true && settings.workflows ? { ultracode: true } : {}),
  };
}

/** Keys Tempo owns in the flag layer; replay fixtures predate them. */
export const TEMPO_CLAUDE_FLAG_SETTING_KEYS: ReadonlyArray<string> = [
  "enableWorkflows",
  "workflowSizeGuideline",
  "workflowKeywordTriggerEnabled",
  "enableArtifact",
];

const FLAG_EFFORT_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * The `applyFlagSettings` patch that moves a live session from the workflow
 * flags it runs with to the instance's current ones; a key the new flags leave
 * out is cleared. Undefined when nothing changes.
 */
function tempoWorkflowFlagPatch(
  previous: TempoClaudeWorkflowFlagSettings,
  next: TempoClaudeWorkflowFlagSettings,
): Readonly<Record<string, unknown>> | undefined {
  const patch: Record<string, unknown> = {};
  for (const key of TEMPO_CLAUDE_FLAG_SETTING_KEYS) {
    const before = Reflect.get(previous, key);
    const after = Reflect.get(next, key);
    if (before !== after) patch[key] = after ?? null;
  }
  return Object.keys(patch).length === 0 ? undefined : patch;
}

/** What a reused session needs applied before the next turn, or undefined. */
export function tempoClaudeLiveSessionPatch(input: {
  readonly previousFlags: TempoClaudeWorkflowFlagSettings;
  readonly nextFlags: TempoClaudeWorkflowFlagSettings;
  readonly previousUltracode: boolean;
  readonly nextUltracode: boolean;
  readonly effort: string | undefined;
}): Readonly<Record<string, unknown>> | undefined {
  const flags = tempoWorkflowFlagPatch(input.previousFlags, input.nextFlags);
  const ultracode = tempoUltracodeFlagPatch(
    input.previousUltracode,
    input.nextUltracode,
    input.effort,
  );
  return flags === undefined && ultracode === undefined ? undefined : { ...flags, ...ultracode };
}

/**
 * The `applyFlagSettings` patch that moves a live session from one ultracode
 * state to another; undefined when nothing changes. Ultracode runs at xhigh,
 * and `null` turns it off while keeping that effort, so turning it off also
 * puts back the effort the person picked.
 */
export function tempoUltracodeFlagPatch(
  previous: boolean,
  next: boolean,
  effort: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (previous === next) return undefined;
  if (next) return { ultracode: true };
  return effort !== undefined && FLAG_EFFORT_LEVELS.has(effort)
    ? { ultracode: null, effortLevel: effort }
    : { ultracode: null, effortLevel: null };
}

/**
 * Ultracode is a toggle beside the effort, not an effort level: catalog models
 * that offered it as an effort option get a boolean `ultracode` option instead.
 * Older threads that saved the effort spelling still compile to ultracode.
 */
export function withTempoUltracodeToggle(model: ServerProviderModel): ServerProviderModel {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const effort = descriptors.find(
    (descriptor) => descriptor.id === "effort" && descriptor.type === "select",
  );
  if (
    effort?.type !== "select" ||
    !effort.options.some((option) => option.id === TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT) ||
    descriptors.some((descriptor) => descriptor.id === TEMPO_CLAUDE_ULTRACODE_OPTION_ID)
  ) {
    return model;
  }
  const { currentValue, ...effortRest } = effort;
  const effortWithoutUltracode = {
    ...effortRest,
    options: effort.options.filter((option) => option.id !== TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT),
    ...(currentValue === undefined || currentValue === TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT
      ? {}
      : { currentValue }),
  };
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      optionDescriptors: [
        ...descriptors.map((descriptor) =>
          descriptor === effort ? effortWithoutUltracode : descriptor,
        ),
        {
          id: TEMPO_CLAUDE_ULTRACODE_OPTION_ID,
          label: "Ultracode",
          description: "Plan the work as a multi-agent workflow at extra-high effort.",
          type: "boolean" as const,
        },
      ],
    },
  };
}

/**
 * The main checkout a git worktree belongs to. Claude reads project settings and
 * the `.claude` trees (workflows included) from `projectConfigRoot`, so a
 * worktree thread loads the repo's saved workflows, including untracked ones.
 * Returns undefined when `cwd` is not a linked worktree.
 */
export const resolveTempoClaudeProjectConfigRoot = Effect.fn("resolveTempoClaudeProjectConfigRoot")(
  function* (cwd: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const gitFile = path.join(cwd, ".git");
    const contents = yield* fileSystem
      .readFileString(gitFile)
      .pipe(Effect.orElseSucceed(() => undefined));
    const gitDir = contents?.match(/^gitdir:\s*(.+)\s*$/m)?.[1]?.trim();
    if (gitDir === undefined) return undefined;
    const absoluteGitDir = path.resolve(cwd, gitDir);
    // <main>/.git/worktrees/<name>
    const worktreesDir = path.dirname(absoluteGitDir);
    if (path.basename(worktreesDir) !== "worktrees") return undefined;
    const commonGitDir = path.dirname(worktreesDir);
    if (path.basename(commonGitDir) !== ".git") return undefined;
    const mainRoot = path.dirname(commonGitDir);
    return mainRoot === path.resolve(cwd) ? undefined : mainRoot;
  },
);

function stringField(input: object, key: string): string | undefined {
  const value = Reflect.get(input, key);
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function cutScript(script: string): Pick<TempoClaudeWorkflowApproval, "script" | "scriptLength"> {
  return script.length <= TEMPO_CLAUDE_WORKFLOW_APPROVAL_SCRIPT_LIMIT
    ? { script }
    : {
        script: script.slice(0, TEMPO_CLAUDE_WORKFLOW_APPROVAL_SCRIPT_LIMIT),
        scriptLength: script.length,
      };
}

/**
 * What the approval for a Workflow tool call shows: a one-line prompt for history and
 * notifications, and the workflow for the card; undefined for other tools. Before asking, the CLI
 * sets `script` to what it will run (the file at `scriptPath`, which wins, or the saved workflow
 * `name` selects), so Tempo never reads a model-named path itself.
 */
export function tempoClaudeWorkflowApproval(
  toolName: string,
  toolInput: unknown,
): { readonly prompt: string; readonly workflow: TempoClaudeWorkflowApproval } | undefined {
  if (toolName !== "Workflow" || toolInput === null || typeof toolInput !== "object") {
    return undefined;
  }
  const scriptPath = stringField(toolInput, "scriptPath");
  const name = scriptPath === undefined ? stringField(toolInput, "name") : undefined;
  const script = stringField(toolInput, "script");
  const resumeFromRunId = stringField(toolInput, "resumeFromRunId");
  const workflow: TempoClaudeWorkflowApproval = {
    ...(name === undefined ? {} : { name }),
    ...(scriptPath === undefined ? {} : { scriptPath }),
    ...(script === undefined ? {} : cutScript(script)),
    ...(resumeFromRunId === undefined ? {} : { resumeFromRunId }),
  };
  const metaName = script === undefined ? undefined : parseClaudeWorkflowMeta(script)?.name;
  const action =
    name !== undefined
      ? `Run the saved workflow "${name}"`
      : metaName !== undefined
        ? `Run workflow "${metaName}"`
        : scriptPath !== undefined
          ? `Run the workflow script ${scriptPath}`
          : "Run a workflow";
  return {
    prompt: resumeFromRunId === undefined ? action : `${action}, resuming run ${resumeFromRunId}`,
    workflow,
  };
}
