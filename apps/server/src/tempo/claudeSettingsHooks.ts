import type { Settings } from "@anthropic-ai/claude-agent-sdk";

/**
 * tempo: `settings` with `hooks` run after its own hooks for the same event. Claude
 * reads one flag-settings object, so Tempo's hooks and the --settings launch
 * argument's share it.
 */
export function withClaudeHooks(
  settings: Settings | undefined,
  hooks: NonNullable<Settings["hooks"]>,
): Settings {
  const merged: NonNullable<Settings["hooks"]> = { ...settings?.hooks };
  for (const [event, matchers] of Object.entries(hooks)) {
    // A launch argument is the person's JSON, so an event's value may not be a list.
    const own = merged[event];
    merged[event] = [...(Array.isArray(own) ? own : []), ...matchers];
  }
  return { ...settings, hooks: merged };
}
