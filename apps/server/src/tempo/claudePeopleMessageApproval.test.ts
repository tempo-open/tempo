import type { HookCallback, HookInput } from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderThread,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  claudePeopleMessageHooks,
  codexFullAccessAnswersMcpApproval,
  isClaudePeopleMessageTool,
  type ClaudeApprove,
  skipHookApprovedToolUses,
} from "./agentMcpProviderConfig.ts";
import { TEMPO_SAFETY_POLICY_FILE, tempoSafetyPolicyHooks } from "./claudeSafetyPolicy.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);
const CLAUDE_SETTINGS = decodeClaudeSettings({});
const SKIP_PERMISSIONS_SETTINGS = decodeClaudeSettings({
  launchArgs: "--dangerously-skip-permissions",
});

const preToolUse = (toolName: string): HookInput => ({
  hook_event_name: "PreToolUse",
  session_id: "session",
  transcript_path: "/tmp/transcript.jsonl",
  cwd: "/workspace",
  tool_name: toolName,
  tool_input: { text: "hello" },
  tool_use_id: `use-${toolName}`,
});

describe("isClaudePeopleMessageTool", () => {
  it("asks about tools that send to a person, by the names real servers use", () => {
    for (const tool of [
      "mcp__tracker__action_comment_issue",
      "mcp__chat__action_post_message",
      "mcp__wiki__addOrEditPageComment",
      "mcp__docs__manage_document_comment",
      "mcp__sheets__manage_sheet_comment",
      "mcp__mail__send_message",
      "mcp__messages__tool_send_message",
      "mcp__notes__notes-create-comment",
      "mcp__workspace__invite_members",
      "mcp__payments__send_receipt",
      "mcp__chat__chat_schedule_message",
      "mcp__mail__send_draft",
      "mcp__mail__forward_emails",
      "mcp__sms__sms_create",
      "mcp__someone__text_sam",
      "mcp__someone__email_user",
      "mcp__example__add_comment",
      "mcp__example__publish_post",
    ]) {
      assert.isTrue(isClaudePeopleMessageTool(tool), tool);
    }
  });

  it("leaves reads, drafts, reactions and t3-code's own tools alone", () => {
    for (const tool of [
      "SendMessage",
      "mcp__t3-code__t3_thread_send",
      "mcp__mail__action_create_draft",
      "mcp__wiki__listPageComments",
      "mcp__mail__draft_message",
      "mcp__mail__get_message_content",
      "mcp__docs__modify_doc_text",
      "mcp__mail__modify_message_labels",
      "mcp__mail__search_messages",
      "mcp__messages__tool_fuzzy_search_messages",
      "mcp__messages__tool_get_recent_messages",
      "mcp__notes__notes-delete-comment",
      "mcp__notes__notes-get-comments",
      "mcp__notes__notes-send-message-to-session",
      "mcp__notes__notes-set-comment-reaction",
      "mcp__chat__chat_send_message_draft",
      "mcp__design__send_code_to_design",
      "mcp__mail__apply_labels_to_emails",
    ]) {
      assert.isFalse(isClaudePeopleMessageTool(tool), tool);
    }
  });

  it("counts a calendar write only when it invites someone", () => {
    const tool = "mcp__calendar__manage_event";
    assert.isFalse(isClaudePeopleMessageTool(tool, { summary: "Focus" }));
    assert.isFalse(isClaudePeopleMessageTool(tool, { attendees: [] }));
    assert.isTrue(isClaudePeopleMessageTool(tool, { attendees: ["sam@example.com"] }));
  });
});

describe("the hold on messages to people", () => {
  const holdFrom = (input: {
    readonly fullAccess?: boolean;
    readonly approve: ClaudeApprove;
    readonly approvedToolUses?: Set<string>;
  }) =>
    claudePeopleMessageHooks({ runPromise: Effect.runPromise, ...input }).PreToolUse![0]!.hooks[0]!;
  const send = "mcp__messages__tool_send_message";
  const callIn = (hook: HookCallback, toolName: string, permissionMode?: string) =>
    hook(
      { ...preToolUse(toolName), ...(permissionMode ? { permission_mode: permissionMode } : {}) },
      `use-${toolName}`,
      { signal: new AbortController().signal },
    );

  it("waits for a yes in full access and runs after it", async () => {
    const approvedToolUses = new Set<string>();
    const asked: Array<string> = [];
    const hook = holdFrom({
      fullAccess: true,
      approvedToolUses,
      approve: ({ toolName }) => {
        asked.push(toolName);
        return Effect.succeed({ behavior: "allow" });
      },
    });
    assert.nestedPropertyVal(
      await callIn(hook, send),
      "hookSpecificOutput.permissionDecision",
      "allow",
    );
    assert.deepEqual(asked, [send]);
    assert.isTrue(approvedToolUses.has(`use-${send}`));
  });

  it("stays denied when the person says no, or nobody answers", async () => {
    const said = holdFrom({
      fullAccess: true,
      approve: () => Effect.succeed({ behavior: "deny", message: "Not this one." } as never),
    });
    assert.nestedPropertyVal(
      await callIn(said, send),
      "hookSpecificOutput.permissionDecisionReason",
      "Not this one.",
    );
    const failed = holdFrom({ fullAccess: true, approve: () => Effect.die("no card") });
    assert.nestedPropertyVal(
      await callIn(failed, send),
      "hookSpecificOutput.permissionDecision",
      "deny",
    );
  });

  it("lets the permission callback skip a message the hook approved, once", async () => {
    const approvedToolUses = new Set<string>();
    const hook = holdFrom({
      fullAccess: true,
      approvedToolUses,
      approve: () => Effect.succeed({ behavior: "allow" }),
    });
    await callIn(hook, send);
    let asked = 0;
    const canUseTool = skipHookApprovedToolUses(() => {
      asked += 1;
      return Promise.resolve({ behavior: "deny", message: "asked" });
    }, approvedToolUses);
    const options = {
      signal: new AbortController().signal,
      toolUseID: `use-${send}`,
      requestId: "request-1",
    };
    assert.deepEqual(await canUseTool(send, { text: "hi" }, options), {
      behavior: "allow",
      updatedInput: { text: "hi" },
    });
    assert.equal(asked, 0);
    await canUseTool(send, { text: "hi" }, options);
    assert.equal(asked, 1);
  });

  it("does not touch other tools, or any tool outside full access", async () => {
    const approve: ClaudeApprove = () => Effect.die("must not ask");
    const hook = holdFrom({ fullAccess: true, approve });
    assert.deepEqual(await callIn(hook, "mcp__messages__tool_get_recent_messages"), {});
    assert.deepEqual(await callIn(holdFrom({ approve }), send), {});
    assert.deepEqual(await callIn(hook, send, "default"), {});
    // The mode on the hook is the live one, whatever the session opened in.
    const opened = holdFrom({
      approve: () => Effect.succeed({ behavior: "allow" }),
    });
    assert.nestedPropertyVal(
      await callIn(opened, send, "bypassPermissions"),
      "hookSpecificOutput.permissionDecision",
      "allow",
    );
  });
});

describe("codexFullAccessAnswersMcpApproval", () => {
  const ask = (tool: string, serverName = "mail", meta: unknown = MCP_TOOL_CALL) =>
    codexFullAccessAnswersMcpApproval({
      serverName,
      message: `Allow the ${serverName} MCP server to run tool "${tool}"?`,
      meta,
    });
  const MCP_TOOL_CALL = { codex_approval_kind: "mcp_tool_call" };

  it("answers everything except messages to people", () => {
    assert.isTrue(ask("modify_message_labels"));
    assert.isTrue(ask("draft_message"));
    assert.isTrue(ask("t3_thread_send", "t3-code"));
    assert.isFalse(ask("send_message"));
    assert.isFalse(ask("Send message", "codex_apps"));
    assert.isFalse(ask("Schedule message", "codex_apps"));
    assert.isFalse(ask("chat_invite_to_conversation", "codex_apps"));
  });

  it("leaves a question it cannot read to the person", () => {
    assert.isFalse(ask("write_note", "notes", { other: true }));
    assert.isFalse(ask("write_note", "notes", null));
    assert.isFalse(
      codexFullAccessAnswersMcpApproval({
        serverName: "notes",
        message: "Sign in to continue?",
        meta: MCP_TOOL_CALL,
      }),
    );
  });
});

const MODEL_SELECTION = {
  instanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
  model: "claude-sonnet-4-6",
} satisfies ModelSelection;

const turnInput = (input: {
  readonly threadId: ThreadId;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly now: DateTime.Utc;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
}): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project-${input.threadId}`),
    title: "Message approval",
    providerInstanceId: ProviderInstanceId.make(ClaudeAdapterV2.CLAUDE_PROVIDER),
    modelSelection: MODEL_SELECTION,
    runtimeMode: input.runtimePolicy.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId: input.threadId,
  runId: RunId.make(`run-${input.threadId}`),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make(`attempt-${input.threadId}`),
  rootNodeId: NodeId.make(`node-${input.threadId}`),
  providerThread: input.providerThread,
  message: {
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message-${input.threadId}`),
    text: "Tell the team.",
    attachments: [],
  },
  modelSelection: MODEL_SELECTION,
  runtimePolicy: input.runtimePolicy,
});

const openWithChatServer = (
  runtimeMode: ProviderAdapter.ProviderAdapterV2RuntimePolicy["runtimeMode"],
  setup: {
    readonly settings?: ClaudeSettings;
    readonly cwd?: string;
  } = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-tempo-chat-" });
    let openedOptions: ClaudeAdapterV2.ClaudeAgentSdkQueryOptions | undefined;
    const adapter = yield* ClaudeAdapterV2.makeClaudeAdapterV2({
      instanceId: ClaudeAdapterV2.CLAUDE_DEFAULT_INSTANCE_ID,
      settings: setup.settings ?? CLAUDE_SETTINGS,
      environment: {},
      attachmentsDir,
      fileSystem,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed(`native-${runtimeMode}`),
        open: (input) =>
          Effect.sync(() => {
            openedOptions = input.options;
            return {
              messages: Stream.never,
              offer: () => Effect.void,
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              stopTask: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              interrupt: Effect.void,
              close: Effect.void,
            };
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const threadId = ThreadId.make(`thread-tempo-chat-${runtimeMode}`);
    const mcpSession: McpProviderSessionConfig = {
      environmentId: EnvironmentId.make("environment-tempo-chat"),
      threadId,
      providerSessionId: `mcp-${threadId}`,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      endpoint: "http://127.0.0.1:43123/mcp",
      authorizationHeader: "Bearer t3-token",
      browserToolsAvailable: false,
      extraServers: [
        {
          name: "chat",
          url: "https://chat.example.com/mcp",
          headers: { Authorization: "Bearer chat-key" },
        },
      ],
    };
    yield* (yield* McpProviderSessions.McpProviderSessions).set(mcpSession);
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode,
      interactionMode: "default",
      cwd: setup.cwd ?? "/workspace",
    });
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`provider-${threadId}`),
      modelSelection: MODEL_SELECTION,
      runtimePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection: MODEL_SELECTION,
      runtimePolicy,
    });
    yield* runtime.startTurn(
      turnInput({ threadId, providerThread, now: yield* DateTime.now, runtimePolicy }),
    );
    return { runtime, options: openedOptions, threadId };
  });

const testLayer = Layer.mergeAll(IdAllocator.layer, McpProviderSessions.layer, NodeServices.layer);

describe("ClaudeAdapterV2 messages to people", () => {
  it.effect("asks before an MCP message to a person in a full-access thread", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { runtime, options } = yield* openWithChatServer("full-access");
        assert.equal(options?.permissionMode, "bypassPermissions");
        assert.deepEqual(options?.mcpServers?.["chat"], {
          type: "http",
          url: "https://chat.example.com/mcp",
          headers: { Authorization: "Bearer chat-key" },
        });
        const hook = options?.hooks?.PreToolUse?.[0]?.hooks[0];
        assert.isDefined(hook);

        const requestEvent = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "runtime_request.updated"),
          Stream.runHead,
          Effect.forkScoped,
        );
        const decision = yield* Effect.promise(() =>
          hook!(preToolUse("mcp__chat__send_message"), "use-send", {
            signal: new AbortController().signal,
          }),
        ).pipe(Effect.forkScoped);
        const first = yield* Effect.raceFirst(
          Fiber.join(requestEvent).pipe(
            Effect.map((event) => ({ type: "request", event }) as const),
          ),
          Fiber.join(decision).pipe(Effect.map(() => ({ type: "decision" }) as const)),
        );
        assert.equal(first.type, "request", "the message ran without asking");
        if (first.type !== "request") return;
        const event = first.event;
        if (Option.isNone(event) || event.value.type !== "runtime_request.updated") return;

        yield* runtime.respondToRuntimeRequest({
          requestId: event.value.runtimeRequest.id,
          decision: "accept",
        });
        assert.nestedPropertyVal(
          yield* Fiber.join(decision),
          "hookSpecificOutput.permissionDecision",
          "allow",
        );
      }).pipe(Effect.provide(testLayer)),
    ),
  );

  it.effect("installs the hold when the provider's launch args skip permissions", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { options } = yield* openWithChatServer("approval-required", {
          settings: SKIP_PERMISSIONS_SETTINGS,
        });
        assert.equal(options?.permissionMode, "bypassPermissions");
        assert.isDefined(options?.hooks?.PreToolUse?.[0]);
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});

describe("ClaudeAdapterV2 safety policy", () => {
  it.effect("runs the checkout's safety hook in a session started below its root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-tempo-policy-" });
        yield* fileSystem.makeDirectory(path.join(root, ".git"));
        yield* fileSystem.makeDirectory(path.join(root, ".agents", "hooks"), { recursive: true });
        yield* fileSystem.writeFileString(path.join(root, TEMPO_SAFETY_POLICY_FILE), "");
        const cwd = path.join(root, "docs");
        yield* fileSystem.makeDirectory(cwd);

        const { options } = yield* openWithChatServer("full-access", { cwd });
        assert.deepEqual(
          typeof options?.settings === "object" ? options.settings.hooks : undefined,
          tempoSafetyPolicyHooks(path.join(root, TEMPO_SAFETY_POLICY_FILE)),
        );

        const outside = yield* openWithChatServer("full-access");
        assert.isUndefined(
          typeof outside.options?.settings === "object"
            ? outside.options.settings.hooks
            : undefined,
        );
      }).pipe(Effect.provide(testLayer)),
    ),
  );
});
