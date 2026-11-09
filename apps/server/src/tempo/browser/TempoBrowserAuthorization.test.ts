import {
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  clientRpcRequiredScopes,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";

import * as RpcAuthorization from "../../auth/RpcAuthorization.ts";

const PROFILE = {
  profileId: "work",
  extensions: [],
  extensionBrowser: "notInstalled" as const,
  passkeys: {
    settings: { savePasskeys: true, agentsMayUse: false, provider: "saved" as const },
    saved: [],
    availableProviders: ["saved" as const],
  },
};

describe("tempo browser profile authorization", () => {
  it("needs a settings write to change extensions, passkey or password access, and preview control otherwise", () => {
    for (const method of [
      WS_METHODS.tempoBrowserAddExtension,
      WS_METHODS.tempoBrowserSetExtensionEnabled,
      WS_METHODS.tempoBrowserRemoveExtension,
      WS_METHODS.tempoBrowserCheckExtensionUpdates,
      WS_METHODS.tempoBrowserSetPasskeySettings,
      WS_METHODS.tempoBrowserRemovePasskey,
      WS_METHODS.tempoBrowserSetPasswordSettings,
      WS_METHODS.tempoBrowserRemovePassword,
      WS_METHODS.tempoBrowserForgetProfile,
    ]) {
      expect(RpcAuthorization.requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
      // Clients guard the same methods before sending them.
      expect(clientRpcRequiredScopes(method, undefined)).toEqual([AuthSettingsWriteScope]);
    }
    for (const method of [
      WS_METHODS.tempoBrowserGetProfile,
      WS_METHODS.tempoBrowserOpenExtensionPage,
    ]) {
      expect(RpcAuthorization.requiredScopeForRpcMethod(method)).toBe(AuthPreviewOperateScope);
    }
  });

  const tested = [
    WS_METHODS.tempoBrowserGetProfile,
    WS_METHODS.tempoBrowserSetPasskeySettings,
    WS_METHODS.tempoBrowserSetPasswordSettings,
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

  it.effect(
    "refuses a browser-only session that tries to let agents use passkeys or passwords",
    () =>
      Effect.gen(function* () {
        const handled: Array<string> = [];
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.tempoBrowserGetProfile, () =>
                Effect.succeed(PROFILE),
              ),
              group.toLayerHandler(WS_METHODS.tempoBrowserSetPasskeySettings, () =>
                Effect.sync(() => handled.push("set")).pipe(Effect.as(PROFILE)),
              ),
              group.toLayerHandler(WS_METHODS.tempoBrowserSetPasswordSettings, () =>
                Effect.sync(() => handled.push("set")).pipe(Effect.as(PROFILE)),
              ),
              RpcAuthorization.layer([AuthPreviewOperateScope]),
            ),
          ),
        );
        expect(yield* client[WS_METHODS.tempoBrowserGetProfile]({ profileId: "work" })).toEqual(
          PROFILE,
        );
        const refused = {
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthSettingsWriteScope,
        };
        expect(
          yield* client[WS_METHODS.tempoBrowserSetPasskeySettings]({
            profileId: "work",
            agentsMayUse: true,
          }).pipe(Effect.flip),
        ).toMatchObject(refused);
        expect(
          yield* client[WS_METHODS.tempoBrowserSetPasswordSettings]({
            profileId: "work",
            agentsMayUse: true,
          }).pipe(Effect.flip),
        ).toMatchObject(refused);
        expect(handled).toEqual([]);
      }).pipe(Effect.scoped),
  );
});
