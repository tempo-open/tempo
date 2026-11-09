import {
  LaptopToolCallInput,
  LaptopToolCallResult,
  LaptopToolsListInput,
  LaptopToolsListResult,
  LaptopToolsUnavailableError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as LaptopToolHosts from "./LaptopToolHosts.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  LaptopToolHosts.LaptopToolHosts,
];

const LaptopToolFailure = Schema.Union([LaptopToolsUnavailableError, OrchestratorMcpFailure]);

const LaptopToolsListTool = Tool.make("laptop_tools_list", {
  description:
    "List the tools on the user's laptop that this thread may ask to use, such as computer use (screenshots, mouse and keyboard on their Mac) or a browser running on the laptop with its logins and its localhost. They run on the user's laptop, not on this environment's machine. The user can stop a tool from the laptop at any time.",
  parameters: LaptopToolsListInput,
  success: LaptopToolsListResult,
  failure: LaptopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "List laptop tools")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("laptop"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const LaptopToolCallTool = Tool.make("laptop_tool_call", {
  description:
    "Call one tool on the user's laptop, from laptop_tools_list. The first call to each laptop tool in a run may ask the user for permission on their laptop, so it can take a while. If they deny it, stop it, or do not answer, the laptop refuses that tool for the rest of the run: do not retry. Results, including screenshots, come back as the tool returned them. Use laptop tools only when the task needs the user's own computer: their logged-in browser, their localhost, or apps on their Mac.",
  parameters: LaptopToolCallInput,
  success: LaptopToolCallResult,
  failure: LaptopToolFailure,
  dependencies,
})
  .annotate(Tool.Title, "Use laptop tool")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("laptop"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const LaptopToolsListToolkit = Toolkit.make(LaptopToolsListTool);
export const LaptopToolCallToolkit = Toolkit.make(LaptopToolCallTool);
const LaptopToolsToolkit = Toolkit.make(LaptopToolsListTool, LaptopToolCallTool);

const requireLaptopAccess = McpInvocationContext.requireThreadMcpCapability("laptop").pipe(
  Effect.mapError(
    () =>
      new LaptopToolsUnavailableError({
        reason:
          'Laptop tools are off for this thread. Do not retry them. The user can turn on "Agent laptop access" in Settings; it applies when the agent session next starts.',
      }),
  ),
);

const handlers = {
  laptop_tools_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireLaptopAccess;
      const hosts = yield* LaptopToolHosts.LaptopToolHosts;
      return yield* hosts.listTools({ hostId: input?.hostId });
    }),
  ),
  laptop_tool_call: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireLaptopAccess;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const hosts = yield* LaptopToolHosts.LaptopToolHosts;
      const shell = yield* threads.getThreadShell(scope.thread.threadId).pipe(
        Effect.mapError(
          (cause) =>
            new LaptopToolsUnavailableError({
              reason: "Could not read this thread to ask the user for permission.",
              cause,
            }),
        ),
      );
      // A grant lasts one run, so a call outside an active run has nothing to ask for.
      const runId = shell?.activeRunId ?? null;
      if (shell === null || runId === null) {
        return yield* new LaptopToolsUnavailableError({
          reason: "Laptop tools work only while this thread's run is active.",
        });
      }
      return yield* hosts.callTool({
        hostId: input.hostId,
        serverId: input.server,
        tool: input.tool,
        arguments: input.arguments ?? {},
        threadId: scope.thread.threadId,
        threadTitle: shell.title,
        runId,
        timeoutMs: input.timeoutMs,
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof LaptopToolsToolkit.tools>;

const { laptop_tool_call, ...listHandlers } = handlers;

export const layerList = McpToolAccess.toLayer(LaptopToolsListToolkit, listHandlers);

export const layerCall = McpToolAccess.toLayer(LaptopToolCallToolkit, { laptop_tool_call });

const decodeJson = Schema.decodeUnknownOption(Schema.Json);

/**
 * The MCP result for a laptop tool call: the laptop tool's own content blocks,
 * images included, so the model sees a screenshot as an image and not as
 * base64 text.
 */
export const toCallToolResult = (result: LaptopToolCallResult): McpSchema.CallToolResult => {
  const structuredContent =
    result.structuredContent === undefined ? Option.none() : decodeJson(result.structuredContent);
  return new McpSchema.CallToolResult({
    isError: result.isError ?? false,
    ...(Option.isSome(structuredContent) ? { structuredContent: structuredContent.value } : {}),
    content: result.content.map((block) =>
      block.type === "text"
        ? { type: "text" as const, text: block.text }
        : {
            type: "image" as const,
            data: new Uint8Array(Buffer.from(block.data, "base64")),
            mimeType: block.mimeType,
          },
    ),
  });
};
