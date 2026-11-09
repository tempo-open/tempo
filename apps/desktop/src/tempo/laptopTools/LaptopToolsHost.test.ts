// @effect-diagnostics nodeBuiltinImport:off -- The fake MCP server speaks over Node streams like a real child process.
// @effect-diagnostics globalDate:off globalTimers:off -- The host under test is plain Promise code.
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import {
  EnvironmentId,
  LaptopToolServerId,
  RunId,
  ThreadId,
  type DesktopLaptopToolsHandleInput,
  type DesktopLaptopToolsState,
  type LaptopToolsCallRequest,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_LAPTOP_TOOLS_CONFIG } from "./laptopToolConfig.ts";
import { LAPTOP_TOOL_GRANT_IDLE_MS, type LaptopToolConsentDecision } from "./laptopToolGrants.ts";
import {
  LAPTOP_TOOL_RESULT_MAX_CHARS,
  LAPTOP_TOOL_SERVER_IDLE_MS,
  LaptopToolsHost,
} from "./LaptopToolsHost.ts";
import type { McpChildProcess, SpawnMcpProcess } from "@t3tools/shared/mcpStdioClient";

const environmentId = EnvironmentId.make("env-mini");
const PNG_BASE64 = "iVBORw0KGgo=";

type CallHandler = (
  name: string,
  args: Record<string, unknown>,
  reply: (result: unknown) => void,
) => void;

/** An in-memory stdio MCP server; records what the laptop asked of it. */
function fakeMcpServers(onCall: CallHandler) {
  const spawned: Array<{ command: string; args: ReadonlyArray<string> }> = [];
  const spawnedEnv: NodeJS.ProcessEnv[] = [];
  const cancelled: unknown[] = [];
  const spawn: SpawnMcpProcess = (command, args, env) => {
    spawned.push({ command, args });
    spawnedEnv.push(env);
    const stdin = new NodeStream.PassThrough();
    const stdout = new NodeStream.PassThrough();
    const stderr = new NodeStream.PassThrough();
    const events = new NodeEvents.EventEmitter();
    const send = (message: unknown) => stdout.write(`${JSON.stringify(message)}\n`);
    let buffer = "";
    stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          id?: number;
          method: string;
          params?: { name?: string; arguments?: Record<string, unknown> };
        };
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (message.method === "initialize") {
          send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18" } });
        } else if (message.method === "tools/list") {
          send({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [{ name: "screenshot", inputSchema: { type: "object" } }] },
          });
        } else if (message.method === "tools/call") {
          onCall(message.params?.name ?? "", message.params?.arguments ?? {}, (result) =>
            send({ jsonrpc: "2.0", id: message.id, result }),
          );
        } else if (message.method === "notifications/cancelled") {
          cancelled.push(message.params);
        }
      }
    });
    const child: McpChildProcess = {
      stdin,
      stdout,
      stderr,
      kill: () => {
        events.emit("exit", null, "SIGTERM");
        return true;
      },
      once: (event: string, listener: (...args: never[]) => void) =>
        events.once(event, listener as (...args: unknown[]) => void),
    };
    return child;
  };
  return { spawn, spawned, spawnedEnv, cancelled };
}

function makeHost(options: {
  readonly onCall: CallHandler;
  readonly decide?: LaptopToolConsentDecision | "never";
  readonly installed?: boolean;
  /** Most tests exercise the prompt, so they ask unless told otherwise. */
  readonly askBeforeUse?: boolean;
}) {
  const servers = fakeMcpServers(options.onCall);
  const prompts: unknown[] = [];
  const states: DesktopLaptopToolsState[] = [];
  const stateWaiters: Array<{
    readonly matches: (state: DesktopLaptopToolsState) => boolean;
    readonly resolve: () => void;
  }> = [];
  let now = 1_000_000;
  const host = new LaptopToolsHost(
    {
      hostLabel: "Alex's MacBook",
      clientVersion: "test",
      platform: "darwin",
      browserProfileDir: "/state/laptop-browser-profile",
      env: () => ({ PATH: "/opt/homebrew/bin", HOME: "/Users/ada", SSH_AUTH_SOCK: "/tmp/agent" }),
      isExecutableFile: (candidate) =>
        options.installed !== false && candidate.startsWith("/opt/homebrew/bin/"),
      prompt: (request, signal) => {
        prompts.push(request);
        if (options.decide === "never") {
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => resolve("dismissed"), { once: true }),
          );
        }
        return Promise.resolve(options.decide ?? "allow");
      },
      now: () => now,
      onState: (state) => {
        states.push(state);
        for (const waiter of stateWaiters.splice(0)) {
          if (waiter.matches(state)) waiter.resolve();
          else stateWaiters.push(waiter);
        }
      },
      saveConfig: async () => undefined,
      spawn: servers.spawn,
    },
    {
      ...DEFAULT_LAPTOP_TOOLS_CONFIG,
      askBeforeUse: options.askBeforeUse ?? true,
      servers: DEFAULT_LAPTOP_TOOLS_CONFIG.servers.map((server) => ({ ...server, enabled: true })),
    },
  );
  /** Resolves on the first state the host reports that matches. */
  const stateWhere = (matches: (state: DesktopLaptopToolsState) => boolean) =>
    new Promise<void>((resolve) => stateWaiters.push({ matches, resolve }));
  return {
    host,
    prompts,
    states,
    stateWhere,
    advance: (ms: number) => {
      now += ms;
    },
    ...servers,
  };
}

const listRequest: DesktopLaptopToolsHandleInput = {
  environmentId,
  environmentLabel: "Office Mac mini",
  requestId: "list",
  request: { _tag: "listTools" },
};

const callInput = (
  requestId: string,
  overrides: Partial<LaptopToolsCallRequest> = {},
): DesktopLaptopToolsHandleInput => ({
  environmentId,
  environmentLabel: "Office Mac mini",
  requestId,
  request: {
    _tag: "callTool",
    threadId: ThreadId.make("thread-1"),
    threadTitle: "Check the dashboard",
    runId: RunId.make("run-1"),
    serverId: LaptopToolServerId.make("computer-use"),
    tool: "screenshot",
    arguments: { display: 1 },
    timeoutMs: 5_000,
    ...overrides,
  },
});

describe("laptop tools host", () => {
  it("passes text and screenshots through and turns other blocks into text", async () => {
    const { host, prompts, spawned, spawnedEnv } = makeHost({
      onCall: (_name, _args, reply) =>
        reply({
          content: [
            { type: "text", text: "Captured display 1" },
            { type: "image", data: PNG_BASE64, mimeType: "image/png" },
            { type: "audio", data: "AAAA", mimeType: "audio/wav" },
          ],
        }),
    });
    const outcome = await host.handleRequest(callInput("r1"));
    expect(outcome).toEqual({
      _tag: "result",
      result: {
        content: [
          { type: "text", text: "Captured display 1" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          { type: "text", text: "[audio content omitted]" },
        ],
      },
    });
    expect(prompts).toHaveLength(1);
    expect(spawned).toEqual([{ command: "/opt/homebrew/bin/open-computer-use", args: ["mcp"] }]);
    // Tool servers get what a program needs to run, not the app's secrets.
    expect(spawnedEnv).toEqual([{ PATH: "/opt/homebrew/bin", HOME: "/Users/ada" }]);
    host.dispose();
  });

  it("never starts a tool the person denied", async () => {
    const { host, spawned } = makeHost({
      decide: "deny",
      onCall: () => {
        throw new Error("must not be called");
      },
    });
    const outcome = await host.handleRequest(callInput("r1"));
    expect(outcome).toMatchObject({ _tag: "failure", code: "denied" });
    expect(spawned).toHaveLength(0);
    host.dispose();
  });

  it("refuses a server that is off or not installed before asking anyone", async () => {
    const off = makeHost({ installed: false, onCall: () => undefined });
    expect(await off.host.handleRequest(callInput("r1"))).toMatchObject({
      _tag: "failure",
      code: "server-unavailable",
    });
    expect(
      await off.host.handleRequest(
        callInput("r2", { serverId: LaptopToolServerId.make("not-configured") }),
      ),
    ).toMatchObject({ _tag: "failure", code: "server-not-found" });
    expect(off.prompts).toHaveLength(0);
    off.host.dispose();
  });

  it("keeps computer use off Tempo: refused before asking, and left out of list_apps", async () => {
    const { host, prompts, spawned } = makeHost({
      onCall: (_name, _args, reply) =>
        reply({
          content: [
            {
              type: "text",
              text: "Tempo — local.tempo.app [frontmost, running]\nNotes — com.apple.Notes [running]",
            },
          ],
        }),
    });
    const refused = await host.handleRequest(
      callInput("r1", {
        tool: "get_app_state",
        arguments: { app: "Tempo", window_placement: "agent_display" },
      }),
    );
    expect(refused).toMatchObject({
      _tag: "failure",
      code: "failed",
      message: expect.stringContaining("Tempo is the app the user talks to you in"),
    });
    expect(prompts).toHaveLength(0);
    expect(spawned).toHaveLength(0);

    expect(await host.handleRequest(callInput("r2", { tool: "list_apps", arguments: {} }))).toEqual(
      {
        _tag: "result",
        result: { content: [{ type: "text", text: "Notes — com.apple.Notes [running]" }] },
      },
    );
    host.dispose();
  });

  it("cancels a running call on the tool server when the environment cancels it", async () => {
    const { promise: serverCalled, resolve: onCall } = Promise.withResolvers<void>();
    const { host, cancelled } = makeHost({ onCall: () => onCall() });
    const pending = host.handleRequest(callInput("r1"));
    await serverCalled;
    host.cancelRequest(environmentId, "r1");
    expect(await pending).toMatchObject({ _tag: "failure", code: "cancelled" });
    expect(cancelled).toHaveLength(1);
    host.dispose();
  });

  it("reports a timeout when nobody answers the permission prompt", async () => {
    const { host, spawned } = makeHost({ decide: "never", onCall: () => undefined });
    const outcome = await host.handleRequest(callInput("r1", { timeoutMs: 30 }));
    expect(outcome).toMatchObject({ _tag: "failure", code: "timeout" });
    expect(spawned).toHaveLength(0);
    host.dispose();
  });

  it("stopping a grant stops its call and tells the agent the person stopped it", async () => {
    const { promise: serverCalled, resolve: onCall } = Promise.withResolvers<void>();
    const { host, states } = makeHost({ onCall: () => onCall() });
    const pending = host.handleRequest(callInput("r1"));
    await serverCalled;
    const grant = states.at(-1)?.grants[0];
    expect(grant?.inFlight).toBe(1);
    host.stop(grant?.key);
    expect(await pending).toMatchObject({ _tag: "failure", code: "denied" });
    expect(states.at(-1)?.grants).toEqual([]);
    host.dispose();
  });

  it("with asking off, runs a turned-on tool without a prompt and Stop still refuses the run", async () => {
    const { host, prompts, stateWhere } = makeHost({
      askBeforeUse: false,
      onCall: () => undefined,
    });
    const inUse = (runId: string) => (state: DesktopLaptopToolsState) =>
      state.grants.some((grant) => grant.runId === runId && grant.inFlight === 1);

    const first = host.handleRequest(callInput("r1"));
    await stateWhere(inUse("run-1"));
    expect(prompts).toHaveLength(0);
    host.stop();
    expect(await first).toMatchObject({ _tag: "failure", code: "denied" });
    expect(await host.handleRequest(callInput("r2"))).toMatchObject({
      _tag: "failure",
      code: "denied",
    });

    // The next run may use it again, still without a prompt.
    const second = host.handleRequest(callInput("r3", { runId: RunId.make("run-2") }));
    await stateWhere(inUse("run-2"));
    expect(prompts).toHaveLength(0);

    // Turning asking on ends grants made without it, so the next call asks.
    await host.setConfig({ ...host.state().config, askBeforeUse: true });
    expect(await second).toMatchObject({ _tag: "failure", code: "denied" });
    void host.handleRequest(callInput("r4", { runId: RunId.make("run-2") }));
    await stateWhere(inUse("run-2"));
    expect(prompts).toHaveLength(1);
    host.dispose();
  });

  it("refuses a result larger than the laptop sends back", async () => {
    const { host } = makeHost({
      onCall: (_name, _args, reply) =>
        reply({
          content: [{ type: "text", text: "x".repeat(LAPTOP_TOOL_RESULT_MAX_CHARS + 1) }],
        }),
    });
    expect(await host.handleRequest(callInput("r1"))).toMatchObject({
      _tag: "failure",
      code: "too-large",
    });
    host.dispose();
  });

  it("lists tools without starting anything; turning a tool on in Settings lists it", async () => {
    const { host, spawned, prompts, stateWhere } = makeHost({ onCall: () => undefined });
    expect(await host.handleRequest(listRequest)).toMatchObject({
      _tag: "tools",
      servers: [
        { id: "computer-use", tools: [], error: expect.stringContaining("not known yet") },
        { id: "laptop-browser", tools: [], error: expect.stringContaining("not known yet") },
      ],
    });
    expect(spawned).toHaveLength(0);

    const listed = stateWhere((state) =>
      state.servers.every((server) => !server.enabled || server.toolCount !== null),
    );
    await host.setConfig(host.state().config);
    await listed;
    expect(spawned.map((entry) => entry.args[0])).toEqual(["mcp", "-y"]);
    expect(spawned[1]?.args).toContain("chrome-devtools-mcp@1.10.1");
    expect(prompts).toHaveLength(0);
    expect(await host.handleRequest(listRequest)).toMatchObject({
      _tag: "tools",
      servers: [
        { id: "computer-use", tools: [{ name: "screenshot" }] },
        { id: "laptop-browser", tools: [{ name: "screenshot" }] },
      ],
    });
    host.dispose();
  });

  it("asks again after the server's launch changed, even when it had stopped", async () => {
    const { host, prompts, advance } = makeHost({
      onCall: (_name, _args, reply) => reply({ content: [{ type: "text", text: "ok" }] }),
    });
    const browserCall = (requestId: string) =>
      callInput(requestId, { serverId: LaptopToolServerId.make("laptop-browser") });
    expect(await host.handleRequest(browserCall("r1"))).toMatchObject({ _tag: "result" });
    expect(prompts).toHaveLength(1);

    // The server idles out long before the grant would.
    advance(LAPTOP_TOOL_SERVER_IDLE_MS);
    host.sweep();
    expect(host.state().servers.find((server) => server.id === "laptop-browser")?.running).toBe(
      false,
    );
    expect(host.state().grants).toHaveLength(1);

    await host.setConfig({ ...host.state().config, laptopBrowserUsesRealProfile: true });
    expect(host.state().grants).toEqual([]);
    expect(await host.handleRequest(browserCall("r2"))).toMatchObject({ _tag: "result" });
    expect(prompts).toHaveLength(2);
    host.dispose();
  });

  it("needs sweeping only while a grant or a running server could expire", async () => {
    const { host, advance } = makeHost({
      onCall: (_name, _args, reply) => reply({ content: [{ type: "text", text: "ok" }] }),
    });
    expect(host.expiring()).toBe(false);
    expect(await host.handleRequest(callInput("r1"))).toMatchObject({ _tag: "result" });
    expect(host.expiring()).toBe(true);

    advance(LAPTOP_TOOL_SERVER_IDLE_MS);
    host.sweep();
    expect(host.state().servers.some((server) => server.running)).toBe(false);
    expect(host.expiring()).toBe(true);
    advance(LAPTOP_TOOL_GRANT_IDLE_MS);
    host.sweep();
    expect(host.state().grants).toEqual([]);
    expect(host.expiring()).toBe(false);
    host.dispose();

    // A refusal is read only by the next call, which sweeps it first.
    const denied = makeHost({ decide: "deny", onCall: () => undefined });
    expect(await denied.host.handleRequest(callInput("r1"))).toMatchObject({ code: "denied" });
    expect(denied.host.expiring()).toBe(false);
    denied.host.dispose();
  });
});
