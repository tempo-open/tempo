// @effect-diagnostics globalTimers:off -- Request timeouts run at child-process callback boundaries outside Effect fibers.
// @effect-diagnostics nodeBuiltinImport:off -- tempo laptop tools (desktop) and host computer use (server) own stdio MCP child processes.

import * as NodeChildProcess from "node:child_process";

/**
 * A minimal MCP client over stdio (newline-delimited JSON-RPC), enough to
 * list and call the tools of a local MCP server for tempo laptop tools and host
 * computer use. It never runs a shell: the command and its arguments go
 * straight to `spawn`.
 */

const MCP_PROTOCOL_VERSION = "2025-06-18";
/** `npx` downloads a server the first time, so starting may take a while. */
const MCP_START_TIMEOUT_MS = 90_000;
/** One JSON-RPC message larger than this ends the connection. */
const MCP_MAX_MESSAGE_CHARS = 48 * 1024 * 1024;
const STDERR_TAIL_CHARS = 2_000;

export interface McpToolDescriptor {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface McpCallToolResult {
  readonly content: ReadonlyArray<Readonly<Record<string, unknown>>>;
  readonly isError?: boolean;
  readonly structuredContent?: unknown;
}

/** A content block an agent receives unchanged: text, or an image as base64. */
export type McpAgentContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/**
 * MCP content blocks as an agent receives them: text and images pass
 * through; anything else becomes a text block that says what it was.
 */
export function normalizeMcpToolContent(
  blocks: McpCallToolResult["content"],
): Array<McpAgentContent> {
  return blocks.map((block): McpAgentContent => {
    if (block.type === "text" && typeof block.text === "string") {
      return { type: "text", text: block.text };
    }
    if (
      block.type === "image" &&
      typeof block.data === "string" &&
      typeof block.mimeType === "string"
    ) {
      return { type: "image", data: block.data, mimeType: block.mimeType.slice(0, 100) };
    }
    if (block.type === "resource" && typeof block.resource === "object" && block.resource) {
      const resource = block.resource as Record<string, unknown>;
      if (typeof resource.text === "string") return { type: "text", text: resource.text };
      return { type: "text", text: `[Resource ${String(resource.uri ?? "")} omitted]` };
    }
    if (block.type === "resource_link") {
      return { type: "text", text: `[Resource link ${String(block.uri ?? block.name ?? "")}]` };
    }
    return { type: "text", text: `[${String(block.type ?? "Unknown")} content omitted]` };
  });
}

/** The part of a child process the client uses; tests pass a fake. */
export interface McpChildProcess {
  readonly stdin: NodeJS.WritableStream | null;
  readonly stdout: NodeJS.ReadableStream | null;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "exit", listener: (code: number | null, signal: string | null) => void): unknown;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export type SpawnMcpProcess = (
  command: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) => McpChildProcess;

const spawnMcpProcess: SpawnMcpProcess = (command, args, env) =>
  NodeChildProcess.spawn(command, [...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

export type McpClientErrorKind =
  | "start"
  | "closed"
  | "timeout"
  | "aborted"
  | "protocol"
  | "too-large"
  | "remote";

export class McpClientError extends Error {
  readonly kind: McpClientErrorKind;

  constructor(message: string, kind: McpClientErrorKind) {
    super(message);
    this.name = "McpClientError";
    this.kind = kind;
  }
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: McpClientError) => void;
}

interface JsonRpcMessage {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: unknown; readonly message?: unknown };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export interface McpStdioClientOptions {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
  readonly clientVersion: string;
  readonly spawn?: SpawnMcpProcess;
  readonly startTimeoutMs?: number;
}

export class McpStdioClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly exitListeners = new Set<(reason: string) => void>();
  private nextId = 1;
  private buffer = "";
  private stderrTail = "";
  private closedReason: string | null = null;
  private readonly child: McpChildProcess;

  private constructor(child: McpChildProcess) {
    this.child = child;
    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.onData(chunk.toString()));
    child.stderr?.on("data", (chunk: string | Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin?.on("error", () => this.shutdown("The tool server closed its input."));
    child.once("error", (error) => this.shutdown(`Could not start: ${error.message}`));
    child.once("exit", (code, signal) =>
      this.shutdown(
        signal !== null
          ? `The tool server stopped (${signal}).`
          : `The tool server exited (${code}).`,
      ),
    );
  }

  /** Starts the server and completes the MCP handshake. */
  static async start(options: McpStdioClientOptions): Promise<McpStdioClient> {
    const spawn = options.spawn ?? spawnMcpProcess;
    let child: McpChildProcess;
    try {
      child = spawn(options.command, options.args, options.env);
    } catch (cause) {
      throw new McpClientError(
        `Could not start ${options.command}: ${cause instanceof Error ? cause.message : String(cause)}`,
        "start",
      );
    }
    const client = new McpStdioClient(child);
    try {
      await client.request(
        "initialize",
        {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "tempo-laptop-tools", version: options.clientVersion },
        },
        { timeoutMs: options.startTimeoutMs ?? MCP_START_TIMEOUT_MS },
      );
      client.notify("notifications/initialized", {});
      return client;
    } catch (error) {
      client.close();
      const reason = error instanceof McpClientError ? error.message : String(error);
      throw new McpClientError(client.describeFailure(reason), "start");
    }
  }

  get closed(): boolean {
    return this.closedReason !== null;
  }

  /** Runs once when the server exits or the connection breaks. */
  onExit(listener: (reason: string) => void): () => void {
    if (this.closedReason !== null) {
      listener(this.closedReason);
      return () => undefined;
    }
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  async listTools(options: { readonly timeoutMs: number }): Promise<McpToolDescriptor[]> {
    const tools: McpToolDescriptor[] = [];
    let cursor: string | undefined;
    // A misbehaving server cannot page forever.
    for (let page = 0; page < 50; page += 1) {
      const result = await this.request(
        "tools/list",
        cursor === undefined ? {} : { cursor },
        options,
      );
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new McpClientError("The tool server sent an invalid tool list.", "protocol");
      }
      for (const tool of result.tools) {
        if (!isRecord(tool) || typeof tool.name !== "string") continue;
        tools.push({
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
        });
      }
      cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
      if (cursor === undefined) break;
    }
    return tools;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<McpCallToolResult> {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    if (!isRecord(result) || !Array.isArray(result.content)) {
      throw new McpClientError("The tool server sent an invalid tool result.", "protocol");
    }
    return {
      content: result.content.filter(isRecord),
      ...(typeof result.isError === "boolean" ? { isError: result.isError } : {}),
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
  }

  close(): void {
    if (this.closedReason === null) this.shutdown("The tool server was stopped.");
    try {
      this.child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }

  private describeFailure(reason: string): string {
    const stderr = this.stderrTail.trim();
    return stderr.length === 0 ? reason : `${reason} ${stderr.split("\n").slice(-3).join(" ")}`;
  }

  private request(
    method: string,
    params: unknown,
    options: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<unknown> {
    if (this.closedReason !== null) {
      return Promise.reject(new McpClientError(this.closedReason, "closed"));
    }
    if (options.signal?.aborted) {
      return Promise.reject(new McpClientError("The call was cancelled.", "aborted"));
    }
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: "Timed out." });
        reject(new McpClientError(`${method} did not finish in time.`, "timeout"));
      }, options.timeoutMs);
      const onAbort = () => {
        cleanup();
        this.notify("notifications/cancelled", { requestId: id, reason: "Cancelled." });
        reject(new McpClientError("The call was cancelled.", "aborted"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, {
        resolve: (value) => {
          cleanup();
          resolve(value);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closedReason === null) this.write({ jsonrpc: "2.0", method, params });
  }

  private write(message: unknown): void {
    try {
      this.child.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch {
      this.shutdown("Could not write to the tool server.");
    }
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.buffer.indexOf("\n");
    }
    if (this.buffer.length > MCP_MAX_MESSAGE_CHARS) {
      this.buffer = "";
      this.failPending(
        new McpClientError("The tool server sent more than the laptop accepts.", "too-large"),
      );
      this.close();
    }
  }

  private onLine(line: string): void {
    let message: JsonRpcMessage;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) return;
      message = parsed;
    } catch {
      // Servers that log to stdout break the protocol; skip the line.
      return;
    }
    if (typeof message.method === "string") {
      // A request from the server. Answer the ones we must; ignore notifications.
      if (message.id === undefined) return;
      if (message.method === "ping") {
        this.write({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      this.write({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: `${message.method} is not supported by this client.` },
      });
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (pending === undefined) return;
    if (message.error !== undefined) {
      const text =
        typeof message.error?.message === "string" ? message.error.message : "Unknown error.";
      pending.reject(new McpClientError(text, "remote"));
      return;
    }
    pending.resolve(message.result);
  }

  private failPending(error: McpClientError): void {
    for (const pending of this.pending.values()) pending.reject(error);
  }

  private shutdown(reason: string): void {
    if (this.closedReason !== null) return;
    this.closedReason = this.describeFailure(reason);
    this.failPending(new McpClientError(this.closedReason, "closed"));
    for (const listener of this.exitListeners) listener(this.closedReason);
    this.exitListeners.clear();
  }
}
