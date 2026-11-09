import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import {
  TEMPO_MCP_CONNECTORS_WS_METHODS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { connectionAtomRuntime } from "../../connection/runtime";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentServerConfigsAtom } from "../../state/server";

/** tempo: the MCP servers a thread's Claude has, or any running Claude's without a thread. */
export const mcpConnectorsList = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:tempo:mcp-connectors-list",
  tag: TEMPO_MCP_CONNECTORS_WS_METHODS.list,
});

/** tempo: runs `claude mcp login` on the environment and answers once it ends. */
export const mcpConnectorsSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:tempo:mcp-connectors-sign-in",
  tag: TEMPO_MCP_CONNECTORS_WS_METHODS.signIn,
});

export const mcpConnectorsCancelSignIn = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:tempo:mcp-connectors-cancel-sign-in",
  tag: TEMPO_MCP_CONNECTORS_WS_METHODS.cancelSignIn,
});

export const mcpConnectorsReconnect = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:tempo:mcp-connectors-reconnect",
  tag: TEMPO_MCP_CONNECTORS_WS_METHODS.reconnect,
});

export interface McpConnectorsRequest {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
}

export const useMcpConnectorsRequest = create<{ request: McpConnectorsRequest | null }>(() => ({
  request: null,
}));

export function openMcpConnectors(request: McpConnectorsRequest): void {
  useMcpConnectorsRequest.setState({ request });
}

export function closeMcpConnectors(): void {
  useMcpConnectorsRequest.setState({ request: null });
}

/** Whether the environment serves the connectors list (`tempo.mcpConnectors.*`). */
export function readEnvironmentServesMcpConnectors(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .tempoMcpConnectors === true
  );
}

/** `/mcp` alone: Claude's own command only prints a summary, so Tempo opens the list instead. */
export function isMcpConnectorsCommand(prompt: string): boolean {
  return /^\/mcp\s*$/i.test(prompt.trim());
}
