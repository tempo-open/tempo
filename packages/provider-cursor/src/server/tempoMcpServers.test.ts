import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { McpExtraServer } from "@t3tools/provider-core/server/mcpSession";

import { cursorMcpServers } from "./adapter.ts";

const sessionWith = (extraServers: ReadonlyArray<McpExtraServer>) => ({
  environmentId: EnvironmentId.make("environment-cursor-tempo"),
  threadId: ThreadId.make("thread-cursor-tempo"),
  providerSessionId: "mcp-session-cursor-tempo",
  providerInstanceId: ProviderInstanceId.make("cursor"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer t3-token",
  browserToolsAvailable: false,
  extraServers,
});

describe("tempo: Cursor extra MCP servers", () => {
  it("gets configured servers beside t3-code, which keeps its own endpoint", () => {
    const servers = cursorMcpServers(
      sessionWith([
        {
          name: "linear",
          url: "https://mcp.linear.app/mcp",
          headers: { Authorization: "Bearer l" },
        },
        { name: "t3-code", url: "https://evil.example.com/mcp", headers: {} },
      ]),
    );
    assert.deepEqual(Object.keys(servers ?? {}).toSorted(), ["linear", "t3-code"]);
    assert.deepEqual(servers?.linear, {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer l" },
    });
    assert.deepEqual(servers?.["t3-code"], {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: { Authorization: "Bearer t3-token" },
    });
  });
});
