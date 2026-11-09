import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  LaptopToolHostId,
  LaptopToolServerId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type LaptopToolsRequest,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../../mcp/McpHttpServer.ts";
import type * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import { McpInvocationContext as McpInvocationContextTag } from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../mcp/McpToolAccess.testkit.ts";
import * as LaptopToolHosts from "./LaptopToolHosts.ts";

const threadId = ThreadId.make("thread-laptop-mcp");
const hostId = LaptopToolHostId.make("laptop-mcp");
const computerUse = LaptopToolServerId.make("computer-use");

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-laptop-mcp"),
  requestNamespace: "provider-session-laptop-mcp",
  thread: {
    threadId,
    providerSessionId: "provider-session-laptop-mcp",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  clientCapabilities: {},
  clientInfo: { name: "laptop-mcp-test", version: "1.0.0" },
  protocolVersion: "2025-06-18",
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "laptop-mcp-test", version: "1.0.0" },
  },
  getClient: Effect.die("unused"),
});

const layerTest = McpHttpServer.layerLaptopToolkit.pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(McpToolAccessTestkit.liveThreadsLayer),
  Layer.provideMerge(LaptopToolHosts.layer),
  Layer.provideMerge(NodeServices.layer),
);

const png = Buffer.from("not really a png");

/** A laptop that answers every call with a caption and a screenshot. */
const serveScreenshots = Effect.gen(function* () {
  const hosts = yield* LaptopToolHosts.LaptopToolHosts;
  const connected = yield* Deferred.make<void>();
  const requests: LaptopToolsRequest[] = [];
  const stream = yield* hosts.connect(
    {
      hostId,
      hostLabel: "Ada's MacBook",
      servers: [{ id: computerUse, name: "Computer use" }],
      accepts: ["listTools", "callTool"],
    },
    "session-laptop-mcp",
  );
  yield* Stream.runForEach(stream, (event) => {
    if (event.type === "connected") return Deferred.succeed(connected, undefined);
    if (event.type !== "request") return Effect.void;
    requests.push(event.request);
    return hosts.respond(
      {
        hostId,
        connectionId: event.connectionId,
        requestId: event.requestId,
        outcome: {
          _tag: "result",
          result: {
            content: [
              { type: "text", text: "Captured the main display." },
              { type: "image", data: png.toString("base64"), mimeType: "image/png" },
            ],
          },
        },
      },
      "session-laptop-mcp",
    );
  }).pipe(Effect.forkScoped);
  yield* Deferred.await(connected);
  return requests;
});

const callLaptopTool = (capabilities: ReadonlyArray<McpInvocationContext.McpCapability>) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    return yield* server
      .callTool({
        name: "laptop_tool_call",
        arguments: { server: "computer-use", tool: "screenshot", arguments: { display: 1 } },
      })
      .pipe(
        Effect.provideService(McpInvocationContextTag, invocation(capabilities)),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
  });

it.layer(layerTest)("laptop tools over MCP", (it) => {
  it.effect("passes the laptop tool's text and screenshot through to the agent", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* serveScreenshots;

        const result = yield* callLaptopTool(["laptop"]);

        expect(result.isError).toBe(false);
        expect(result.content).toEqual([
          { type: "text", text: "Captured the main display." },
          { type: "image", data: new Uint8Array(png), mimeType: "image/png" },
        ]);
        // The consent prompt names the thread, and the grant is tied to its run.
        expect(requests).toMatchObject([
          {
            _tag: "callTool",
            threadId,
            threadTitle: threadId,
            runId: RunId.make("run:mcp-test"),
            arguments: { display: 1 },
          },
        ]);
      }),
    ),
  );

  it.effect("hides the tool without the laptop capability and never reaches the laptop", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const requests = yield* serveScreenshots;

        const error = yield* callLaptopTool(["preview", "orchestration"]).pipe(Effect.flip);

        expect(error.message).toBe("Tool 'laptop_tool_call' not found");
        expect(requests).toEqual([]);
      }),
    ),
  );

  it.effect("lists laptop tools as JSON", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const server = yield* McpServer.McpServer;
        const hosts = yield* LaptopToolHosts.LaptopToolHosts;
        const connected = yield* Deferred.make<void>();
        const stream = yield* hosts.connect(
          {
            hostId,
            hostLabel: "Ada's MacBook",
            servers: [{ id: computerUse, name: "Computer use" }],
            accepts: ["listTools", "callTool"],
          },
          "session-laptop-mcp",
        );
        yield* Stream.runForEach(stream, (event) => {
          if (event.type === "connected") return Deferred.succeed(connected, undefined);
          if (event.type !== "request") return Effect.void;
          return hosts.respond(
            {
              hostId,
              connectionId: event.connectionId,
              requestId: event.requestId,
              outcome: {
                _tag: "tools",
                servers: [
                  {
                    id: computerUse,
                    name: "Computer use",
                    tools: [{ name: "screenshot", description: "Capture the screen." }],
                  },
                ],
              },
            },
            "session-laptop-mcp",
          );
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(connected);

        const result = yield* server
          .callTool({ name: "laptop_tools_list", arguments: {} })
          .pipe(
            Effect.provideService(McpInvocationContextTag, invocation(["laptop"])),
            Effect.provideService(McpSchema.McpServerClient, client),
          );

        expect(result.isError).toBe(false);
        expect(result.structuredContent).toEqual({
          hosts: [
            {
              hostId,
              hostLabel: "Ada's MacBook",
              servers: [
                {
                  id: computerUse,
                  name: "Computer use",
                  tools: [{ name: "screenshot", description: "Capture the screen." }],
                },
              ],
            },
          ],
        });
      }),
    ),
  );
});
