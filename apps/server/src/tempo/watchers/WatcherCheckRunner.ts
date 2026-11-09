/**
 * tempo: runs a watcher's check on this machine, in its thread's workspace, as the user the thread's
 * agent runs as: `/bin/sh -c`, empty stdin, no TTY, a timeout, and capped output. The scheduled
 * task service reads it as a reference so its tests need no process spawner; the server's runtime
 * layer provides this implementation.
 */
import { TEMPO_WATCHER_CHECK_TIMEOUT_MS, type ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import type { WatcherCheckRun } from "./watcherDecision.ts";

/** Collected per stream; only the tail is kept, and `output_changes` reads standard output. */
const MAX_OUTPUT_BYTES = 64 * 1024;

export class WatcherCheckError extends Data.TaggedError("WatcherCheckError")<{
  readonly message: string;
}> {}

export class WatcherCheckRunner extends Context.Reference<
  (input: {
    readonly threadId: ThreadId;
    readonly command: string;
  }) => Effect.Effect<WatcherCheckRun, WatcherCheckError>
>("t3/tempo/watchers/WatcherCheckRunner", {
  defaultValue: () => () =>
    Effect.fail(new WatcherCheckError({ message: "this server cannot run watcher checks" })),
}) {}

export const layer = Layer.effect(
  WatcherCheckRunner,
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projects = yield* ProjectService.ProjectService;
    const failed = (message: string) => new WatcherCheckError({ message });

    const workspaceOf = Effect.fn("WatcherCheckRunner.workspaceOf")(function* (threadId: ThreadId) {
      const shell = yield* threads
        .getThreadShell(threadId)
        .pipe(Effect.mapError(() => failed("its thread could not be read")));
      if (shell === null || shell.deletedAt !== null) {
        return yield* failed("its thread no longer exists");
      }
      if (shell.worktreePath !== null) return shell.worktreePath;
      const project = yield* projects
        .getById(shell.projectId)
        .pipe(Effect.mapError(() => failed("its project could not be read")));
      if (Option.isNone(project)) return yield* failed("its project no longer exists");
      return project.value.workspaceRoot;
    });

    return Effect.fn("WatcherCheckRunner.run")(function* (input) {
      const cwd = yield* workspaceOf(input.threadId);
      const output = yield* processes
        .run({
          command: "/bin/sh",
          args: ["-c", input.command],
          cwd,
          stdin: "",
          timeout: TEMPO_WATCHER_CHECK_TIMEOUT_MS,
          timeoutBehavior: "timedOutResult",
          maxOutputBytes: MAX_OUTPUT_BYTES,
          outputMode: "truncate",
        })
        .pipe(Effect.mapError((error) => failed(error.message)));
      return {
        exitCode: output.code === null ? null : Number(output.code),
        timedOut: output.timedOut,
        stdout: output.stdout,
        stderr: output.stderr,
      } satisfies WatcherCheckRun;
    });
  }),
);
