/**
 * tempo: the agent's computer use on the machine its thread runs on, through
 * `HostComputerUse`. `laptop_tools_*` reach the person's laptop instead.
 */
import {
  LaptopToolCallResult,
  LaptopToolDescriptor,
  OrchestratorMcpFailure,
  PositiveInt,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as HostComputerUse from "./HostComputerUse.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  HostComputerUse.HostComputerUse,
];

const ComputerUseFailure = Schema.Union([
  HostComputerUse.HostComputerUseError,
  OrchestratorMcpFailure,
]);

const ComputerUseToolsTool = Tool.make("computer_use_tools", {
  description: `List the computer use tools for this Mac: screenshots, apps' accessibility state, clicks, typing and keys on its screen, through Open Computer Use. Try an API and the command line first; use these only when those cannot do the task, such as a desktop app's sign-in. The first call can take a minute while ${TEMPO_APP_BASE_NAME} installs Open Computer Use.`,
  parameters: Tool.EmptyParams,
  success: Schema.Struct({
    /** The machine's name. */
    host: Schema.String,
    tools: Schema.Array(LaptopToolDescriptor),
  }),
  failure: ComputerUseFailure,
  dependencies,
})
  .annotate(Tool.Title, "List computer use tools")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("computer"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ComputerUseTool = Tool.make("computer_use", {
  description:
    "Call one tool from computer_use_tools on this machine's screen. Calls run one at a time and other threads on this machine share the screen, so read an app's state again before acting on it. Results, including screenshots, come back as the tool returned them. Ask the user before sending a message to a person.",
  parameters: Schema.Struct({
    tool: Schema.String.check(Schema.isMaxLength(128)).annotate({
      description: "A tool name from computer_use_tools.",
    }),
    arguments: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    timeoutMs: Schema.optional(
      PositiveInt.check(Schema.isLessThanOrEqualTo(270_000)).annotate({
        description: "How long to wait for the tool, in milliseconds. Defaults to two minutes.",
      }),
    ),
  }),
  success: LaptopToolCallResult,
  failure: ComputerUseFailure,
  dependencies,
})
  .annotate(Tool.Title, "Use this computer")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("computer"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const ComputerUseToolsToolkit = Toolkit.make(ComputerUseToolsTool);
export const ComputerUseToolkit = Toolkit.make(ComputerUseTool);

const requireComputerUse = McpInvocationContext.requireThreadMcpCapability("computer").pipe(
  Effect.mapError(
    () =>
      new HostComputerUse.HostComputerUseError({
        reason:
          'Computer use is off for this machine. Do not retry it. The user can turn on "Agent computer use on this machine" in Settings; it applies when the agent session next starts.',
      }),
  ),
);

export const layerList = McpToolAccess.toLayer(ComputerUseToolsToolkit, {
  computer_use_tools: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      yield* requireComputerUse;
      const computer = yield* HostComputerUse.HostComputerUse;
      return yield* computer.listTools;
    }),
  ),
});

export const layerCall = McpToolAccess.toLayer(ComputerUseToolkit, {
  computer_use: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      yield* requireComputerUse;
      const computer = yield* HostComputerUse.HostComputerUse;
      return yield* computer.callTool({
        tool: input.tool,
        arguments: input.arguments ?? {},
        timeoutMs: input.timeoutMs,
      });
    }),
  ),
});
