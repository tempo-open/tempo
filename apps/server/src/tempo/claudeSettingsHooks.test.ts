import { assert, it } from "@effect/vitest";

import { withClaudeHooks } from "./claudeSettingsHooks.ts";

const safety = {
  PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command" as const, command: "safety" }] }],
  SessionEnd: [{ hooks: [{ type: "command" as const, command: "safety-end" }] }],
};

it("adds hooks after the launch argument's own and keeps its other settings", () => {
  const settings = withClaudeHooks(
    {
      env: { A: "1" },
      hooks: {
        PreToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: "mine" }] }],
        Stop: [{ hooks: [{ type: "command", command: "stop" }] }],
      },
    },
    safety,
  );
  assert.deepEqual(settings.env, { A: "1" });
  assert.deepEqual(
    settings.hooks?.PreToolUse?.map((matcher) => matcher.matcher),
    ["Edit", "Bash"],
  );
  assert.deepEqual(settings.hooks?.SessionEnd, safety.SessionEnd);
  assert.deepEqual(settings.hooks?.Stop, [{ hooks: [{ type: "command", command: "stop" }] }]);
});

it("returns the hooks alone without settings, and skips an event that is not a list", () => {
  assert.deepEqual(withClaudeHooks(undefined, safety), { hooks: safety });
  const malformed = { hooks: { PreToolUse: "x" } } as never;
  assert.deepEqual(withClaudeHooks(malformed, safety).hooks?.PreToolUse, safety.PreToolUse);
});
