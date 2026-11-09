// @effect-diagnostics globalTimers:off -- Per-call deadlines live beside the child processes they bound.

import {
  LAPTOP_COMPUTER_USE_SERVER_ID,
  type DesktopLaptopToolServerConfig,
  type DesktopLaptopToolServerStatus,
  type DesktopLaptopToolsConfig,
  type DesktopLaptopToolsHandleInput,
  type DesktopLaptopToolsState,
  type EnvironmentId,
  type LaptopToolCallResult,
  type LaptopToolDescriptor,
  type LaptopToolServerTools,
  type LaptopToolsCallRequest,
  type LaptopToolsFailureCode,
  type LaptopToolsOutcome,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";

import {
  isBuiltInLaptopToolServer,
  laptopToolCommandProblem,
  laptopToolLaunch,
  laptopToolProcessEnv,
  normalizeLaptopToolsConfig,
  resolveLaptopToolCommand,
  type LaptopToolLaunch,
} from "./laptopToolConfig.ts";
import {
  LaptopToolGrants,
  type LaptopToolConsentDecision,
  type LaptopToolGrantsOptions,
} from "./laptopToolGrants.ts";
import { ownAppComputerUseRefusal, withoutOwnApps } from "@t3tools/shared/tempoComputerUse";
import {
  McpClientError,
  McpStdioClient,
  normalizeMcpToolContent,
  type SpawnMcpProcess,
} from "@t3tools/shared/mcpStdioClient";

/** Listing may start a server with `npx`, which downloads it the first time. */
const LIST_TIMEOUT_MS = 60_000;
/** A server nobody used for this long is stopped; the next request starts it again. */
export const LAPTOP_TOOL_SERVER_IDLE_MS = 10 * 60_000;
/**
 * The most a laptop sends back for one call, in characters of text and base64
 * image data. Below the environment's own limit so the laptop reports it first.
 */
export const LAPTOP_TOOL_RESULT_MAX_CHARS = 10 * 1024 * 1024;
const MAX_FAILURE_CHARS = 480;

/** The tools a server listed the last time it ran, as it launched then. */
export interface LaptopToolCatalogEntry {
  readonly launchKey: string;
  readonly tools: ReadonlyArray<LaptopToolDescriptor>;
  /** Why the last listing failed; `tools` then holds the list from before, if any. */
  readonly error?: string;
}

export type LaptopToolCatalog = Readonly<Record<string, LaptopToolCatalogEntry>>;

export interface LaptopToolsHostOptions {
  readonly hostLabel: string;
  readonly clientVersion: string;
  readonly platform: NodeJS.Platform;
  readonly browserProfileDir: string;
  readonly env: () => NodeJS.ProcessEnv;
  readonly isExecutableFile: (candidate: string) => boolean;
  readonly prompt: LaptopToolGrantsOptions["prompt"];
  readonly now: () => number;
  readonly onState: (state: DesktopLaptopToolsState) => void;
  readonly saveConfig: (config: DesktopLaptopToolsConfig) => Promise<void>;
  /** The tool lists agents see; saved so they survive a restart without starting anything. */
  readonly catalog?: LaptopToolCatalog;
  readonly saveCatalog?: (catalog: LaptopToolCatalog) => Promise<void>;
  readonly spawn?: SpawnMcpProcess;
}

interface RunningServer {
  readonly launchKey: string;
  readonly started: Promise<McpStdioClient>;
  lastUsedAt: number;
  inFlight: number;
}

const failure = (code: LaptopToolsFailureCode, message: string): LaptopToolsOutcome => ({
  _tag: "failure",
  code,
  message: message.length > MAX_FAILURE_CHARS ? `${message.slice(0, MAX_FAILURE_CHARS)}…` : message,
});

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stringify = (value: unknown): string => {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
};

/** Characters a result carries, compared with `LAPTOP_TOOL_RESULT_MAX_CHARS`. */
function laptopToolResultSize(result: LaptopToolCallResult): number {
  let size = 0;
  for (const block of result.content) {
    size += block.type === "text" ? block.text.length : block.data.length;
  }
  if (result.structuredContent !== undefined) size += stringify(result.structuredContent).length;
  return size;
}

const requestKey = (environmentId: EnvironmentId, requestId: string) =>
  `${environmentId}\u0000${requestId}`;

/** MCP tool names agents can address; longer ones are left out of the list. */
const MAX_TOOL_NAME_CHARS = 128;

/**
 * The desktop side of laptop tools. A server starts only when the person turns it on in Settings
 * (to list its tools) or allows a call, and stops when disabled, reconfigured, idle, or the app
 * quits. Listing tools for an agent never starts one: it answers from the last list.
 */
export class LaptopToolsHost {
  private config: DesktopLaptopToolsConfig;
  private readonly grants: LaptopToolGrants;
  private readonly servers = new Map<string, RunningServer>();
  private readonly requests = new Map<string, AbortController>();
  private readonly resolved = new Map<string, string | null>();
  private readonly catalog: Map<string, LaptopToolCatalogEntry>;
  private readonly listing = new Set<string>();
  private disposed = false;
  private readonly options: LaptopToolsHostOptions;

  constructor(options: LaptopToolsHostOptions, config: DesktopLaptopToolsConfig) {
    this.options = options;
    this.config = normalizeLaptopToolsConfig(config);
    this.catalog = new Map(Object.entries(options.catalog ?? {}));
    this.grants = new LaptopToolGrants({
      now: options.now,
      // With asking off, turning a tool on was the consent: a run's first call
      // is granted without a prompt, and Stop still refuses the rest of the run.
      prompt: (request, signal) =>
        this.config.askBeforeUse === true
          ? options.prompt(request, signal)
          : Promise.resolve<LaptopToolConsentDecision>("allow"),
      onChange: () => this.emit(),
    });
  }

  /** Current state; re-detects installed commands. */
  state(): DesktopLaptopToolsState {
    this.resolved.clear();
    return this.snapshot();
  }

  async setConfig(config: DesktopLaptopToolsConfig): Promise<DesktopLaptopToolsState> {
    const next = normalizeLaptopToolsConfig(config);
    await this.options.saveConfig(next);
    const previous = this.config;
    const before = new Map(
      previous.servers.map((server) => [server.id, this.enabledLaunchKey(server, previous)]),
    );
    this.config = next;
    this.resolved.clear();
    const after = new Map(
      next.servers.map((server) => [server.id, this.enabledLaunchKey(server, next)]),
    );
    // A server that was turned off, removed, or now launches differently
    // stops, and its grants end, running or not: consent covered the old launch.
    for (const serverId of new Set([...before.keys(), ...after.keys()])) {
      const launchKey = after.get(serverId) ?? null;
      if ((before.get(serverId) ?? null) === launchKey) continue;
      const running = this.servers.get(serverId);
      if (running !== undefined && running.launchKey !== launchKey) this.stopServer(serverId);
      this.grants.revokeServer(serverId);
      if (!after.has(serverId)) this.forgetCatalog(serverId);
    }
    // Grants made without asking end once the person wants to be asked.
    if (next.askBeforeUse === true && previous.askBeforeUse !== true) {
      for (const server of next.servers) this.grants.revokeServer(server.id);
    }
    // Turning a server on (or changing how it launches) is the person starting
    // it, so this is when it lists its tools for agents.
    for (const server of next.servers) {
      const launch = server.enabled ? this.launchFor(server, next) : null;
      if (launch === null) continue;
      const known = this.catalog.get(server.id)?.launchKey === this.launchKey(launch);
      if (!known || before.get(server.id) !== after.get(server.id))
        this.serverFor(server.id, launch);
    }
    this.emit();
    return this.snapshot();
  }

  async handleRequest(input: DesktopLaptopToolsHandleInput): Promise<LaptopToolsOutcome> {
    if (this.disposed) return failure("server-unavailable", "The desktop app is quitting.");
    const request = input.request;
    if (request._tag === "listTools") return { _tag: "tools", servers: this.listTools() };
    // tempo: other kinds (passkeys) are answered by DesktopLaptopTools before they reach here.
    if (request._tag !== "callTool") return failure("failed", "This desktop cannot answer that.");
    const key = requestKey(input.environmentId, input.requestId);
    const controller = new AbortController();
    this.requests.get(key)?.abort();
    this.requests.set(key, controller);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, request.timeoutMs);
    try {
      return await this.callTool(input, request, controller.signal, () => timedOut);
    } finally {
      clearTimeout(timer);
      if (this.requests.get(key) === controller) this.requests.delete(key);
    }
  }

  cancelRequest(environmentId: EnvironmentId, requestId: string): void {
    this.requests.get(requestKey(environmentId, requestId))?.abort();
  }

  stop(key?: string): void {
    this.grants.stop(key);
  }

  runChanged(environmentId: EnvironmentId, threadId: ThreadId, activeRunId: RunId | null): void {
    this.grants.runChanged(environmentId, threadId, activeRunId);
  }

  /**
   * Whether `sweep` could end anything. Refusals also age out, but only a call
   * reads them and it sweeps first, so they need no timer.
   */
  expiring(): boolean {
    return this.grants.size > 0 || this.servers.size > 0;
  }

  /** Expires idle grants and stops idle servers; run on a timer while `expiring`. */
  sweep(): void {
    this.grants.sweep();
    const now = this.options.now();
    for (const [serverId, running] of this.servers) {
      if (running.inFlight === 0 && now - running.lastUsedAt >= LAPTOP_TOOL_SERVER_IDLE_MS) {
        this.stopServer(serverId);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.grants.stop();
    for (const controller of this.requests.values()) controller.abort();
    for (const serverId of this.servers.keys()) this.stopServer(serverId);
  }

  /** Each enabled server's tools as it last listed them; starts nothing. */
  private listTools(): LaptopToolServerTools[] {
    return this.config.servers
      .filter((server) => server.enabled)
      .map((server): LaptopToolServerTools => {
        const launch = this.launchFor(server);
        if (launch === null) {
          return { id: server.id, name: server.name, tools: [], error: this.missingReason(server) };
        }
        const entry = this.catalog.get(server.id);
        if (entry !== undefined && entry.launchKey === this.launchKey(launch)) {
          return {
            id: server.id,
            name: server.name,
            tools: entry.tools,
            ...(entry.error === undefined ? {} : { error: entry.error }),
          };
        }
        return {
          id: server.id,
          name: server.name,
          tools: [],
          error: this.listing.has(server.id)
            ? "Its tools are being listed on the laptop; try again in a minute."
            : `Its tools are not known yet. Ask the user to turn ${server.name} off and on in Settings → Laptop tools on ${this.options.hostLabel}.`,
        };
      });
  }

  private async callTool(
    input: DesktopLaptopToolsHandleInput,
    request: LaptopToolsCallRequest,
    signal: AbortSignal,
    timedOut: () => boolean,
  ): Promise<LaptopToolsOutcome> {
    const server = this.config.servers.find((candidate) => candidate.id === request.serverId);
    if (server === undefined || !server.enabled) {
      return failure("server-not-found", `${request.serverId} is not turned on on this laptop.`);
    }
    const launch = this.launchFor(server);
    if (launch === null) return failure("server-unavailable", this.missingReason(server));
    const computerUse = server.id === LAPTOP_COMPUTER_USE_SERVER_ID;
    // Refused before the person is asked: allowing it would not let it run.
    const refusal = computerUse ? ownAppComputerUseRefusal(request.arguments) : undefined;
    if (refusal !== undefined) return failure("failed", refusal);
    const grant = await this.grants.acquire(
      {
        environmentId: input.environmentId,
        environmentLabel: input.environmentLabel,
        threadId: request.threadId,
        threadTitle: request.threadTitle,
        runId: request.runId,
        serverId: server.id,
        serverName: server.name,
        launchKey: this.launchKey(launch),
      },
      signal,
    );
    if (!grant.allowed) {
      if (grant.reason === "denied") {
        return failure("denied", "The person did not allow this tool for this run.");
      }
      return timedOut()
        ? failure("timeout", "Nobody answered the permission prompt in time.")
        : failure("cancelled", "The call was cancelled.");
    }
    // Started only after consent, so a denied tool never runs.
    const running = this.serverFor(server.id, launch);
    running.inFlight += 1;
    try {
      const mcp = await running.started;
      const remaining = Math.max(1_000, request.timeoutMs);
      const raw = await mcp.callTool(request.tool, request.arguments, {
        timeoutMs: remaining,
        signal: grant.signal,
      });
      const returned: LaptopToolCallResult = {
        content: normalizeMcpToolContent(raw.content),
        ...(raw.isError === undefined ? {} : { isError: raw.isError }),
        ...(raw.structuredContent === undefined
          ? {}
          : { structuredContent: raw.structuredContent }),
      };
      const result = computerUse ? withoutOwnApps(request.tool, returned) : returned;
      if (laptopToolResultSize(result) > LAPTOP_TOOL_RESULT_MAX_CHARS) {
        return failure("too-large", "The tool returned more than the laptop sends back.");
      }
      return { _tag: "result", result };
    } catch (error) {
      if (signal.aborted) {
        return timedOut()
          ? failure("timeout", `${server.name} did not finish in time.`)
          : failure("cancelled", "The call was cancelled.");
      }
      if (grant.signal.aborted) {
        return failure("denied", "The person stopped this tool.");
      }
      if (error instanceof McpClientError) {
        switch (error.kind) {
          case "timeout":
            return failure("timeout", error.message);
          case "too-large":
            return failure("too-large", error.message);
          case "remote":
          case "protocol":
            return failure("failed", error.message);
          default:
            return failure("server-unavailable", error.message);
        }
      }
      return failure("failed", errorMessage(error));
    } finally {
      grant.release();
      running.inFlight -= 1;
      running.lastUsedAt = this.options.now();
    }
  }

  private serverFor(serverId: string, launch: LaptopToolLaunch): RunningServer {
    const launchKey = this.launchKey(launch);
    const existing = this.servers.get(serverId);
    if (existing !== undefined && existing.launchKey === launchKey) return existing;
    if (existing !== undefined) this.stopServer(serverId);
    const started = McpStdioClient.start({
      command: launch.command,
      args: launch.args,
      env: laptopToolProcessEnv(this.options.env()),
      clientVersion: this.options.clientVersion,
      ...(this.options.spawn === undefined ? {} : { spawn: this.options.spawn }),
    });
    const running: RunningServer = {
      launchKey,
      started,
      lastUsedAt: this.options.now(),
      inFlight: 0,
    };
    this.servers.set(serverId, running);
    // Every start is one the person made (Settings or an allowed call), so it
    // is when the list agents see is refreshed.
    this.refreshCatalog(serverId, running);
    started.then(
      (mcp) => {
        if (this.servers.get(serverId) !== running) {
          mcp.close();
          return;
        }
        mcp.onExit(() => {
          if (this.servers.get(serverId) === running) {
            this.servers.delete(serverId);
            this.emit();
          }
        });
        this.emit();
      },
      () => {
        if (this.servers.get(serverId) === running) {
          this.servers.delete(serverId);
          this.emit();
        }
      },
    );
    return running;
  }

  private refreshCatalog(serverId: string, running: RunningServer): void {
    this.listing.add(serverId);
    running.inFlight += 1;
    const previous = this.catalog.get(serverId);
    running.started
      .then((mcp) => mcp.listTools({ timeoutMs: LIST_TIMEOUT_MS }))
      .then(
        (tools): LaptopToolCatalogEntry => ({
          launchKey: running.launchKey,
          tools: tools.filter((tool) => tool.name.length <= MAX_TOOL_NAME_CHARS),
        }),
        (error: unknown): LaptopToolCatalogEntry => ({
          launchKey: running.launchKey,
          tools: previous?.launchKey === running.launchKey ? previous.tools : [],
          error: `Could not list its tools: ${errorMessage(error)}`.slice(0, MAX_FAILURE_CHARS),
        }),
      )
      .then((entry) => {
        running.inFlight -= 1;
        running.lastUsedAt = this.options.now();
        this.listing.delete(serverId);
        if (this.disposed) return;
        // Only a server that still launches this way may say what it offers.
        const server = this.config.servers.find((candidate) => candidate.id === serverId);
        if (
          server !== undefined &&
          this.enabledLaunchKey(server, this.config) === entry.launchKey
        ) {
          this.catalog.set(serverId, entry);
          this.saveCatalog();
        }
        this.emit();
      });
  }

  private forgetCatalog(serverId: string): void {
    if (this.catalog.delete(serverId)) this.saveCatalog();
  }

  private saveCatalog(): void {
    void this.options.saveCatalog?.(Object.fromEntries(this.catalog)).catch(() => undefined);
  }

  private stopServer(serverId: string): void {
    const running = this.servers.get(serverId);
    if (running === undefined) return;
    this.servers.delete(serverId);
    running.started.then(
      (mcp) => mcp.close(),
      () => undefined,
    );
    this.emit();
  }

  private launchKey(launch: LaptopToolLaunch): string {
    return JSON.stringify([launch.command, launch.args]);
  }

  private resolve(command: string): string | null {
    const cached = this.resolved.get(command);
    if (cached !== undefined) return cached;
    const env = this.options.env();
    const value = resolveLaptopToolCommand(command, {
      platform: this.options.platform,
      pathValue: env.PATH ?? env.Path,
      pathExt: env.PATHEXT,
      isExecutableFile: this.options.isExecutableFile,
    });
    this.resolved.set(command, value);
    return value;
  }

  private launchFor(
    server: DesktopLaptopToolServerConfig,
    config: DesktopLaptopToolsConfig = this.config,
  ): LaptopToolLaunch | null {
    if (laptopToolCommandProblem(server.command, this.options.platform) !== undefined) return null;
    const resolved = this.resolve(server.command);
    if (resolved === null) return null;
    return laptopToolLaunch(server, resolved, {
      usesRealBrowserProfile: config.laptopBrowserUsesRealProfile,
      browserProfileDir: this.options.browserProfileDir,
    });
  }

  /** How an enabled server launches under `config`, or null when it is off or cannot. */
  private enabledLaunchKey(
    server: DesktopLaptopToolServerConfig,
    config: DesktopLaptopToolsConfig,
  ): string | null {
    if (!server.enabled) return null;
    const launch = this.launchFor(server, config);
    return launch === null ? null : this.launchKey(launch);
  }

  private missingReason(server: DesktopLaptopToolServerConfig): string {
    return (
      laptopToolCommandProblem(server.command, this.options.platform) ??
      `${server.command} is not installed on this laptop, or is not on its PATH.`
    );
  }

  private snapshot(): DesktopLaptopToolsState {
    const servers: DesktopLaptopToolServerStatus[] = this.config.servers.map((server) => {
      const invalidReason = laptopToolCommandProblem(server.command, this.options.platform);
      const launch = invalidReason === undefined ? this.launchFor(server) : null;
      const entry = this.catalog.get(server.id);
      const listed =
        launch !== null && entry?.launchKey === this.launchKey(launch) ? entry : undefined;
      return {
        id: server.id,
        name: server.name,
        enabled: server.enabled,
        builtIn: isBuiltInLaptopToolServer(server.id),
        resolvedCommand: invalidReason === undefined ? this.resolve(server.command) : null,
        ...(invalidReason === undefined ? {} : { invalidReason }),
        running: this.servers.has(server.id),
        toolCount: listed === undefined || this.listing.has(server.id) ? null : listed.tools.length,
        ...(listed?.error === undefined ? {} : { listError: listed.error }),
      };
    });
    return {
      hostLabel: this.options.hostLabel,
      config: this.config,
      servers,
      grants: this.grants.list(),
    };
  }

  private emit(): void {
    if (!this.disposed) this.options.onState(this.snapshot());
  }
}
