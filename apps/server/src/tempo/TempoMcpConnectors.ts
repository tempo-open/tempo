/**
 * tempo: each running Claude's MCP servers, and `claude mcp login` (in a PTY: it needs a terminal) run
 * in the folder that Claude runs in. Claude Code keeps the token; Claudes lacking the server reconnect.
 */
import {
  ClaudeSettings,
  type TempoMcpConnector,
  TempoMcpConnectorsError,
  type TempoMcpConnectorsFailure,
  type TempoMcpConnectorsList,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { makeClaudeEnvironment } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { InstructionProviderInstances } from "./InstructionRoots.ts";
import { sanitizeProviderEnvironment } from "./ProviderPolicy.ts";

const SIGN_IN_TIMEOUT = "10 minutes";
const MAX_OUTPUT_CHARS = 16 * 1024;
const NEEDS_AUTH_RETRY_WAITS = ["5 seconds", "10 seconds"] as const;
const CLAUDE_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

/** Servers that need something from the person come first. */
const STATUS_ORDER: Readonly<Record<TempoMcpConnector["status"], number>> = {
  "needs-auth": 0,
  failed: 1,
  pending: 2,
  connected: 3,
  disabled: 4,
};

export class TempoMcpConnectors extends Context.Service<
  TempoMcpConnectors,
  {
    /** The thread's own Claude when it runs, else any running Claude on this Mac. */
    readonly list: (
      threadId: ThreadId | null,
    ) => Effect.Effect<TempoMcpConnectorsList, TempoMcpConnectorsError>;
    /** Runs `claude mcp login` and answers once it ends, with the list after reconnecting. */
    readonly signIn: (
      threadId: ThreadId | null,
      name: string,
    ) => Effect.Effect<TempoMcpConnectorsList, TempoMcpConnectorsError>;
    readonly cancelSignIn: Effect.Effect<void>;
    /** Connects the server again in every running Claude where it is not connected. */
    readonly reconnect: (
      threadId: ThreadId | null,
      name: string,
    ) => Effect.Effect<TempoMcpConnectorsList, TempoMcpConnectorsError>;
  }
>()("t3/tempo/TempoMcpConnectors") {}

type ServersRuntime = ProviderAdapter.ProviderAdapterV2SessionRuntime & {
  readonly mcpServers: ProviderAdapter.ProviderAdapterV2McpServers;
};

const hasServers = (
  runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
): runtime is ServersRuntime => runtime.mcpServers !== undefined;

const failure = (reason: TempoMcpConnectorsFailure, detail?: string, cause?: unknown) =>
  new TempoMcpConnectorsError({
    reason,
    ...(detail === undefined ? {} : { detail }),
    ...(cause === undefined ? {} : { cause }),
  });

/** Terminal output as plain lines: no colors, cursor moves or link markers. */
function plainTerminalLines(output: string): ReadonlyArray<string> {
  return output
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .split(/\r?\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

/** Claude Code's last words when `claude mcp login` fails, without its prompts. */
function signInFailureDetail(output: string): string | undefined {
  const lines = plainTerminalLines(output).filter(
    (line) => !/^(Waiting for authorization|Or paste the redirect URL|If the browser)/.test(line),
  );
  const last = lines.at(-1);
  return last === undefined ? undefined : last.slice(0, 300);
}

/** The connectors view of a running Claude's servers; the host's own in-process servers stay out. */
export function connectorsView(
  servers: ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer>,
): ReadonlyArray<TempoMcpConnector> {
  return servers
    .filter((server) => server.source !== "sdk")
    .map((server): TempoMcpConnector => ({
      name: server.name,
      status: server.status,
      url: server.url ?? null,
      toolCount: server.toolCount,
      error: server.error ?? null,
    }))
    .toSorted(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.name.localeCompare(b.name),
    );
}

const make = Effect.gen(function* () {
  const pty = yield* PtyAdapter.PtyAdapter;
  const providerSessions = yield* ProviderSessionManager.ProviderSessionManagerV2;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const settings = yield* ServerSettingsService;
  const providerInstances = yield* InstructionProviderInstances;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;

  let signIn: { readonly name: string; readonly cancel: Deferred.Deferred<void> } | null = null;

  /** The thread's own sessions first, then every other running one. */
  const runtimesFor = Effect.fn("TempoMcpConnectors.runtimesFor")(function* (
    threadId: ThreadId | null,
  ) {
    const live = (yield* providerSessions.liveRuntimes).filter(hasServers);
    if (threadId === null) return live;
    const own = yield* threadManagement.getThreadRecords(threadId, ["providerThreads"]).pipe(
      Effect.map(
        (records) =>
          new Set<string>(
            records.providerThreads.flatMap((providerThread) =>
              providerThread.providerSessionId == null ? [] : [providerThread.providerSessionId],
            ),
          ),
      ),
      Effect.orElseSucceed(() => new Set<string>()),
    );
    return [
      ...live.filter((runtime) => own.has(runtime.providerSessionId)),
      ...live.filter((runtime) => !own.has(runtime.providerSessionId)),
    ];
  });

  /** The first of `runtimes` with a running process, and what it reports. */
  const firstListing = Effect.fn("TempoMcpConnectors.firstListing")(function* (
    runtimes: ReadonlyArray<ServersRuntime>,
  ) {
    for (const runtime of runtimes) {
      const servers = yield* runtime.mcpServers.list.pipe(
        Effect.catch((error) =>
          Effect.logWarning("A running Claude did not report its MCP servers", {
            providerSessionId: runtime.providerSessionId,
            error: error._tag,
          }).pipe(
            Effect.as(Option.none<ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer>>()),
          ),
        ),
      );
      if (Option.isSome(servers)) return Option.some({ runtime, servers: servers.value });
    }
    return Option.none<{
      readonly runtime: ServersRuntime;
      readonly servers: ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer>;
    }>();
  });

  const list: TempoMcpConnectors["Service"]["list"] = Effect.fn("TempoMcpConnectors.list")(
    function* (threadId) {
      const listing = yield* firstListing(yield* runtimesFor(threadId));
      return {
        connectors: Option.match(listing, {
          onNone: () => [],
          onSome: ({ servers }) => connectorsView(servers),
        }),
        live: Option.isSome(listing),
        signingIn: signIn?.name ?? null,
      };
    },
  );

  /** Reconnects `name` wherever a running Claude has it but not connected. */
  const reconnectEverywhere = Effect.fn("TempoMcpConnectors.reconnectEverywhere")(function* (
    name: string,
  ) {
    const runtimes = (yield* providerSessions.liveRuntimes).filter(hasServers);
    yield* Effect.forEach(
      runtimes,
      (runtime) =>
        Effect.gen(function* () {
          const statusOf = runtime.mcpServers.list.pipe(
            Effect.map(
              (servers) =>
                Option.getOrUndefined(servers)?.find((entry) => entry.name === name)?.status,
            ),
          );
          const status = yield* statusOf;
          if (status === undefined || status === "connected" || status === "disabled") return;
          yield* runtime.mcpServers.reconnect(name).pipe(Effect.ignore);
          // A token saved moments ago can take a few seconds to reach a running Claude.
          for (const wait of NEEDS_AUTH_RETRY_WAITS) {
            if ((yield* statusOf) !== "needs-auth") return;
            yield* Effect.sleep(wait);
            yield* runtime.mcpServers.reconnect(name).pipe(Effect.ignore);
          }
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not reconnect an MCP server in a running Claude", {
              providerSessionId: runtime.providerSessionId,
              server: name,
              error: error._tag,
            }),
          ),
        ),
      { concurrency: 4, discard: true },
    );
  });

  /** The Claude binary and environment the instance launches with, so the token lands in its home. */
  const claudeLaunch = Effect.fn("TempoMcpConnectors.claudeLaunch")(function* (
    instanceId: ProviderInstanceId,
  ) {
    const serverSettings = yield* settings.getSettings.pipe(Effect.option);
    const configMap = Option.isSome(serverSettings)
      ? yield* providerInstances.configMap(serverSettings.value)
      : {};
    const claudeSettings = decodeClaudeSettings(
      configMap[instanceId]?.config ?? configMap[CLAUDE_DEFAULT_INSTANCE_ID]?.config ?? {},
    );
    const homePath = Option.isSome(claudeSettings) ? claudeSettings.value.homePath : "";
    const binaryPath = Option.isSome(claudeSettings) ? claudeSettings.value.binaryPath.trim() : "";
    const environment = yield* makeClaudeEnvironment(
      { homePath },
      sanitizeProviderEnvironment(yield* HostProcess.Environment),
    ).pipe(Effect.provideService(Path.Path, path));
    return {
      binary:
        binaryPath === "" ? "claude" : expandHomePath(binaryPath, yield* HostProcess.HomeDirectory),
      environment: { ...environment, TERM: "xterm-256color" },
    };
  });

  const runLogin = Effect.fn("TempoMcpConnectors.runLogin")(function* (input: {
    readonly name: string;
    readonly cwd: string;
    readonly instanceId: ProviderInstanceId;
    readonly cancel: Deferred.Deferred<void>;
  }) {
    const launch = yield* claudeLaunch(input.instanceId);
    const terminal = yield* pty
      .spawn({
        shell: launch.binary,
        args: ["mcp", "login", input.name],
        cwd: input.cwd,
        cols: 200,
        rows: 40,
        env: launch.environment,
      })
      .pipe(Effect.mapError((cause) => failure("not-installed", undefined, cause)));
    const exits = yield* Queue.unbounded<number>();
    let output = "";
    const stopData = terminal.onData((chunk) => {
      output = (output + chunk).slice(-MAX_OUTPUT_CHARS);
    });
    const stopExit = terminal.onExit((event) => void Queue.offerUnsafe(exits, event.exitCode));
    const exitCode = yield* Queue.take(exits).pipe(
      Effect.raceFirst(
        Deferred.await(input.cancel).pipe(Effect.andThen(Effect.fail(failure("cancelled")))),
      ),
      Effect.timeoutOrElse({
        duration: SIGN_IN_TIMEOUT,
        orElse: () => Effect.fail(failure("timed-out")),
      }),
      Effect.ensuring(
        Effect.sync(() => {
          stopData();
          stopExit();
          terminal.kill();
        }),
      ),
    );
    if (exitCode !== 0) {
      return yield* failure("sign-in-failed", signInFailureDetail(output));
    }
  });

  const signInTo: TempoMcpConnectors["Service"]["signIn"] = Effect.fn("TempoMcpConnectors.signIn")(
    function* (threadId, name) {
      if (signIn !== null) return yield* failure("already-signing-in");
      const cancel = yield* Deferred.make<void>();
      signIn = { name, cancel };
      return yield* Effect.gen(function* () {
        // Run where a Claude that has this server runs, so its project scope resolves.
        const listing = yield* firstListing(yield* runtimesFor(threadId));
        const runtime = Option.getOrUndefined(listing)?.runtime;
        yield* runLogin({
          name,
          cwd: runtime?.providerSession.cwd ?? stateDir,
          instanceId: runtime?.instanceId ?? CLAUDE_DEFAULT_INSTANCE_ID,
          cancel,
        });
        yield* reconnectEverywhere(name);
        signIn = null;
        return yield* list(threadId);
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            signIn = null;
          }),
        ),
      );
    },
  );

  const reconnect: TempoMcpConnectors["Service"]["reconnect"] = Effect.fn(
    "TempoMcpConnectors.reconnect",
  )(function* (threadId, name) {
    yield* reconnectEverywhere(name);
    return yield* list(threadId);
  });

  return TempoMcpConnectors.of({
    list,
    signIn: signInTo,
    cancelSignIn: Effect.suspend(() =>
      signIn === null
        ? Effect.void
        : Deferred.succeed(signIn.cancel, undefined).pipe(Effect.asVoid),
    ),
    reconnect,
  });
});

export const layer = Layer.effect(TempoMcpConnectors, make);
