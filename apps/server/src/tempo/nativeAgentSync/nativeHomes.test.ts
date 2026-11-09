import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";

import { resolveNativeHomes } from "./nativeHomes.ts";

const run = (environment: NodeJS.ProcessEnv) =>
  resolveNativeHomes({ baseDir: "/Users/ada/.tempo" }).pipe(
    Effect.provideService(HostProcess.HomeDirectory, "/Users/ada"),
    Effect.provideService(HostProcess.Environment, environment),
    Effect.provide(NodeServices.layer),
  );

describe("resolveNativeHomes", () => {
  it.effect("uses the CLIs' own homes: their variables, else ~/.codex and ~/.claude", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* run({}), {
        codex: "/Users/ada/.codex",
        claude: "/Users/ada/.claude",
      });
      assert.deepEqual(
        yield* run({ CODEX_HOME: "~/work/codex-home", CLAUDE_CONFIG_DIR: "/opt/claude" }),
        { codex: "/Users/ada/work/codex-home", claude: "/opt/claude" },
      );
    }),
  );

  it.effect(
    "never takes a home Tempo or T3 Code owns, such as the one an agent's shell inherits",
    () =>
      Effect.gen(function* () {
        assert.deepEqual(
          yield* run({
            CODEX_HOME: "/Users/ada/.tempo/provider-homes/codex",
            CLAUDE_CONFIG_DIR: "/Users/ada/.t3/claude",
          }),
          { codex: "/Users/ada/.codex", claude: "/Users/ada/.claude" },
        );
      }),
  );
});
