import { assert, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  TempoMcpServerList,
  type TempoMcpServerConfig,
  EnvironmentId,
  ProviderInstanceId,
  ProviderSessionId,
  ServerSettings as ServerSettingsSchema,
  ThreadId,
  tempoMcpServerProblem,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type { McpProviderSessionConfig } from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";
import { describe } from "vite-plus/test";

import * as ClaudeAdapterV2 from "../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as CodexAdapterV2 from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import {
  describeMcpElicitation,
  toMcpElicitationResponse,
} from "../provider/CodexMcpElicitation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED, mapSettingsSecrets } from "../settingsSecrets.ts";
import * as TempoAgentMcpServers from "./TempoAgentMcpServers.ts";

const server = (overrides: Partial<TempoMcpServerConfig> = {}): TempoMcpServerConfig => ({
  id: "linear",
  name: "linear",
  url: "https://mcp.linear.app/mcp",
  enabled: true,
  headers: [{ name: "Authorization", value: "Bearer lin_123" }],
  ...overrides,
});

describe("buildTempoAgentMcpServers", () => {
  it("sends each configured server with its headers", () => {
    assert.deepEqual(TempoAgentMcpServers.buildTempoAgentMcpServers([server()]), [
      {
        name: "linear",
        url: "https://mcp.linear.app/mcp",
        headers: { Authorization: "Bearer lin_123" },
      },
    ]);
  });

  it("skips disabled, invalid, reserved and duplicate entries, and drops empty headers", () => {
    const servers = TempoAgentMcpServers.buildTempoAgentMcpServers([
      server({ id: "off", name: "off", enabled: false }),
      server({ id: "bad-url", name: "bad-url", url: "ftp://example.com" }),
      server({ id: "t3", name: "t3-code" }),
      server({ id: "dup", name: "Linear" }),
      server({ id: "blank", name: "blank", headers: [{ name: "X-Token", value: "" }] }),
      server(),
    ]);
    assert.deepEqual(
      servers.map((entry) => [entry.name, entry.headers]),
      [
        ["Linear", { Authorization: "Bearer lin_123" }],
        ["blank", {}],
      ],
    );
  });
});

describe("TempoMcpServerList", () => {
  const decode = Schema.decodeUnknownExit(TempoMcpServerList);

  it("accepts valid servers and rejects reserved, duplicate, and malformed ones", () => {
    assert.isTrue(decode([server()])._tag === "Success");
    assert.isTrue(decode([server({ name: "t3-code" })])._tag === "Failure");
    assert.isTrue(decode([server(), server({ id: "other", name: "LINEAR" })])._tag === "Failure");
    assert.isTrue(decode([server({ name: "has space" })])._tag === "Failure");
    assert.isTrue(
      decode([
        server({
          headers: [
            { name: "X-A", value: "1" },
            { name: "x-a", value: "2" },
          ],
        }),
      ])._tag === "Failure",
    );
  });

  it("explains each problem in a sentence", () => {
    assert.match(tempoMcpServerProblem(server({ name: "t3-code" })) ?? "", /reserved/);
    assert.match(
      tempoMcpServerProblem(server({ url: "https://user:pw@example.com" })) ?? "",
      /http\(s\) URL/,
    );
    assert.isNull(tempoMcpServerProblem(server()));
  });
});

const decodeServerSettings = Schema.decodeUnknownExit(ServerSettingsSchema);

describe("saved MCP servers in the settings file", () => {
  it("drops a malformed entry instead of failing the whole file", () => {
    const decoded = decodeServerSettings({
      defaultAutoPull: true,
      mcpServers: [
        { id: "no-url", name: "no-url" },
        { id: "blank", name: "", url: "https://a.example.com" },
        "junk",
        server(),
      ],
    });
    assert.equal(decoded._tag, "Success");
    if (decoded._tag !== "Success") return;
    assert.deepEqual(
      decoded.value.mcpServers.map((entry) => entry.id),
      ["linear"],
    );
    assert.equal(decoded.value.defaultAutoPull, true);
  });
});

describe("MCP server header secrets", () => {
  it("names each header secret by server id and header, and redacts it for clients", () => {
    const settings = { ...DEFAULT_SERVER_SETTINGS, mcpServers: [server()] };
    const seen: Array<string> = [];
    mapSettingsSecrets(settings, (secret) => {
      seen.push(secret.secretName);
      return secret;
    });
    assert.isTrue(seen.some((name) => name.startsWith("mcp-server-")));
    const redacted = ServerSettings.redactServerSettingsForClient(settings);
    assert.equal(redacted.mcpServers[0]?.headers[0]?.value, SECRET_REDACTED);
    assert.equal(redacted.mcpServers[0]?.url, "https://mcp.linear.app/mcp");
  });

  it("refuses plain http for a server with headers, except on this machine", () => {
    assert.isString(tempoMcpServerProblem(server({ url: "http://mcp.linear.app/mcp" })));
    assert.isNull(tempoMcpServerProblem(server({ url: "http://127.0.0.1:9000/mcp" })));
    assert.isNull(tempoMcpServerProblem(server({ url: "http://mcp.linear.app/mcp", headers: [] })));
  });

  it("keeps a saved header for a new path on the same host, but not on another host", () => {
    const names = (url: string) => {
      const seen: Array<string> = [];
      mapSettingsSecrets(
        { ...DEFAULT_SERVER_SETTINGS, mcpServers: [server({ url })] },
        (secret) => {
          seen.push(secret.secretName);
          return secret;
        },
      );
      return seen;
    };
    const saved = names("https://mcp.linear.app/mcp");
    assert.deepEqual(names("https://mcp.linear.app/v2/mcp"), saved);
    assert.notDeepEqual(names("https://attacker.example.com/mcp"), saved);
    assert.notDeepEqual(names("http://mcp.linear.app/mcp"), saved);
  });
});

const serviceLayer = TempoAgentMcpServers.layer.pipe(
  Layer.provideMerge(McpProviderSessions.layer),
  Layer.provideMerge(ServerSettings.layerTest({ mcpServers: [server()] })),
);

describe("TempoAgentMcpServers.current", () => {
  it.effect("reads the configured servers", () =>
    Effect.gen(function* () {
      const service = yield* TempoAgentMcpServers.TempoAgentMcpServers;
      assert.deepEqual(
        (yield* service.current).map((entry) => entry.name),
        ["linear"],
      );
    }).pipe(Effect.provide(serviceLayer)),
  );

  it.effect("rewrites live sessions after the servers change, and forgets released ones", () =>
    Effect.gen(function* () {
      const service = yield* TempoAgentMcpServers.TempoAgentMcpServers;
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const settings = yield* ServerSettings.ServerSettingsService;
      const live = sessionWith(yield* service.forThread(ThreadId.make("thread-tempo")));
      yield* sessions.set(live);
      assert.deepEqual(
        (live.extraServers ?? []).map((entry) => entry.name),
        ["linear"],
      );

      yield* settings.updateSettings({
        mcpServers: [server(), server({ id: "github", name: "github" })],
      });
      yield* service.refreshSessions;
      const afterChange = yield* sessions.read(live.threadId);
      assert.deepEqual(
        (afterChange?.extraServers ?? []).map((entry) => entry.name),
        ["linear", "github"],
      );
      // The thread's own credential is untouched.
      assert.equal(afterChange?.authorizationHeader, live.authorizationHeader);

      yield* sessions.clear(live.threadId);
      yield* service.refreshSessions;
      assert.isUndefined(yield* sessions.read(live.threadId));
    }).pipe(Effect.provide(serviceLayer)),
  );
});

const sessionWith = (
  extraServers: McpProviderSessionConfig["extraServers"],
): McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("environment-tempo"),
  threadId: ThreadId.make("thread-tempo"),
  providerSessionId: "mcp-session-tempo",
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  endpoint: "http://127.0.0.1:43123/mcp",
  authorizationHeader: "Bearer t3-token",
  browserToolsAvailable: true,
  ...(extraServers === undefined ? {} : { extraServers }),
});

const githubAndLinear = [
  {
    name: "github",
    url: "https://api.githubcopilot.com/mcp",
    headers: { Authorization: "Bearer gh" },
  },
  { name: "linear", url: "https://mcp.linear.app/mcp", headers: { Authorization: "Bearer lin" } },
  // A stray entry must never replace T3's own server.
  { name: "t3-code", url: "https://evil.example.com/mcp", headers: {} },
];

describe("Claude MCP merge", () => {
  it("adds configured servers beside t3-code and pre-approves none of their tools", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: sessionWith(githubAndLinear),
      readOnlySandbox: false,
    });
    const servers = overrides.mcpServers ?? {};
    assert.deepEqual(Object.keys(servers).toSorted(), ["github", "linear", "t3-code"]);
    assert.deepEqual(servers["t3-code"], {
      type: "http",
      url: "http://127.0.0.1:43123/mcp",
      headers: { Authorization: "Bearer t3-token" },
      timeout: ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_TIMEOUT_MS,
    });
    assert.deepEqual(servers.github, {
      type: "http",
      url: "https://api.githubcopilot.com/mcp",
      headers: { Authorization: "Bearer gh" },
    });
    // Only the T3 tools Claude pre-approves anyway (service writes still ask).
    assert.deepEqual(overrides.allowedTools, [...ClaudeAdapterV2.CLAUDE_T3_MCP_PREAPPROVED_TOOLS]);
  });

  it("keeps the t3-code wildcard out of a read-only sandbox", () => {
    const overrides = ClaudeAdapterV2.claudeMcpQueryOverrides({
      mcpSession: sessionWith(githubAndLinear),
      readOnlySandbox: true,
    });
    assert.notInclude(overrides.allowedTools ?? [], ClaudeAdapterV2.CLAUDE_T3_MCP_TOOL_WILDCARD);
  });

  it("re-opens the live query when the configured servers change", () => {
    const policy = ClaudeAdapterV2.claudeRuntimeQueryPolicyForRuntimePolicy(
      ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
        runtimeMode: "approval-required",
        interactionMode: "default",
        cwd: "/workspace",
      }),
    );
    const keyFor = (session: McpProviderSessionConfig) =>
      ClaudeAdapterV2.claudeEffectiveQueryPolicyKey(
        policy,
        ClaudeAdapterV2.claudeMcpQueryOverrides({ mcpSession: session, readOnlySandbox: false }),
      );
    assert.notEqual(keyFor(sessionWith(undefined)), keyFor(sessionWith([githubAndLinear[0]!])));
  });
});

/** Codex's MCP servers by name: each is its own `mcp_servers.<name>` thread config key. */
const codexMcpServers = (config: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(config).flatMap(([key, server]) =>
      key.startsWith("mcp_servers.") ? [[key.slice("mcp_servers.".length), server]] : [],
    ),
  ) as Record<string, Record<string, unknown>>;

describe("Codex MCP merge", () => {
  it("gives the agent's commands the thread id, and nothing else", () => {
    const { config } = CodexAdapterV2.codexThreadRuntimeParams({
      threadId: "thread-a",
      mcpSession: undefined,
    });
    assert.equal(config["shell_environment_policy.set.T3CODE_THREAD_ID"], "thread-a");
    assert.notProperty(
      CodexAdapterV2.codexThreadRuntimeParams({ mcpSession: undefined }).config,
      "shell_environment_policy.set.T3CODE_THREAD_ID",
    );
  });

  it("adds configured servers to mcp_servers without replacing t3-code", () => {
    const params = CodexAdapterV2.codexThreadRuntimeParams({
      mcpSession: sessionWith(githubAndLinear),
    });
    assert.deepEqual(codexMcpServers(params.config), {
      github: {
        url: "https://api.githubcopilot.com/mcp",
        http_headers: { Authorization: "Bearer gh" },
      },
      linear: {
        url: "https://mcp.linear.app/mcp",
        http_headers: { Authorization: "Bearer lin" },
      },
      "t3-code": {
        url: "http://127.0.0.1:43123/mcp",
        http_headers: { Authorization: "Bearer t3-token" },
        tool_timeout_sec: 3_900,
      },
    });
  });

  it("shows the person Codex's approval for a configured server's tool, without an always-allow choice", () => {
    // What Codex 0.156.1 sends for a `prompt` tool call.
    const request = {
      serverName: "linear",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      mode: "form",
      message: 'Allow the linear MCP server to run tool "create_issue"?',
      _meta: {
        codex_approval_kind: "mcp_tool_call",
        tool_description: "File an issue.",
        tool_params: { title: "Ship it" },
        tool_params_display: [{ name: "title", value: "Ship it", display_name: "title" }],
      },
      requestedSchema: { type: "object", properties: {} },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;
    assert.deepEqual(describeMcpElicitation(request), {
      appName: "linear",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "accept", label: "Approve" },
      ],
    });
    // Codex runs the tool on this accept and skips it on a decline.
    assert.deepEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: {},
    });
    assert.deepEqual(toMcpElicitationResponse(request, "decline"), { action: "decline" });
  });

  it("leaves mcp_servers as before without extra servers", () => {
    const params = CodexAdapterV2.codexThreadRuntimeParams({ mcpSession: sessionWith(undefined) });
    assert.deepEqual(Object.keys(codexMcpServers(params.config)), ["t3-code"]);
  });

  it.effect("never writes a configured header's value to the provider log", () =>
    Effect.gen(function* () {
      const writes: Array<unknown> = [];
      const logger: ProviderEventLoggers.EventNdjsonLogger = {
        filePath: "/tmp/events.log",
        write: (event) => Effect.sync(() => void writes.push(event)),
        close: () => Effect.void,
      };
      const protocolLogger = CodexAdapterV2.makeCodexAppServerProtocolLogger({
        nativeEventLogger: logger,
        threadId: ThreadId.make("thread-tempo"),
        providerSessionId: ProviderSessionId.make("provider-session-tempo"),
      });
      assert.isDefined(protocolLogger);
      const custom = [
        {
          name: "cloudflare",
          url: "https://mcp.example.com/mcp",
          headers: { "X-Auth-Key": "cfkey123", Cookie: "session=abc" },
        },
      ];
      yield* protocolLogger!({
        direction: "outgoing",
        stage: "decoded",
        payload: {
          method: "thread/start",
          params: CodexAdapterV2.codexThreadRuntimeParams({ mcpSession: sessionWith(custom) }),
        },
      });
      const logged = JSON.stringify(writes);
      assert.notInclude(logged, "cfkey123");
      assert.notInclude(logged, "session=abc");
      assert.notInclude(logged, "t3-token");
      assert.include(logged, "X-Auth-Key");
    }),
  );
});
