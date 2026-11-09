/**
 * tempo: chats a bot outside Tempo launched through the MCP connector. The server records the name the
 * bot gave (`launchedBy`), else its sign-in name; chats from before that, or that Tempo's own agents
 * launched unnamed, carry none.
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";

interface BotLaunchSource {
  readonly source: Pick<OrchestrationV2ThreadShell, "tempoLaunchedBy">;
}

/** The bot that launched the chat, such as "Release Bot"; null for every other chat. */
export function botLauncherName(thread: BotLaunchSource): string | null {
  return thread.source.tempoLaunchedBy ?? null;
}
