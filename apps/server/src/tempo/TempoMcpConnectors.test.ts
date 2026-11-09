import * as NodePath from "@effect/platform-node/NodePath";
import { assert, describe, it } from "@effect/vitest";
import { TempoMcpConnectorsError, ProviderInstanceId, ProviderSessionId } from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as TempoMcpConnectors from "./TempoMcpConnectors.ts";
import { InstructionProviderInstances } from "./InstructionRoots.ts";

const server = (
  name: string,
  status: ProviderAdapter.ProviderAdapterV2McpServer["status"],
  source = "user",
): ProviderAdapter.ProviderAdapterV2McpServer => ({ name, status, source, toolCount: 0 });

/** Running Claudes with these servers, and a terminal the test drives for `claude mcp login`. */
const makeWorld = (
  sessions: ReadonlyArray<{
    readonly id: string;
    readonly cwd: string;
    readonly servers: ReadonlyArray<ProviderAdapter.ProviderAdapterV2McpServer>;
  }>,
) => {
  let started = Deferred.makeUnsafe<void>();
  const spawned: Array<PtyAdapter.PtySpawnInput> = [];
  const reconnected: Array<string> = [];
  let onData: ((data: string) => void) | undefined;
  let onExit: ((event: PtyAdapter.PtyExitEvent) => void) | undefined;
  const listed = new Map(sessions.map((session) => [session.id, session.servers]));
  const runtimes = sessions.map(
    (session) =>
      ({
        providerSessionId: ProviderSessionId.make(session.id),
        instanceId: ProviderInstanceId.make("claudeAgent"),
        providerSession: { cwd: session.cwd },
        mcpServers: {
          list: Effect.sync(() => Option.some(listed.get(session.id) ?? [])),
          reconnect: (name: string) =>
            Effect.sync(() => {
              reconnected.push(`${session.id}:${name}`);
              listed.set(
                session.id,
                (listed.get(session.id) ?? []).map((entry) =>
                  entry.name === name ? { ...entry, status: "connected" as const } : entry,
                ),
              );
            }),
        },
      }) as unknown as ProviderAdapter.ProviderAdapterV2SessionRuntime,
  );
  const layer = TempoMcpConnectors.layer.pipe(
    Layer.provide(
      Layer.succeed(
        PtyAdapter.PtyAdapter,
        PtyAdapter.PtyAdapter.of({
          spawn: (input) =>
            Effect.sync(() => {
              spawned.push(input);
              const terminal: PtyAdapter.PtyProcess = {
                pid: 4242,
                write: () => {},
                resize: () => {},
                kill: () => {},
                onData: (callback) => {
                  onData = callback;
                  return () => {};
                },
                onExit: (callback) => {
                  onExit = callback;
                  // The service's last step with a new terminal.
                  queueMicrotask(() => Deferred.doneUnsafe(started, Effect.void));
                  return () => {};
                },
              };
              return terminal;
            }),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(ProviderSessionManager.ProviderSessionManagerV2, {
        liveRuntimes: Effect.succeed(runtimes),
      } as unknown as ProviderSessionManager.ProviderSessionManagerV2["Service"]),
    ),
    Layer.provide(
      Layer.succeed(
        ThreadManagementService.ThreadManagementService,
        {} as ThreadManagementService.ThreadManagementService["Service"],
      ),
    ),
    Layer.provide(ServerSettingsService.layerTest()),
    Layer.provide(InstructionProviderInstances.layer),
    Layer.provide(NodePath.layer),
    Layer.provide(
      Layer.succeed(ServerConfig.ServerConfig, {
        stateDir: "/tmp/tempo-test-state",
      } as ServerConfig.ServerConfig["Service"]),
    ),
  );
  return {
    layer,
    spawned,
    reconnected,
    terminalOpened: Effect.suspend(() => Deferred.await(started)).pipe(
      Effect.andThen(
        Effect.sync(() => {
          started = Deferred.makeUnsafe<void>();
        }),
      ),
    ),
    output: (data: string) => onData?.(data),
    exit: (exitCode: number) => onExit?.({ exitCode, signal: null }),
  };
};

const connectors = TempoMcpConnectors.TempoMcpConnectors;
const isConnectorsError = Schema.is(TempoMcpConnectorsError);

describe("TempoMcpConnectors", () => {
  it("lists servers needing sign in first and leaves out the host's own", () => {
    const view = TempoMcpConnectors.connectorsView([
      server("gamma", "connected"),
      server("t3-code", "connected", "sdk"),
      server("beta", "failed"),
      server("alpha", "needs-auth"),
    ]);
    assert.deepStrictEqual(
      view.map((connector) => `${connector.name}:${connector.status}`),
      ["alpha:needs-auth", "beta:failed", "gamma:connected"],
    );
  });

  it.effect(
    "signs in where Claude runs, then reconnects only the Claudes that still lack the server",
    () => {
      const world = makeWorld([
        { id: "a", cwd: "/work/a", servers: [server("alpha", "needs-auth")] },
        { id: "b", cwd: "/work/b", servers: [server("alpha", "connected")] },
        { id: "c", cwd: "/work/c", servers: [server("gamma", "needs-auth")] },
      ]);
      return Effect.gen(function* () {
        const service = yield* connectors;
        const fiber = yield* service.signIn(null, "alpha").pipe(Effect.forkChild);
        yield* world.terminalOpened;
        assert.deepStrictEqual(world.spawned[0]?.args, ["mcp", "login", "alpha"]);
        assert.strictEqual(world.spawned[0]?.cwd, "/work/a");
        world.exit(0);
        const listed = yield* Fiber.join(fiber);
        assert.deepStrictEqual(world.reconnected, ["a:alpha"]);
        assert.strictEqual(listed.live, true);
        assert.strictEqual(listed.signingIn, null);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect("fails with Claude Code's own last line when the login fails", () => {
    const world = makeWorld([
      { id: "a", cwd: "/work/a", servers: [server("alpha", "needs-auth")] },
    ]);
    return Effect.gen(function* () {
      const service = yield* connectors;
      const fiber = yield* service.signIn(null, "alpha").pipe(Effect.forkChild);
      yield* world.terminalOpened;
      world.output(
        'Starting authentication for "alpha"…\r\n\u001b[2mWaiting for authorization… (^C to cancel)\u001b[22m\r\n' +
          'Couldn\'t complete authentication for "alpha": the server refused the code.\r\n',
      );
      world.exit(1);
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : null;
      assert.isTrue(isConnectorsError(error));
      if (isConnectorsError(error)) {
        assert.strictEqual(error.reason, "sign-in-failed");
        assert.strictEqual(
          error.detail,
          'Couldn\'t complete authentication for "alpha": the server refused the code.',
        );
      }
      assert.deepStrictEqual(world.reconnected, []);
    }).pipe(Effect.provide(world.layer));
  });
});
