import {
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  AuthTerminalOperateScope,
  clientRpcRequiredScopes,
  TEMPO_REPOS_VOLUME_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";

const STATUS = {
  path: "/Users/person/repos",
  mounted: false,
  worktreesPath: "/Users/person/repos/.worktrees",
};

describe("tempo repos volume authorization", () => {
  it("lets readers check the volume but only terminal operators prepare its setup", () => {
    expect(RpcAuthorization.requiredScopeForRpcMethod(TEMPO_REPOS_VOLUME_WS_METHODS.status)).toBe(
      AuthOrchestrationReadScope,
    );
    expect(RpcAuthorization.requiredScopeForRpcMethod(TEMPO_REPOS_VOLUME_WS_METHODS.prepare)).toBe(
      AuthTerminalOperateScope,
    );
    // Clients check the destination's grant before preparing; checking needs no extra grant.
    expect(clientRpcRequiredScopes(TEMPO_REPOS_VOLUME_WS_METHODS.prepare, undefined)).toEqual([
      AuthTerminalOperateScope,
    ]);
    expect(clientRpcRequiredScopes(TEMPO_REPOS_VOLUME_WS_METHODS.status, undefined)).toEqual([]);
  });

  const tested = [
    TEMPO_REPOS_VOLUME_WS_METHODS.status,
    TEMPO_REPOS_VOLUME_WS_METHODS.prepare,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<
        keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES,
        (typeof tested)[number]
      > => !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect("refuses to prepare the setup for a session that cannot operate terminals", () =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(TEMPO_REPOS_VOLUME_WS_METHODS.status, () =>
              Effect.succeed(STATUS),
            ),
            group.toLayerHandler(TEMPO_REPOS_VOLUME_WS_METHODS.prepare, () =>
              Effect.sync(() => handled.push("prepare")).pipe(
                Effect.as({ scriptPath: "/state/repos-volume.sh", cwd: "/Users/person" }),
              ),
            ),
            // A settings grant changes where worktrees go, but does not run anything.
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(yield* client[TEMPO_REPOS_VOLUME_WS_METHODS.status]({})).toEqual(STATUS);
      expect(
        yield* client[TEMPO_REPOS_VOLUME_WS_METHODS.prepare]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthTerminalOperateScope,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
