/**
 * tempo: how clients describe a watcher (`tempoWatchers.ts`), a scheduled task whose
 * interval runs a check: what it waits for and what its latest check said.
 * Shared by the web thread panel and the mobile task list.
 */
import type { TempoWatcher, TempoWatcherCheckResult } from "@t3tools/contracts";

const WAITS_FOR: Record<TempoWatcher["wakeWhen"], string> = {
  succeeds: "until it succeeds",
  fails: "until it fails",
  output_changes: "until its output changes",
};

/** For example "Watching until it succeeds". */
export function watcherSummary(watcher: Pick<TempoWatcher, "wakeWhen">): string {
  return `Watching ${WAITS_FOR[watcher.wakeWhen]}`;
}

/** For example "exit 0", "exit 22" or "timed out". */
export function watcherCheckOutcome(check: Pick<TempoWatcherCheckResult, "exitCode" | "timedOut">) {
  return check.timedOut ? "timed out" : `exit ${check.exitCode}`;
}
