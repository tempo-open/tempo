/**
 * tempo: which bot outside Tempo launched a thread, shown on its sidebar row. Only MCP clients signed
 * in from outside a thread count; Tempo's own agents, here or on a linked machine, and the
 * `tempo thread` CLI do not.
 */
import type { OrchestrationV2AppThread, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { TEMPO_CLI_NAME } from "@t3tools/shared/tempoBrand";

export const TEMPO_THREAD_CLI_CLIENT_LABEL = `${TEMPO_CLI_NAME} thread cli`;

const LAUNCHED_BY_MAX_CHARS = 40;

/** The name a launch records: the one the bot gave, else its sign-in name. */
export function resolveLaunchedBy(input: {
  readonly launchedBy: string | undefined;
  /** Set when a Tempo thread is the caller. */
  readonly callerThreadId: string | undefined;
  readonly clientLabel: string | undefined;
  /** Another Tempo environment's link; its threads show the machine they came from instead. */
  readonly linked: boolean;
}): string | undefined {
  if (input.callerThreadId !== undefined || input.linked || input.clientLabel === undefined) {
    return undefined;
  }
  if (input.clientLabel === TEMPO_THREAD_CLI_CLIENT_LABEL) return undefined;
  const name = input.launchedBy?.trim() || input.clientLabel.trim();
  // Code points, so a cut never leaves half a surrogate pair.
  return Array.from(name).slice(0, LAUNCHED_BY_MAX_CHARS).join("").trim() || undefined;
}

export function tempoLaunchedByShellFields(
  thread: Pick<OrchestrationV2AppThread, "tempoLaunchedBy">,
): Pick<OrchestrationV2ThreadShell, "tempoLaunchedBy"> {
  return thread.tempoLaunchedBy === undefined ? {} : { tempoLaunchedBy: thread.tempoLaunchedBy };
}

/** A fork is the user's own thread, whoever launched its source. */
export function dropLaunchedBy(thread: OrchestrationV2AppThread): OrchestrationV2AppThread {
  const { tempoLaunchedBy: _launchedBy, ...rest } = thread;
  return rest;
}
