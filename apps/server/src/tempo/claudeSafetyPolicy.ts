/**
 * tempo: Claude sessions inside a checkout that has a safety policy run its safety hook
 * (`.agents/hooks/agent-safety-policy.mjs`) from any start folder. Claude reads
 * `.claude/settings.json` only from the folder a session starts in, so Tempo adds the hook itself
 * unless that folder's settings already wire it.
 */
import type { Settings } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

export const TEMPO_SAFETY_POLICY_FILE = ".agents/hooks/agent-safety-policy.mjs";

/** The same hooks, matcher and options as the checkout's `.claude/settings.json`. */
export function tempoSafetyPolicyHooks(policyPath: string): NonNullable<Settings["hooks"]> {
  const command = `node '${policyPath.replaceAll("'", "'\\''")}'`;
  const check = {
    type: "command" as const,
    command,
    timeout: 30,
    onFailure: "block",
    statusMessage: "Checking the repository's safety policy",
  };
  return {
    PreToolUse: [
      {
        matcher: "Bash|Monitor|mcp__.*__run_in_terminal|mcp__Claude_Code_iOS_Simulator__.*",
        hooks: [check],
      },
    ],
    SessionEnd: [{ hooks: [{ type: "command", command, timeout: 3 }] }],
  };
}

/**
 * The safety hooks for a session in `cwd`: undefined outside a checkout that
 * has the policy, and when the start folder's own settings already wire it.
 */
export const tempoSafetyPolicySettings = Effect.fn("tempoSafetyPolicySettings")(function* (
  cwd: string | null,
) {
  if (cwd === null) return undefined;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const exists = (file: string) => fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false));
  const start = path.resolve(cwd);
  let root = start;
  while (!(yield* exists(path.join(root, ".git")))) {
    if (path.dirname(root) === root) return undefined;
    root = path.dirname(root);
  }
  const policyPath = path.join(root, TEMPO_SAFETY_POLICY_FILE);
  if (!(yield* exists(policyPath))) return undefined;
  const startSettings = yield* fileSystem
    .readFileString(path.join(start, ".claude", "settings.json"))
    .pipe(Effect.orElseSucceed(() => ""));
  if (startSettings.includes(TEMPO_SAFETY_POLICY_FILE)) return undefined;
  return { hooks: tempoSafetyPolicyHooks(policyPath) } satisfies Settings;
});
