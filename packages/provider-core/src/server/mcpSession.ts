import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /**
   * tempo: HTTP MCP servers the agent gets beside `t3-code`: the environment's
   * configured servers. Headers carry credentials, so adapters
   * pass them the way they pass `authorizationHeader`, never on a command line.
   */
  readonly extraServers?: ReadonlyArray<McpExtraServer>;
}

/** tempo: an extra HTTP MCP server. `name` is never `t3-code`. */
export interface McpExtraServer {
  readonly name: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
}

/** tempo: `config` carrying exactly `extraServers`; an empty list leaves the field off. */
export function withMcpExtraServers(
  config: McpProviderSessionConfig,
  extraServers: ReadonlyArray<McpExtraServer>,
): McpProviderSessionConfig {
  const { extraServers: _previous, ...rest } = config;
  return extraServers.length === 0 ? rest : { ...rest, extraServers };
}

/** tempo: the extra servers keyed by name, minus any that would replace one of `reserved`. */
export function mcpExtraServerEntries(
  config: Pick<McpProviderSessionConfig, "extraServers"> | undefined,
  reserved: ReadonlyArray<string> = ["t3-code"],
): ReadonlyArray<McpExtraServer> {
  return (config?.extraServers ?? []).filter((server) => !reserved.includes(server.name));
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
