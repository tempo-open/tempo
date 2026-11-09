/**
 * tempo: the agent's way to wait on outside state without chatting: a watcher
 * (`tempoWatchers.ts`). It calls `OrchestratorMcpService.watchCommand`; watchers
 * are scheduled tasks, so the scheduled task tools list, stop and run them.
 */
import {
  TEMPO_WATCHER_LIFETIME_MS,
  TempoWatchCommandInput,
  TempoWatchCommandResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

const WatchCommandTool = Tool.make("watch_command", {
  description: `Wait on outside state (an API recovering from a rate limit, a deploy, a CI run, fresh data) without polling in chat. ${TEMPO_APP_BASE_NAME} runs \`command\` with /bin/sh -c in this thread's workspace every \`everyMinutes\`, as you, without waking you, and wakes this thread once with your \`prompt\` plus the check's exit code and output when \`wakeWhen\` holds: succeeds (exit 0), fails (non-zero exit or a timeout), or output_changes (a check that exits 0 prints different trimmed stdout than the first one that did). Checks that do not meet it send nothing. The first check runs during this call and comes back in the result: if it already meets the condition nothing is armed, so carry on; if it shows the command is broken, delete the watcher and arm a fixed one. Otherwise end your turn, and never post "still waiting" messages: the wake is the next thing this thread hears. Write the command so its exit code or output answers the question, e.g. \`curl -fsS -o /dev/null https://api.example.com/health\` with succeeds, or \`gh run view 123 --json status -q .status\` with output_changes. A watcher wakes once and is then removed; after ${TEMPO_WATCHER_LIFETIME_MS / 86_400_000} days without a match it is removed and the thread is told. Each check has a 60 s timeout, no TTY, empty stdin and its output capped; only the last 2000 characters reach you, marked as untrusted. Meanwhile the thread sits under Waiting in the user's sidebar. Watchers are scheduled tasks bound to this thread: see them with list_scheduled_tasks, stop one with delete_scheduled_task (or pause it with schedule_task, its scheduledTaskId and enabled=false), and check now with run_scheduled_task_now. For pull requests use watch_pull_request. A subagent cannot arm a watcher: its parent thread owns the wait.`,
  parameters: TempoWatchCommandInput,
  success: TempoWatchCommandResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    OrchestratorMcpService.OrchestratorMcpService,
  ],
})
  .annotate(Tool.Title, "Watch a command")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const TempoWatcherToolkit = Toolkit.make(WatchCommandTool);
