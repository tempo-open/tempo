/**
 * The MCP servers every agent here gets beside `t3-code`: the HTTP servers in settings
 * (`mcpServers`). A settings change rewrites each live session's stored config: Claude picks it up
 * on its next turn, Codex only when its session restarts.
 */
import {
  type TempoMcpServerConfig,
  type ThreadId,
  tempoMcpServerProblem,
} from "@t3tools/contracts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { type McpExtraServer, withMcpExtraServers } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../serverSettings.ts";

export class TempoAgentMcpServers extends Context.Service<
  TempoAgentMcpServers,
  {
    /** The extra servers a session prepared now gets. Never fails: an unreadable source is skipped. */
    readonly current: Effect.Effect<ReadonlyArray<McpExtraServer>>;
    /** `current`, and keeps the thread's stored MCP config up to date after later changes. */
    readonly forThread: (threadId: ThreadId) => Effect.Effect<ReadonlyArray<McpExtraServer>>;
    /**
     * Rewrites the servers of every live session `forThread` saw. Runs on its
     * own after an MCP settings change.
     */
    readonly refreshSessions: Effect.Effect<void>;
  }
>()("t3/tempo/TempoAgentMcpServers") {}

/**
 * Each enabled, valid configured server, the first of any names that differ only in case. Header
 * values are sent as saved, so an empty one is dropped rather than sent blank.
 */
export function buildTempoAgentMcpServers(
  configured: ReadonlyArray<TempoMcpServerConfig>,
): ReadonlyArray<McpExtraServer> {
  const servers: Array<McpExtraServer> = [];
  const names = new Set<string>();
  for (const server of configured) {
    if (!server.enabled || tempoMcpServerProblem(server) !== null) continue;
    const key = server.name.toLowerCase();
    if (names.has(key)) continue;
    names.add(key);
    servers.push({
      name: server.name,
      url: server.url,
      headers: Object.fromEntries(
        server.headers
          .filter((header) => header.value !== "")
          .map((header) => [header.name, header.value] as const),
      ),
    });
  }
  return servers;
}

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const sessions = yield* McpProviderSessions.McpProviderSessions;
  const tracked = yield* Ref.make<ReadonlySet<ThreadId>>(new Set());

  const current: TempoAgentMcpServers["Service"]["current"] = settings.getSettings.pipe(
    Effect.map((value) => buildTempoAgentMcpServers(value.mcpServers)),
    Effect.catch((error) =>
      Effect.logWarning("Could not read MCP servers from settings", {
        operation: error.operation,
      }).pipe(Effect.as([])),
    ),
    Effect.withSpan("TempoAgentMcpServers.current"),
  );

  const forThread: TempoAgentMcpServers["Service"]["forThread"] = (threadId) =>
    Ref.update(tracked, (threads) => new Set(threads).add(threadId)).pipe(Effect.andThen(current));

  // In place, so a credential the session manager swaps in meanwhile is kept.
  // A released session (no stored config) drops out.
  const refreshSessions: TempoAgentMcpServers["Service"]["refreshSessions"] = Effect.gen(
    function* () {
      const threads = yield* Ref.get(tracked);
      if (threads.size === 0) return;
      const servers = yield* current;
      const released: Array<ThreadId> = [];
      for (const threadId of threads) {
        const live = yield* sessions.update(threadId, (session) =>
          withMcpExtraServers(session, servers),
        );
        if (!live) released.push(threadId);
      }
      if (released.length > 0) {
        yield* Ref.update(tracked, (threadsNow) => {
          const next = new Set(threadsNow);
          for (const threadId of released) next.delete(threadId);
          return next;
        });
      }
    },
  ).pipe(Effect.withSpan("TempoAgentMcpServers.refresh"));

  yield* settings.streamChanges.pipe(
    Stream.map((next) => JSON.stringify(next.mcpServers)),
    Stream.changes,
    Stream.runForEach(() => refreshSessions),
    Effect.forkScoped,
  );

  return TempoAgentMcpServers.of({ current, forThread, refreshSessions });
});

/** Needs McpProviderSessions and the server settings service. */
export const layer = Layer.effect(TempoAgentMcpServers, make);
