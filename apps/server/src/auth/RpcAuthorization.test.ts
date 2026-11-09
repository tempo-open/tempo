import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthFilesystemWriteScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  TEMPO_CLAUDE_WORKFLOWS_WS_METHODS,
  TEMPO_T3_IMPORT_WS_METHODS,
  TEMPO_THREAD_MOVE_WS_METHODS,
  TempoThreadMoveId,
  EnvironmentId,
  clientRpcRequiredScopes,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  CLIENT_GUARDED_RPC_SCOPES,
  LAPTOP_TOOLS_WS_METHODS,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("lets only operators host laptop tools and answer agent calls to them", () => {
    expect(requiredScopeForRpcMethod(LAPTOP_TOOLS_WS_METHODS.connect)).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(requiredScopeForRpcMethod(LAPTOP_TOOLS_WS_METHODS.respond)).toBe(
      AuthOrchestrationOperateScope,
    );
    // Clients check the answer before sending it; the server checks both.
    expect(CLIENT_GUARDED_RPC_SCOPES[LAPTOP_TOOLS_WS_METHODS.respond]).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("lists saved Claude workflows only with filesystem read access", () => {
    expect(requiredScopeForRpcMethod(TEMPO_CLAUDE_WORKFLOWS_WS_METHODS.listSaved)).toBe(
      AuthFilesystemReadScope,
    );
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("lets file readers list tempo instruction files but only settings writers change them", () => {
    for (const method of [
      WS_METHODS.tempoInstructionFilesList,
      WS_METHODS.tempoInstructionFilesRead,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthFilesystemReadScope);
    }
    for (const method of [
      WS_METHODS.tempoInstructionFilesWrite,
      WS_METHODS.tempoInstructionFilesDelete,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
    }
  });

  it("lets file readers export agent files but only settings writers import them", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.tempoAgentFilesExport)).toBe(
      AuthFilesystemReadScope,
    );
    expect(requiredScopeForRpcMethod(WS_METHODS.tempoAgentFilesImport)).toBe(
      AuthSettingsWriteScope,
    );
    // Clients check the destination's grant before they send an import.
    expect(CLIENT_GUARDED_RPC_SCOPES[WS_METHODS.tempoAgentFilesImport]).toBe(
      AuthSettingsWriteScope,
    );
  });

  it("lets readers list tempo service connections but only provider managers change or test them", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.tempoListServiceConnections)).toBe(
      AuthOrchestrationReadScope,
    );
    for (const method of [
      WS_METHODS.tempoSaveLocalServiceConnection,
      WS_METHODS.tempoRemoveLocalServiceConnection,
      WS_METHODS.tempoTestServiceConnection,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthProvidersManageScope);
    }
  });

  it("lets readers look at T3 Code's history but only operators import it", () => {
    expect(requiredScopeForRpcMethod(TEMPO_T3_IMPORT_WS_METHODS.scan)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(requiredScopeForRpcMethod(TEMPO_T3_IMPORT_WS_METHODS.run)).toBe(
      AuthOrchestrationOperateScope,
    );
    // Clients check the import before sending it; scanning needs no extra grant.
    expect(clientRpcRequiredScopes(TEMPO_T3_IMPORT_WS_METHODS.run, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(TEMPO_T3_IMPORT_WS_METHODS.scan, undefined)).toEqual([]);
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect("requires source-control and filesystem grants to unpack a moved thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof TEMPO_THREAD_MOVE_WS_METHODS.import
        > => tag !== TEMPO_THREAD_MOVE_WS_METHODS.import,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(TEMPO_THREAD_MOVE_WS_METHODS.import, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthOrchestrationOperateScope, AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[TEMPO_THREAD_MOVE_WS_METHODS.import]({
        moveId: TempoThreadMoveId.make("move"),
        source: { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" },
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthFilesystemWriteScope });
    expect(handled).toBe(false);
    // Turning the source into a stub is ordinary thread work.
    expect(clientRpcRequiredScopes(TEMPO_THREAD_MOVE_WS_METHODS.finalize, undefined)).toEqual([
      AuthOrchestrationOperateScope,
    ]);
    expect(clientRpcRequiredScopes(TEMPO_THREAD_MOVE_WS_METHODS.prepare, undefined)).toEqual([
      AuthOrchestrationOperateScope,
      AuthSourceControlWriteScope,
      AuthFilesystemReadScope,
    ]);
  }).pipe(Effect.scoped),
);

it.effect("lets a read-only session scan T3 Code but refuses its import before the handler", () =>
  Effect.gen(function* () {
    const tested = [TEMPO_T3_IMPORT_WS_METHODS.scan, TEMPO_T3_IMPORT_WS_METHODS.run] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
          !(tested as ReadonlyArray<string>).includes(tag),
      ),
    );
    const handled: Array<string> = [];
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(TEMPO_T3_IMPORT_WS_METHODS.scan, () =>
            Effect.sync(() => {
              handled.push("scan");
              return {
                t3Home: "/Users/me/.t3",
                found: false,
                sizeBytes: 0,
                t3Running: false,
                incompatibility: null,
                projects: [],
              };
            }),
          ),
          group.toLayerHandler(TEMPO_T3_IMPORT_WS_METHODS.run, () =>
            Effect.sync(() => {
              handled.push("run");
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect((yield* client[TEMPO_T3_IMPORT_WS_METHODS.scan]({})).found).toBe(false);
    expect(yield* client[TEMPO_T3_IMPORT_WS_METHODS.run]({}).pipe(Effect.flip)).toMatchObject({
      _tag: "EnvironmentAuthorizationError",
      requiredPermission: AuthOrchestrationOperateScope,
    });
    expect(handled).toEqual(["scan"]);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

it.effect(
  "denies tempo instruction file writes before the handler without settings permission",
  () =>
    Effect.gen(function* () {
      const group = WsRpcGroup.omit(
        ...[...WsRpcGroup.requests.keys()].filter(
          (
            tag,
          ): tag is Exclude<
            keyof typeof RPC_REQUIRED_SCOPES,
            typeof WS_METHODS.tempoInstructionFilesWrite
          > => tag !== WS_METHODS.tempoInstructionFilesWrite,
        ),
      );
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.tempoInstructionFilesWrite, (input) =>
              Effect.sync(() => {
                handled = true;
                return { path: input.path, size: 0, mtimeMs: 0 };
              }),
            ),
            // Workspace file grants alone do not cover files that configure every agent.
            RpcAuthorization.layer([AuthFilesystemReadScope, AuthFilesystemWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.tempoInstructionFilesWrite]({
          path: "/repo/CLAUDE.md",
          content: "",
          expectedMtimeMs: null,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
);

it.effect("denies agent file exports and imports before their handlers without their grants", () =>
  Effect.gen(function* () {
    const tested = [WS_METHODS.tempoAgentFilesExport, WS_METHODS.tempoAgentFilesImport] as const;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
          !(tested as ReadonlyArray<string>).includes(tag),
      ),
    );
    const handled: Array<string> = [];
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.tempoAgentFilesExport, () =>
            Effect.sync(() => {
              handled.push("export");
              return { files: [], links: [], skipped: [] };
            }),
          ),
          group.toLayerHandler(WS_METHODS.tempoAgentFilesImport, () =>
            Effect.sync(() => {
              handled.push("import");
              return { written: [], unchanged: [], skipped: [] };
            }),
          ),
          // Workspace file writes do not cover files that configure every agent.
          RpcAuthorization.layer([AuthOrchestrationReadScope, AuthFilesystemWriteScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.tempoAgentFilesExport]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthFilesystemReadScope,
    });
    expect(
      yield* client[WS_METHODS.tempoAgentFilesImport]({ files: [], links: [] }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
    expect(handled).toEqual([]);
  }).pipe(Effect.scoped),
);
