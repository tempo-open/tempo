import type { SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  TEMPO_CLAUDE_WORKFLOW_APPROVAL_SCRIPT_LIMIT,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { assert, describe, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { compileClaudeModelSelection } from "../claudeModelOptions.ts";
import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { BUNDLED_CLAUDE_MODEL_CATALOG } from "../provider/ClaudeModelCatalog.ts";
import {
  type TempoClaudeWorkflowSettings,
  tempoClaudeWorkflowApproval,
  tempoClaudeWorkflowFlagSettings,
  tempoClaudeWorkflowSettingsOf,
  tempoUltracodeFlagPatch,
  resolveTempoClaudeProjectConfigRoot,
} from "./claudeWorkflows.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const DEFAULT_SETTINGS = decodeClaudeSettings({});
const INSTANCE = ProviderInstanceId.make("claudeAgent");
const OPUS = { instanceId: INSTANCE, model: "claude-opus-5-5" } satisfies ModelSelection;
const withOptions = (options: ModelSelection["options"]): ModelSelection => ({
  ...OPUS,
  ...(options === undefined ? {} : { options }),
});

describe("Tempo Claude workflow flag settings", () => {
  it("turns workflows on explicitly with the default size and keyword trigger", () => {
    assert.deepEqual(tempoClaudeWorkflowFlagSettings(DEFAULT_SETTINGS), {
      enableWorkflows: true,
      workflowSizeGuideline: "medium",
      workflowKeywordTriggerEnabled: true,
      enableArtifact: false,
    });
  });

  it("follows the Claude provider settings", () => {
    assert.deepEqual(
      tempoClaudeWorkflowFlagSettings(
        decodeClaudeSettings({ workflowSize: "large", ultracodeKeyword: false }),
      ),
      {
        enableWorkflows: true,
        workflowSizeGuideline: "large",
        workflowKeywordTriggerEnabled: false,
        enableArtifact: false,
      },
    );
    assert.deepEqual(tempoClaudeWorkflowFlagSettings(decodeClaudeSettings({ workflows: false })), {
      enableWorkflows: false,
      enableArtifact: false,
    });
  });

  it("sends the flags and the worktree config root when a session opens", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: withOptions([{ id: "ultracode", value: true }]),
      nativeThreadId: "native-tempo",
      resume: false,
      cwd: "/repo-worktrees/feature",
      projectConfigRoot: "/repo",
      settings: decodeClaudeSettings({ workflowSize: "small" }),
    });
    assert.include(options.settings, {
      enableWorkflows: true,
      workflowSizeGuideline: "small",
      workflowKeywordTriggerEnabled: true,
      enableArtifact: false,
      ultracode: true,
    });
    assert.equal(options.projectConfigRoot, "/repo");
  });
});

describe("Tempo ultracode toggle", () => {
  it("is a boolean option beside the effort on models that offered it", () => {
    const opus = BUNDLED_CLAUDE_MODEL_CATALOG.models.find(
      (entry) => entry.model.slug === "claude-opus-5-5",
    );
    const descriptors = opus?.model.capabilities?.optionDescriptors ?? [];
    const effort = descriptors.find((descriptor) => descriptor.id === "effort");
    assert.equal(effort?.type, "select");
    if (effort?.type === "select") {
      assert.notInclude(
        effort.options.map((option) => option.id),
        "ultracode",
      );
    }
    assert.deepInclude(
      descriptors.map((descriptor) => ({ id: descriptor.id, type: descriptor.type })),
      { id: "ultracode", type: "boolean" },
    );
  });

  it("keeps the effort and leaves the process identity alone", () => {
    const off = compileClaudeModelSelection(withOptions([{ id: "effort", value: "high" }]));
    const on = compileClaudeModelSelection(
      withOptions([
        { id: "effort", value: "high" },
        { id: "ultracode", value: true },
      ]),
    );
    assert.isFalse(off.ultracode);
    assert.isTrue(on.ultracode);
    assert.equal(on.effort, "high");
    assert.include(on.settings, { ultracode: true });
    assert.equal(on.queryIdentity, off.queryIdentity);
  });

  it("still honours the legacy ultracode effort at extra-high effort", () => {
    const legacy = compileClaudeModelSelection(withOptions([{ id: "effort", value: "ultracode" }]));
    assert.isTrue(legacy.ultracode);
    assert.equal(legacy.effort, "xhigh");
  });

  it("never sends 'ultracode' as an SDK effort, even for a model outside the catalog", () => {
    const custom = compileClaudeModelSelection({
      instanceId: INSTANCE,
      model: "my-custom-claude",
      options: [{ id: "effort", value: "ultracode" }],
    });
    assert.isUndefined(custom.effort);
    assert.isFalse(custom.ultracode);
    assert.notProperty(custom.settings, "ultracode");
  });

  it("is ignored on models without workflows", () => {
    const haiku = compileClaudeModelSelection({
      instanceId: INSTANCE,
      model: "claude-haiku-4-5",
      options: [{ id: "ultracode", value: true }],
    });
    assert.isFalse(haiku.ultracode);
  });

  it("patches a live session only when the toggle changes, restoring the effort", () => {
    assert.isUndefined(tempoUltracodeFlagPatch(true, true, "high"));
    assert.deepEqual(tempoUltracodeFlagPatch(false, true, "high"), { ultracode: true });
    assert.deepEqual(tempoUltracodeFlagPatch(true, false, "high"), {
      ultracode: null,
      effortLevel: "high",
    });
    assert.deepEqual(tempoUltracodeFlagPatch(true, false, undefined), {
      ultracode: null,
      effortLevel: null,
    });
  });
});

describe("Tempo workflow approval", () => {
  // The CLI's permission request carries the Workflow input with `script` set
  // to the script it resolved: the file at scriptPath or the saved workflow.
  it("carries the inline script, or the saved workflow by name with its script", () => {
    const script = "export const meta = { name: 'migrate', phases: [] };";
    assert.deepEqual(tempoClaudeWorkflowApproval("Workflow", { script }), {
      prompt: 'Run workflow "migrate"',
      workflow: { script },
    });
    const saved = "export const meta = { name: 'review', phases: [] };";
    assert.deepEqual(
      tempoClaudeWorkflowApproval("Workflow", { name: "review", args: { pr: 7 }, script: saved }),
      { prompt: 'Run the saved workflow "review"', workflow: { name: "review", script: saved } },
    );
    assert.isUndefined(tempoClaudeWorkflowApproval("Bash", { script }));
  });

  it("names the script file the CLI runs in preference to a name, and never reads it", () => {
    const resolved = "export const meta = { name: 'from-disk', phases: [] };";
    assert.deepEqual(
      tempoClaudeWorkflowApproval("Workflow", {
        name: "ignored",
        script: resolved,
        scriptPath: "/home/me/.claude/projects/p/s/workflows/scripts/x.js",
        resumeFromRunId: "wf_run_1",
      }),
      {
        prompt: 'Run workflow "from-disk", resuming run wf_run_1',
        workflow: {
          scriptPath: "/home/me/.claude/projects/p/s/workflows/scripts/x.js",
          script: resolved,
          resumeFromRunId: "wf_run_1",
        },
      },
    );
    // Without a resolved script the card names the file and shows nothing of it.
    assert.deepEqual(tempoClaudeWorkflowApproval("Workflow", { scriptPath: "/etc/hosts.js" }), {
      prompt: "Run the workflow script /etc/hosts.js",
      workflow: { scriptPath: "/etc/hosts.js" },
    });
  });

  it("marks a script it cut for display", () => {
    const script = `export const meta = { name: 'long', phases: [] };\n${"x".repeat(40_000)}`;
    const approval = tempoClaudeWorkflowApproval("Workflow", { script });
    assert.equal(approval?.workflow.script?.length, TEMPO_CLAUDE_WORKFLOW_APPROVAL_SCRIPT_LIMIT);
    assert.equal(approval?.workflow.scriptLength, script.length);
  });
});

describe("Tempo project config root", () => {
  it.effect("resolves a linked worktree to its main checkout", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-config-root-" });
      const main = path.join(root, "main");
      const worktree = path.join(root, "worktrees", "feature");
      yield* fileSystem.makeDirectory(path.join(main, ".git", "worktrees", "feature"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(worktree, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(worktree, ".git"),
        `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`,
      );
      assert.equal(yield* resolveTempoClaudeProjectConfigRoot(worktree), main);
      assert.isUndefined(yield* resolveTempoClaudeProjectConfigRoot(main));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

function claudeFrame(frame: unknown): SDKMessage {
  return frame as SDKMessage;
}

const NATIVE_SESSION = "native-tempo-ultracode";
const resultFrame = (uuid: string) =>
  claudeFrame({
    type: "result",
    subtype: "success",
    duration_ms: 10,
    duration_api_ms: 10,
    is_error: false,
    num_turns: 1,
    result: "done",
    stop_reason: "end_turn",
    total_cost_usd: 0,
    usage: {
      input_tokens: 1,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
    modelUsage: {},
    permission_denials: [],
    uuid,
    session_id: NATIVE_SESSION,
    terminal_reason: "completed",
  });

/** One Claude adapter over a scripted query runner that records every process and flag patch. */
const makeLiveHarness = Effect.fn("makeLiveHarness")(function* (options: {
  readonly tempoWorkflowSettings?: Ref.Ref<TempoClaudeWorkflowSettings>;
  readonly settings?: ClaudeSettings;
  readonly cwd?: string;
  readonly worktreePath?: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-live-" });
  const processes: Array<Queue.Queue<SDKMessage>> = [];
  const openedSettings: Array<unknown> = [];
  const flagPatches: Array<Readonly<Record<string, unknown>>> = [];
  const offered: Array<SDKUserMessage> = [];
  const events: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
  /** Wake turns the adapter asked for while the root was idle. */
  const continuations: Array<unknown> = [];
  const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
    instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
    settings: options.settings ?? DEFAULT_SETTINGS,
    environment: {},
    attachmentsDir,
    fileSystem,
    path: yield* Path.Path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    ...(options.tempoWorkflowSettings === undefined
      ? {}
      : { tempoWorkflowSettings: options.tempoWorkflowSettings }),
    continuationRequests: {
      offer: (request) => Effect.sync(() => void continuations.push(request)),
    },
    queryRunner: {
      allocateSessionId: Effect.succeed(NATIVE_SESSION),
      open: (input) =>
        Effect.gen(function* () {
          const messages = yield* Queue.unbounded<SDKMessage>();
          processes.push(messages);
          openedSettings.push(input.options.settings);
          return {
            messages: Stream.fromQueue(messages),
            offer: (message) =>
              Effect.sync(() => {
                offered.push(message);
              }),
            setModel: () => Effect.void,
            setPermissionMode: () => Effect.void,
            stopTask: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            applyFlagSettings: (settings) =>
              Effect.sync(() => {
                flagPatches.push(settings);
              }),
            interrupt: Effect.void,
            close: Queue.shutdown(messages),
          };
        }),
      forkSession: () => Effect.die("unused forkSession"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const threadId = ThreadId.make("thread-tempo-live");
  const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: options.cwd ?? "/workspace",
  });
  const modelSelection = withOptions([{ id: "effort", value: "high" }]);
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session-tempo-live"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  // Every recorded event notifies, so a wait re-checks exactly when `events` changes. Subscribing
  // before the first check means an event that lands in between is not lost.
  const changes = yield* PubSub.unbounded<void>();
  const until = (predicate: () => boolean): Effect.Effect<void> =>
    Effect.scoped(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
      }),
    );
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => events.push(event)).pipe(
        Effect.andThen(PubSub.publish(changes, undefined)),
      ),
    ),
    Effect.forkScoped,
  );
  const now = yield* DateTime.now;
  let ordinal = 0;
  const startTurn = (selection: ModelSelection, text = "Refactor the parser.") => {
    ordinal += 1;
    const attempt = `attempt-tempo-${ordinal}`;
    const thread =
      ordinal === 1 ? providerThread : { ...providerThread, status: "active" as const };
    const appThread: OrchestrationV2AppThread = {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId: ProjectId.make("project-tempo-live"),
      title: "Live",
      providerInstanceId: INSTANCE,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: options.worktreePath ?? null,
      activeProviderThreadId: thread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    };
    return runtime.startTurn({
      appThread,
      threadId,
      runId: RunId.make(`run-${attempt}`),
      runOrdinal: ordinal,
      providerTurnOrdinal: ordinal,
      attemptId: RunAttemptId.make(attempt),
      rootNodeId: NodeId.make(`node-${attempt}`),
      providerThread: thread,
      message: {
        createdBy: "user",
        creationSource: "web",
        messageId: MessageId.make(`message-${attempt}`),
        text,
        attachments: [],
      },
      modelSelection: selection,
      runtimePolicy,
    } satisfies ProviderAdapter.ProviderAdapterV2TurnInput);
  };
  const terminals = () => events.filter((event) => event.type === "turn.terminal").length;
  /** Ends the current turn on the live process and waits for its terminal event. */
  const finishTurn = Effect.fn("finishTurn")(function* (frames: ReadonlyArray<unknown> = []) {
    const before = terminals();
    for (const frame of frames) yield* Queue.offer(processes.at(-1)!, claudeFrame(frame));
    yield* Queue.offer(
      processes.at(-1)!,
      resultFrame(`00000000-0000-4000-8000-${String(before + 1).padStart(12, "0")}`),
    );
    yield* until(() => terminals() === before + 1);
  });
  return {
    processes,
    openedSettings,
    flagPatches,
    offered,
    events,
    continuations,
    startTurn,
    finishTurn,
    until,
    modelSelection,
  };
});

const liveLayer = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer);
const ULTRACODE_HIGH = withOptions([
  { id: "effort", value: "high" },
  { id: "ultracode", value: true },
]);

describe("Tempo ultracode on a live Claude session", () => {
  it.effect("applies the toggle with applyFlagSettings instead of a new process", () =>
    Effect.gen(function* () {
      const live = yield* makeLiveHarness({});
      yield* live.startTurn(live.modelSelection);
      yield* live.finishTurn();

      yield* live.startTurn(ULTRACODE_HIGH);
      assert.equal(live.processes.length, 1);
      assert.deepEqual(live.flagPatches, [{ ultracode: true }]);
      yield* live.finishTurn();

      yield* live.startTurn(live.modelSelection);
      assert.equal(live.processes.length, 1);
      assert.deepEqual(live.flagPatches, [
        { ultracode: true },
        { ultracode: null, effortLevel: "high" },
      ]);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );
});

describe("Tempo workflow settings on a live Claude session", () => {
  it.effect("applies a settings change on the next turn, and workflows off drops ultracode", () =>
    Effect.gen(function* () {
      const settings = yield* Ref.make(tempoClaudeWorkflowSettingsOf(DEFAULT_SETTINGS));
      const live = yield* makeLiveHarness({ tempoWorkflowSettings: settings });
      yield* live.startTurn(ULTRACODE_HIGH);
      assert.include(live.openedSettings[0], { enableWorkflows: true, ultracode: true });
      yield* live.finishTurn();

      yield* Ref.update(settings, (current) => ({ ...current, workflowSize: "large" as const }));
      yield* live.startTurn(ULTRACODE_HIGH);
      assert.deepEqual(live.flagPatches, [{ workflowSizeGuideline: "large" }]);
      yield* live.finishTurn();

      yield* Ref.update(settings, (current) => ({ ...current, workflows: false }));
      yield* live.startTurn(ULTRACODE_HIGH);
      assert.equal(live.processes.length, 1);
      assert.deepEqual(live.flagPatches.at(-1), {
        enableWorkflows: false,
        workflowSizeGuideline: null,
        workflowKeywordTriggerEnabled: null,
        ultracode: null,
        effortLevel: "high",
      });
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it("opens a session without ultracode while workflows are off", () => {
    const options = ClaudeAdapterV2.makeClaudeQueryOptions({
      modelSelection: ULTRACODE_HIGH,
      nativeThreadId: "native-tempo-off",
      resume: false,
      cwd: "/repo",
      settings: decodeClaudeSettings({ workflows: false }),
    });
    assert.include(options.settings, { enableWorkflows: false, enableArtifact: false });
    assert.notProperty(options.settings, "ultracode");
  });
});

describe("Tempo ambient Claude tasks", () => {
  const ambientFrame = (subtype: string, extra: Record<string, unknown>) => ({
    type: "system",
    subtype,
    task_id: "task_ambient",
    description: "Index the repo",
    uuid: `00000000-0000-4000-8000-0000000a${subtype.length.toString().padStart(4, "0")}`,
    session_id: NATIVE_SESSION,
    ...extra,
  });
  const started = ambientFrame("task_started", {
    task_type: "local_agent",
    skip_transcript: true,
    ambient: true,
  });
  const ended = ambientFrame("task_notification", {
    status: "completed",
    output_file: "/tmp/out",
    summary: "Indexed",
    skip_transcript: true,
  });
  const subagentRows = (events: ReadonlyArray<ProviderAdapter.ProviderAdapterV2Event>) =>
    events.flatMap((event) =>
      event.type === "turn_item.updated" && event.turnItem.type === "subagent"
        ? [event.turnItem]
        : [],
    );

  it.effect("records skip_transcript subagents marked ambient, for clients to hide", () =>
    Effect.gen(function* () {
      const live = yield* makeLiveHarness({});
      yield* live.startTurn(live.modelSelection);
      yield* live.finishTurn([
        started,
        ambientFrame("task_progress", {
          usage: { total_tokens: 10, tool_uses: 1, duration_ms: 5 },
          description: "indexing",
        }),
        ended,
      ]);
      const rows = subagentRows(live.events);
      assert.isAbove(rows.length, 0);
      assert.isTrue(rows.every((row) => row.ambient === true));
      assert.equal(rows.at(-1)?.status, "completed");
      const records = live.events.flatMap((event) =>
        event.type === "subagent.updated" ? [event.subagent] : [],
      );
      assert.isTrue(records.length > 0 && records.every((record) => record.ambient === true));
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );

  it.effect("closes an ambient task that ends after its turn without waking the root", () =>
    Effect.gen(function* () {
      const live = yield* makeLiveHarness({});
      yield* live.startTurn(live.modelSelection);
      yield* live.finishTurn([started]);
      assert.equal(subagentRows(live.events).at(-1)?.status, "running");

      yield* Queue.offer(live.processes.at(-1)!, claudeFrame(ended));
      yield* live.until(() => subagentRows(live.events).at(-1)?.status === "completed");
      assert.deepEqual(live.continuations, []);
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );
});

describe("Tempo worktree threads and the main checkout's .claude config", () => {
  it.effect("dispatches a skill that lives in the main checkout", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-worktree-skill-" });
      const main = path.join(root, "main");
      const worktree = path.join(root, "worktrees", "feature");
      const claudeHome = path.join(root, "claude-home");
      yield* fileSystem.makeDirectory(path.join(main, ".git", "worktrees", "feature"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(path.join(main, ".claude", "skills", "deploy"), {
        recursive: true,
      });
      yield* fileSystem.writeFileString(
        path.join(main, ".claude", "skills", "deploy", "SKILL.md"),
        "---\ndescription: Deploy the app\n---\nDeploy it.\n",
      );
      yield* fileSystem.makeDirectory(worktree, { recursive: true });
      yield* fileSystem.makeDirectory(claudeHome, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(worktree, ".git"),
        `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`,
      );
      const live = yield* makeLiveHarness({
        settings: decodeClaudeSettings({ homePath: claudeHome }),
        cwd: worktree,
        worktreePath: worktree,
      });
      yield* live.startTurn(live.modelSelection, "$deploy to staging");
      const content = live.offered[0]?.message.content;
      const blocks = typeof content === "string" ? [] : (content ?? []);
      const lastText = blocks.findLast((block) => block.type === "text");
      assert.equal(lastText?.type === "text" ? lastText.text : undefined, "/deploy to staging");
    }).pipe(Effect.scoped, Effect.provide(liveLayer)),
  );
});
