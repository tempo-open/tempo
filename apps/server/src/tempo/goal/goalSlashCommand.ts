import {
  TEMPO_GOAL_SLASH_COMMAND,
  type ServerProvider,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";

const withGoal = (commands: ReadonlyArray<ServerProviderSlashCommand>) => [
  ...commands.filter((command) => command.name !== TEMPO_GOAL_SLASH_COMMAND.name),
  TEMPO_GOAL_SLASH_COMMAND,
];

/**
 * tempo: every provider's slash commands list Tempo's `/goal` in place of the
 * provider's own (Codex's, and Claude Code's when it reports one); the server
 * handles `/goal` itself (tempoGoal.ts). Workspace catalogs replace the global
 * list, so they carry it too.
 */
export function withTempoGoalCommand(providers: ReadonlyArray<ServerProvider>): ServerProvider[] {
  return providers.map((provider) => ({
    ...provider,
    slashCommands: withGoal(provider.slashCommands),
    ...(provider.workspaceSnapshots
      ? {
          workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
            ...snapshot,
            slashCommands: withGoal(snapshot.slashCommands),
          })),
        }
      : {}),
  }));
}
