/**
 * The host's own Codex and Claude Code homes: where the person's CLIs and desktop apps keep their
 * threads. Tempo's Claude runs from this Claude home too, and on the local route its Codex from this
 * Codex home, which is why the sync keeps Tempo's own sessions out. A home inside a Tempo or T3 Code data
 * directory is never native.
 */
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import { liveHomeDirs } from "@t3tools/shared/tempoBrand";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

export interface NativeHomes {
  /** `$CODEX_HOME`, else `~/.codex`. */
  readonly codex: string | null;
  /** `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
  readonly claude: string | null;
}

export const resolveNativeHomes = Effect.fn("nativeHomes.resolve")(function* (input: {
  /** This Tempo's own home. */
  readonly baseDir: string;
}) {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  const homeDir = yield* HostProcess.HomeDirectory;
  const owned = [input.baseDir, ...liveHomeDirs(homeDir)].map((dir) => path.resolve(dir));
  const isOwned = (dir: string) =>
    owned.some((root) => dir === root || dir.startsWith(`${root}${path.sep}`));
  // An agent's shell inside Tempo carries Tempo's own CODEX_HOME; the person's home is still the default.
  const pick = (variable: string, fallback: string): string | null => {
    const configured = environment[variable]?.trim();
    const candidates = [
      ...(configured ? [path.resolve(expandHomePath(configured, homeDir))] : []),
      path.join(homeDir, fallback),
    ];
    return candidates.find((dir) => !isOwned(dir)) ?? null;
  };
  return {
    codex: pick("CODEX_HOME", ".codex"),
    claude: pick("CLAUDE_CONFIG_DIR", ".claude"),
  } satisfies NativeHomes;
});
