import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  TEMPO_SAFETY_POLICY_FILE,
  tempoSafetyPolicyHooks,
  tempoSafetyPolicySettings,
} from "./claudeSafetyPolicy.ts";

const checkout = (withPolicy: boolean) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-tempo-policy-" });
    yield* fileSystem.makeDirectory(path.join(root, ".git"));
    yield* fileSystem.makeDirectory(path.join(root, "product", "apps"), { recursive: true });
    if (withPolicy) {
      yield* fileSystem.makeDirectory(path.join(root, ".agents", "hooks"), { recursive: true });
      yield* fileSystem.writeFileString(path.join(root, TEMPO_SAFETY_POLICY_FILE), "");
    }
    return { root, path, fileSystem };
  });

describe("tempoSafetyPolicySettings", () => {
  it.effect("wires the checkout's policy from any folder below its root", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { root, path } = yield* checkout(true);
        assert.deepEqual(yield* tempoSafetyPolicySettings(path.join(root, "product", "apps")), {
          hooks: tempoSafetyPolicyHooks(path.join(root, TEMPO_SAFETY_POLICY_FILE)),
        });
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("adds nothing outside such a checkout or where the start folder wires it", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const bare = yield* checkout(false);
        assert.isUndefined(yield* tempoSafetyPolicySettings(bare.root));
        assert.isUndefined(yield* tempoSafetyPolicySettings(null));

        const { root, path, fileSystem } = yield* checkout(true);
        yield* fileSystem.makeDirectory(path.join(root, ".claude"));
        yield* fileSystem.writeFileString(
          path.join(root, ".claude", "settings.json"),
          `{"hooks":{"PreToolUse":[{"hooks":[{"command":"node \\"$CLAUDE_PROJECT_DIR/${TEMPO_SAFETY_POLICY_FILE}\\""}]}]}}`,
        );
        assert.isUndefined(yield* tempoSafetyPolicySettings(root));
        assert.isDefined(yield* tempoSafetyPolicySettings(path.join(root, "product")));
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );

  it("quotes the policy path for the shell", () => {
    const hooks = tempoSafetyPolicyHooks(
      "/Users/o'neil/repo/.agents/hooks/agent-safety-policy.mjs",
    );
    assert.nestedPropertyVal(
      hooks,
      "PreToolUse[0].hooks[0].command",
      `node '/Users/o'\\''neil/repo/.agents/hooks/agent-safety-policy.mjs'`,
    );
  });
});
