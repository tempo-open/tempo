/**
 * Tempo: Claude workflows and ultracode, as web and mobile present them.
 *
 * Pure view logic: the ultracode toggle, its keyword hint and run badge, the
 * workflow card a coordinator subagent renders as, the workflow approval card,
 * and the saved workflows the composer offers.
 */
import {
  TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT,
  TEMPO_CLAUDE_ULTRACODE_OPTION_ID,
  tempoRunSavedWorkflowPrompt,
  isTempoClaudeUltracodeSelected,
  withTempoClaudeUltracode,
  type TempoClaudeSavedWorkflow,
  type TempoClaudeWorkflowApproval,
  type OrchestrationV2Subagent,
  type OrchestrationV2WorkflowAgent,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import {
  parseClaudeWorkflowMeta,
  type ClaudeWorkflowMeta,
  type ClaudeWorkflowMetaPhase,
} from "@t3tools/shared/tempoClaudeWorkflowMeta";

// ── Ultracode ─────────────────────────────────────────────────────────

export interface UltracodeToggleState {
  /** The model offers ultracode, so the toggle is shown. */
  readonly available: boolean;
  readonly enabled: boolean;
}

export function resolveUltracodeToggle(input: {
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor>;
  readonly options: ReadonlyArray<ProviderOptionSelection> | null | undefined;
}): UltracodeToggleState {
  const available = input.descriptors.some(
    (descriptor) =>
      descriptor.id === TEMPO_CLAUDE_ULTRACODE_OPTION_ID && descriptor.type === "boolean",
  );
  return { available, enabled: available && isTempoClaudeUltracodeSelected(input.options) };
}

/** The selection options after flipping ultracode; the effort is left as it was. */
export function toggleUltracodeOptions(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> {
  return withTempoClaudeUltracode(options, !isTempoClaudeUltracodeSelected(options));
}

/**
 * Options as other threads may inherit them (sticky or remembered model
 * options): everything but ultracode, which costs far more and is turned on
 * per thread. Undefined when nothing is left.
 */
export function withoutUltracodeOptions(
  options: ReadonlyArray<ProviderOptionSelection> | null | undefined,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  const rest = (options ?? []).filter(
    (option) =>
      option.id !== TEMPO_CLAUDE_ULTRACODE_OPTION_ID &&
      !(option.id === "effort" && option.value === TEMPO_CLAUDE_LEGACY_ULTRACODE_EFFORT),
  );
  return rest.length === 0 ? undefined : rest;
}

// Quote and bracket pairs whose contents never trigger the keyword.
const KEYWORD_QUOTES: Readonly<Record<string, string>> = {
  "`": "`",
  '"': '"',
  "<": ">",
  "{": "}",
  "[": "]",
  "(": ")",
  "'": "'",
};

const isWordCharacter = (character: string | undefined) =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character);

/**
 * Whether Claude Code (2.1.296) treats the prompt as asking for ultracode: the
 * word on its own, outside quotes, brackets and tags, not part of a path, flag
 * or question, in a prompt that is not a slash command. Mirrors the CLI so the
 * hint never promises a workflow the CLI will not start.
 */
function promptHasUltracodeKeyword(prompt: string): boolean {
  if (!/ultracode/i.test(prompt) || prompt.startsWith("/")) return false;
  const quoted: Array<{ readonly start: number; readonly end: number }> = [];
  let open: string | null = null;
  let openedAt = 0;
  for (let index = 0; index < prompt.length; index++) {
    const character = prompt[index]!;
    if (open !== null) {
      if (open === "[" && character === "[") {
        openedAt = index;
        continue;
      }
      if (character !== KEYWORD_QUOTES[open]) continue;
      if (open === "'" && isWordCharacter(prompt[index + 1])) continue;
      quoted.push({ start: openedAt, end: index + 1 });
      open = null;
    } else if (
      (character === "<" && /[a-zA-Z/]/.test(prompt[index + 1] ?? "")) ||
      (character === "'" && !isWordCharacter(prompt[index - 1])) ||
      (character !== "<" && character !== "'" && Object.hasOwn(KEYWORD_QUOTES, character))
    ) {
      open = character;
      openedAt = index;
    }
  }
  for (const match of prompt.matchAll(/\bultracode\b/gi)) {
    if (match.index === undefined) continue;
    const start = match.index;
    const end = start + match[0].length;
    if (quoted.some((span) => start >= span.start && start < span.end)) continue;
    const before = prompt[start - 1];
    const after = prompt[end];
    if (before === "/" || before === "\\" || before === "-") continue;
    if (after === "/" || after === "\\" || after === "-" || after === "?") continue;
    if (after === "." && isWordCharacter(prompt[end + 1])) continue;
    return true;
  }
  return false;
}

/**
 * Claude runs a turn as a workflow when its prompt says "ultracode" and the
 * keyword trigger is on. The hint is redundant once the toggle is on.
 */
export function shouldShowUltracodeKeywordHint(input: {
  readonly prompt: string;
  readonly toggle: UltracodeToggleState;
  readonly keywordTriggerEnabled: boolean;
}): boolean {
  return (
    input.toggle.available &&
    !input.toggle.enabled &&
    input.keywordTriggerEnabled &&
    promptHasUltracodeKeyword(input.prompt)
  );
}

/** A run carries the selection it was sent with, so its badge never goes stale. */
export function runUsedUltracode(run: {
  readonly modelSelection: { readonly options?: ReadonlyArray<ProviderOptionSelection> };
}): boolean {
  return isTempoClaudeUltracodeSelected(run.modelSelection.options);
}

// ── Workflow card ─────────────────────────────────────────────────────

export type WorkflowItemState = "queued" | "running" | "done" | "failed" | "stopped";

export const WORKFLOW_STATE_LABELS: Readonly<Record<WorkflowItemState, string>> = {
  queued: "Queued",
  running: "Running",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export interface WorkflowCardAgent {
  readonly key: string;
  readonly index: number;
  readonly label: string;
  readonly state: WorkflowItemState;
  readonly model: string | null;
  readonly attempt: number;
  readonly totalTokens: number | null;
  readonly toolCalls: number | null;
  /** Settled agents report a duration; running ones tick from `startedAt`. */
  readonly durationMs: number | null;
  readonly startedAt: number | null;
  readonly prompt: string | null;
  readonly result: string | null;
  readonly childThreadId: string | null;
}

export interface WorkflowCardPhase {
  readonly index: number;
  readonly title: string;
  readonly detail: string | null;
  readonly state: WorkflowItemState;
  readonly agents: ReadonlyArray<WorkflowCardAgent>;
  readonly doneCount: number;
}

export interface WorkflowCard {
  readonly subagentId: string;
  readonly name: string;
  readonly description: string | null;
  readonly state: WorkflowItemState;
  readonly phases: ReadonlyArray<WorkflowCardPhase>;
  /** Agents the provider reported without a phase. */
  readonly unphasedAgents: ReadonlyArray<WorkflowCardAgent>;
  readonly agentCount: number;
  readonly doneCount: number;
  readonly runningCount: number;
  readonly failedCount: number;
  readonly totalTokens: number | null;
  readonly toolCalls: number | null;
  readonly durationMs: number | null;
  /** The final summary once the run settled, or its error. */
  readonly result: string | null;
  readonly runId: string | null;
  readonly scriptPath: string | null;
  readonly childThreadId: string | null;
  readonly canStop: boolean;
}

type WorkflowSubagent = Pick<
  OrchestrationV2Subagent,
  "id" | "title" | "prompt" | "status" | "workflow" | "result" | "childThreadId"
>;

function coordinatorState(status: OrchestrationV2Subagent["status"]): WorkflowItemState {
  switch (status) {
    case "pending":
    case "running":
    case "waiting":
      return "running";
    case "completed":
    case "idle":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function agentState(
  state: OrchestrationV2WorkflowAgent["state"],
  coordinator: WorkflowItemState,
): WorkflowItemState {
  if (state === "completed") return "done";
  if (state === "failed") return "failed";
  // The provider stops reporting once the run ends; an agent it last saw in
  // flight ended with the run.
  if (coordinator !== "running") return coordinator === "done" ? "done" : "stopped";
  return state === "queued" ? "queued" : "running";
}

function cardAgent(agent: OrchestrationV2WorkflowAgent, coordinator: WorkflowItemState) {
  const state = agentState(agent.state, coordinator);
  return {
    key: `${agent.index}:${agent.attempt ?? 1}`,
    index: agent.index,
    label: agent.label,
    state,
    model: agent.model ?? null,
    attempt: agent.attempt ?? 1,
    totalTokens: agent.totalTokens ?? null,
    toolCalls: agent.toolCalls ?? null,
    durationMs: agent.durationMs ?? null,
    startedAt: agent.startedAt ?? null,
    prompt: agent.prompt ?? null,
    result: agent.result ?? null,
    childThreadId: agent.childThreadId ?? null,
  } satisfies WorkflowCardAgent;
}

function phaseState(
  agents: ReadonlyArray<WorkflowCardAgent>,
  coordinator: WorkflowItemState,
): WorkflowItemState {
  if (agents.some((agent) => agent.state === "running")) return "running";
  if (agents.length === 0) {
    if (coordinator === "running") return "queued";
    return coordinator === "done" ? "done" : "stopped";
  }
  if (agents.some((agent) => agent.state === "queued")) return "running";
  if (agents.some((agent) => agent.state === "failed")) return "failed";
  if (agents.some((agent) => agent.state === "stopped")) return "stopped";
  return "done";
}

/**
 * The card a workflow coordinator renders as, or null for an ordinary subagent.
 * `meta` is the script's own header when the client has read it; it adds the
 * description and per-phase details the progress snapshot does not carry.
 */
export function deriveWorkflowCard(
  subagent: WorkflowSubagent,
  meta?: ClaudeWorkflowMeta | null,
): WorkflowCard | null {
  const { workflow } = subagent;
  if (workflow === undefined) return null;
  const state = coordinatorState(subagent.status);
  const agents = workflow.agents.map((agent) => cardAgent(agent, state));
  const phaseTitles = new Map<number, string>();
  for (const agent of workflow.agents) {
    if (agent.phaseIndex !== undefined && !phaseTitles.has(agent.phaseIndex)) {
      phaseTitles.set(agent.phaseIndex, agent.phaseTitle ?? `Phase ${agent.phaseIndex}`);
    }
  }
  for (const phase of workflow.phases) phaseTitles.set(phase.index, phase.title);
  // Declared phases the run has not reached yet still belong on the arc. The
  // CLI numbers phases from 1 and announces the declared ones up front, so a
  // declared phase is matched by title, never by its position in the meta.
  const knownTitles = new Set(phaseTitles.values());
  let nextIndex = Math.max(0, ...phaseTitles.keys()) + 1;
  for (const phase of meta?.phases ?? []) {
    if (knownTitles.has(phase.title)) continue;
    knownTitles.add(phase.title);
    phaseTitles.set(nextIndex++, phase.title);
  }
  const phaseDetail = (title: string): string | null =>
    meta?.phases.find((phase) => phase.title === title)?.detail ?? null;
  const phases = Array.from(phaseTitles.entries())
    .sort(([left], [right]) => left - right)
    .map(([index, title]) => {
      const phaseAgents = agents.filter(
        (_, position) => workflow.agents[position]!.phaseIndex === index,
      );
      return {
        index,
        title,
        detail: phaseDetail(title),
        state: phaseState(phaseAgents, state),
        agents: phaseAgents,
        doneCount: phaseAgents.filter((agent) => agent.state === "done").length,
      } satisfies WorkflowCardPhase;
    });
  const name = workflow.name ?? meta?.name ?? subagent.title ?? "Workflow";
  const title = subagent.title?.trim();
  const description =
    meta?.description ?? (title !== undefined && title.length > 0 && title !== name ? title : null);
  const result = subagent.result?.trim();
  return {
    subagentId: subagent.id,
    name,
    description,
    state,
    phases,
    unphasedAgents: agents.filter(
      (_, position) => workflow.agents[position]!.phaseIndex === undefined,
    ),
    agentCount: agents.length,
    doneCount: agents.filter((agent) => agent.state === "done").length,
    runningCount: agents.filter((agent) => agent.state === "running").length,
    failedCount: agents.filter((agent) => agent.state === "failed").length,
    totalTokens: workflow.totalTokens ?? null,
    toolCalls: workflow.toolCalls ?? null,
    durationMs: workflow.durationMs ?? null,
    result: state === "running" || result === undefined || result.length === 0 ? null : result,
    runId: workflow.runHandles?.runId ?? null,
    scriptPath: workflow.runHandles?.scriptPath ?? null,
    childThreadId: subagent.childThreadId ?? null,
    canStop: state === "running",
  };
}

/** "3 of 8 agents done", the count every surface shows. */
export function workflowAgentCountLabel(
  card: Pick<WorkflowCard, "doneCount" | "agentCount">,
): string {
  if (card.agentCount === 0) return "No agents yet";
  return `${card.doneCount} of ${card.agentCount} ${card.agentCount === 1 ? "agent" : "agents"} done`;
}

export function formatWorkflowTokens(tokens: number | null): string | null {
  if (tokens === null) return null;
  if (tokens < 1_000) return `${tokens} tokens`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k tokens`;
  return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
}

// ── Workflow approval ─────────────────────────────────────────────────

export interface WorkflowApprovalView {
  readonly name: string | null;
  readonly description: string | null;
  readonly phases: ReadonlyArray<ClaudeWorkflowMetaPhase>;
  /** The script the CLI will run, when the server could show it. */
  readonly script: string | null;
  /** Set when `script` is only the start of a longer script. */
  readonly scriptLength: number | null;
  /** A saved workflow run by name. */
  readonly savedName: string | null;
  /** A script file on disk; the CLI runs it in preference to anything else. */
  readonly scriptPath: string | null;
  readonly resumeFromRunId: string | null;
}

/**
 * The approval card for a Claude Workflow tool call, from the structured
 * workflow the Claude adapter attaches. Null for every other approval: the
 * card is never chosen from approval text, which other tools and providers
 * fill with text from outside sources.
 */
export function workflowApprovalView(
  workflow: TempoClaudeWorkflowApproval | undefined,
): WorkflowApprovalView | null {
  if (workflow === undefined) return null;
  const meta = workflow.script === undefined ? undefined : parseClaudeWorkflowMeta(workflow.script);
  return {
    name: meta?.name ?? workflow.name ?? null,
    description: meta?.description ?? null,
    phases: meta?.phases ?? [],
    script: workflow.script ?? null,
    scriptLength: workflow.scriptLength ?? null,
    savedName: workflow.name ?? null,
    scriptPath: workflow.scriptPath ?? null,
    resumeFromRunId: workflow.resumeFromRunId ?? null,
  };
}

/** The card's one-line title. */
export function workflowApprovalTitle(view: WorkflowApprovalView): string {
  if (view.name !== null && view.savedName === null) return `Run workflow "${view.name}"`;
  if (view.savedName !== null) return `Run the saved workflow "${view.savedName}"`;
  return view.scriptPath !== null ? "Run a workflow script" : "Run a workflow";
}

/**
 * Why the card shows less than the whole script, or null when it shows all of
 * it. Claude's request normally carries the script it resolved; without one
 * the card can only name the file.
 */
export function workflowApprovalScriptNotice(view: WorkflowApprovalView): string | null {
  if (view.script === null) {
    return view.scriptPath === null
      ? null
      : `${TEMPO_APP_BASE_NAME} can't show this script file. Read it before approving.`;
  }
  if (view.scriptLength === null || view.scriptLength <= view.script.length) return null;
  return `Script cut: ${view.script.length} of ${view.scriptLength} characters shown. Approving runs all of it.`;
}

// ── Saved workflows ─────────────────────────────────────────────────

const savedWorkflowPrompt = tempoRunSavedWorkflowPrompt;

const SAVED_WORKFLOW_COMMAND_PREFIX = "workflow:";
const SAVED_WORKFLOW_ROW_ID_PREFIX = "tempo-workflow:";

/** A saved workflow as a provider-command row in a composer's `/` menu. */
export interface SavedWorkflowCommandRow {
  readonly id: string;
  readonly command: ServerProviderSlashCommand;
  readonly label: string;
  readonly description: string;
}

/**
 * Saved Claude workflows ride the composer's provider-command rows as
 * `/workflow:<name>`. Claude has no slash command for them: the model runs a
 * saved workflow through its Workflow tool, so choosing one writes the prompt
 * that asks for it (`savedWorkflowRowPrompt`) instead of a command.
 */
export function savedWorkflowCommandRows(
  workflows: ReadonlyArray<TempoClaudeSavedWorkflow>,
): ReadonlyArray<SavedWorkflowCommandRow> {
  return workflows.map((workflow) => ({
    id: `${SAVED_WORKFLOW_ROW_ID_PREFIX}${workflow.scope}:${workflow.name}`,
    command: {
      name: `${SAVED_WORKFLOW_COMMAND_PREFIX}${workflow.name}`,
      ...(workflow.description === undefined ? {} : { description: workflow.description }),
    },
    label: `/${SAVED_WORKFLOW_COMMAND_PREFIX}${workflow.name}`,
    description: `${workflow.scope === "user" ? "Your workflow" : "Project workflow"}${
      workflow.description === undefined ? "" : ` · ${workflow.description}`
    }`,
  }));
}

/** The prompt a saved-workflow row inserts, or null for a real provider command. */
export function savedWorkflowRowPrompt(row: {
  readonly id: string;
  readonly command: ServerProviderSlashCommand;
}): string | null {
  return row.id.startsWith(SAVED_WORKFLOW_ROW_ID_PREFIX)
    ? `${savedWorkflowPrompt(row.command.name.slice(SAVED_WORKFLOW_COMMAND_PREFIX.length))} `
    : null;
}

export interface ClaudeWorkflowInstanceSettings {
  readonly workflowsEnabled: boolean;
  readonly keywordTriggerEnabled: boolean;
}

/**
 * The workflow switches from a Claude instance's saved config. Both default
 * on, as the server decodes them; ultracode needs workflows on.
 */
export function claudeWorkflowInstanceSettings(config: unknown): ClaudeWorkflowInstanceSettings {
  const read = (key: string) =>
    config !== null && typeof config === "object" ? Reflect.get(config, key) : undefined;
  const workflowsEnabled = read("workflows") !== false;
  return {
    workflowsEnabled,
    keywordTriggerEnabled: workflowsEnabled && read("ultracodeKeyword") !== false,
  };
}
