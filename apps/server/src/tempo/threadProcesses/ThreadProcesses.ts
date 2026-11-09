/**
 * tempo: Stop ends everything a thread's commands started, also programs that left the agent's process
 * group: by the thread id commands inherit (macOS `ps -E`, which hides it for macOS's own binaries),
 * by the process tree before the agent's exit cuts its links, and by a sample every 10 seconds.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

import { AGENT_THREAD_ENV } from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";

// A Mac under heavy load can take this long, and that is when Stop matters most.
const PS_TIMEOUT = "30 seconds";
const PS_MAX_OUTPUT_BYTES = 128 * 1024 * 1024;
/** How long Stop waits for that read before it stops the agent on what the last sample saw. */
const STOP_READ_BUDGET = "5 seconds";
const GRACE_MS = 5_000;
const POLL_MS = 250;
const SAMPLE_INTERVAL = "10 seconds";
/** How long after an agent or task is stopped a program moving to launchd counts as left behind. */
const ORPHAN_WINDOW_MS = 5_000;
const ORPHAN_POLL_MS = 500;

export interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  /** With the pid, what identifies a process: a reused pid has a different start time. */
  readonly startedAt: string;
  readonly threadId: string | null;
  /** A command shell, which on macOS shows no environment, so no thread id either. */
  readonly shell: boolean;
}

const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.*)$/u;
const THREAD_ASSIGNMENT = new RegExp(`(?:^|\\s)${AGENT_THREAD_ENV}=(\\S+)`, "gu");
const SHELL_COMMAND = /^-?(?:\S*\/)?(?:sh|bash|zsh|dash|ksh|csh|tcsh)(?:\s|$)/u;

/**
 * Reads `ps -o pid=,ppid=,lstart=,command= -E`, which appends a process's launch environment to its
 * argv. The environment comes last, so the last assignment is its own even if an argument spells
 * one out. macOS hides the environment of its own binaries, such as /bin/sh, so those have none.
 */
export function parseProcessRows(raw: string): ReadonlyArray<ProcessRow> {
  const rows: Array<ProcessRow> = [];
  for (const line of raw.split("\n")) {
    const match = ROW.exec(line);
    if (match === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      startedAt: match[3]!,
      threadId: [...match[4]!.matchAll(THREAD_ASSIGNMENT)].at(-1)?.[1] ?? null,
      shell: SHELL_COMMAND.test(match[4]!),
    });
  }
  return rows;
}

/** The pid and start time of each process known to belong to a thread. */
export type ThreadProcessSnapshot = ReadonlyMap<number, string>;

/**
 * What belongs to a thread: what carries `threadId`, what a snapshot already named, and everything
 * those started. A daemon's shell shows no id, so the shells above a program that carries it count
 * when they lead straight to launchd; a shell under anything else is left to its parent. Never this
 * server or the processes above it, whatever they inherited.
 */
export function threadMembers(input: {
  readonly rows: ReadonlyArray<ProcessRow>;
  readonly threadId: string | null;
  readonly known: ThreadProcessSnapshot;
  readonly serverPid: number;
}): ReadonlyArray<ProcessRow> {
  const byPid = new Map(input.rows.map((row) => [row.pid, row]));
  const children = new Map<number, Array<ProcessRow>>();
  for (const row of input.rows) {
    children.set(row.ppid, [...(children.get(row.ppid) ?? []), row]);
  }
  const guarded = new Set([0, 1, input.serverPid]);
  for (
    let parent = byPid.get(input.serverPid)?.ppid;
    parent !== undefined && !guarded.has(parent);
    parent = byPid.get(parent)?.ppid
  ) {
    guarded.add(parent);
  }
  const members = new Map<number, ProcessRow>();
  const add = (row: ProcessRow) => {
    if (guarded.has(row.pid) || members.has(row.pid)) return;
    members.set(row.pid, row);
    for (const child of children.get(row.pid) ?? []) add(child);
  };
  const daemonShellsAbove = (row: ProcessRow) => {
    const shells: Array<ProcessRow> = [];
    for (
      let parent = byPid.get(row.ppid);
      parent !== undefined && parent.shell && parent.threadId === null && !guarded.has(parent.pid);
      parent = byPid.get(parent.ppid)
    ) {
      shells.push(parent);
    }
    return shells.at(-1)?.ppid === 1 ? shells : [];
  };
  for (const row of input.rows) {
    if (input.threadId !== null && row.threadId === input.threadId) {
      add(row);
      daemonShellsAbove(row).forEach(add);
    } else if (input.known.get(row.pid) === row.startedAt) {
      add(row);
    }
  }
  return [...members.values()];
}

export interface ThreadProcessesShape {
  /** Who belongs to the thread now. Read before stopping its agent, while parent links hold. */
  readonly snapshot: (threadId: string) => Effect.Effect<ThreadProcessSnapshot>;
  /**
   * Asks those programs and what they started to exit, and kills what is left after a grace. The
   * thread id no longer picks anything here: it would also pick the agent of the next message.
   */
  readonly endAll: (threadId: string, snapshot: ThreadProcessSnapshot) => Effect.Effect<void>;
  /** Who belongs to the thread now and under whom, to compare once one agent or task is stopped. */
  readonly members: (threadId: string) => Effect.Effect<ReadonlyArray<ProcessRow>>;
  /**
   * Watches `before` for a few seconds and ends what moves to launchd: a stopped agent's or task's
   * shell dies, and a program that left its group would otherwise live on with no Stop to end it.
   */
  readonly endOrphans: (threadId: string, before: ReadonlyArray<ProcessRow>) => Effect.Effect<void>;
  /** Keeps the thread programs sampled until the scope closes: the life of a provider session. */
  readonly sampleWhileOpen: Effect.Effect<void, never, Scope.Scope>;
}

const NOTHING: ThreadProcessSnapshot = new Map();

/** Off a Mac, and in tests that do not ask for it, Stop ends only the agent's process group. */
export const ThreadProcesses = Context.Reference<ThreadProcessesShape>("t3/tempo/ThreadProcesses", {
  defaultValue: () => ({
    snapshot: () => Effect.succeed(NOTHING),
    endAll: () => Effect.void,
    members: () => Effect.succeed([]),
    endOrphans: () => Effect.void,
    sampleWhileOpen: Effect.void,
  }),
});

/** Runs `stop`, however it ends, and then ends the programs of the thread in the background. */
export const endingThreadProcesses = Effect.fn("ThreadProcesses.endingThreadProcesses")(function* <
  A,
  E,
  R,
>(input: {
  readonly threadProcesses: ThreadProcessesShape;
  readonly threadId: string;
  readonly scope: Scope.Scope;
  readonly stop: Effect.Effect<A, E, R>;
}) {
  const { threadProcesses, threadId, scope, stop } = input;
  const snapshot = yield* threadProcesses.snapshot(threadId);
  const stopped = yield* Effect.exit(stop);
  // Stop must not wait out a program that ignores SIGTERM.
  yield* threadProcesses
    .endAll(threadId, snapshot)
    .pipe(Effect.forkIn(scope, { startImmediately: true }));
  return yield* stopped;
});

/** Runs `stop`, however it ends, and then ends what stopping one agent left behind. */
export const endingOrphans = Effect.fn("ThreadProcesses.endingOrphans")(function* <A, E, R>(input: {
  readonly threadProcesses: ThreadProcessesShape;
  readonly threadId: string;
  readonly scope: Scope.Scope;
  readonly stop: Effect.Effect<A, E, R>;
}) {
  const { threadProcesses, threadId, scope, stop } = input;
  const before = yield* threadProcesses.members(threadId);
  const stopped = yield* Effect.exit(stop);
  yield* threadProcesses
    .endOrphans(threadId, before)
    .pipe(Effect.forkIn(scope, { startImmediately: true }));
  return yield* stopped;
});

const signal = (rows: ReadonlyArray<ProcessRow>, name: "SIGTERM" | "SIGKILL") => {
  for (const { pid } of rows) {
    try {
      process.kill(pid, name);
    } catch {
      // It exited between the read and the signal.
    }
  }
};

export const make = Effect.fn("ThreadProcesses.make")(function* (
  options: { readonly graceMs?: number; readonly orphanWindowMs?: number } = {},
) {
  const runner = yield* ProcessRunner.ProcessRunner;
  const graceMs = options.graceMs ?? GRACE_MS;
  const orphanWindowMs = options.orphanWindowMs ?? ORPHAN_WINDOW_MS;

  const readRows = runner
    .run({
      command: "ps",
      args: ["-x", "-E", "-ww", "-o", "pid=,ppid=,lstart=,command="],
      timeout: PS_TIMEOUT,
      maxOutputBytes: PS_MAX_OUTPUT_BYTES,
    })
    .pipe(
      Effect.retry({ times: 1 }),
      Effect.map((result) => parseProcessRows(result.stdout)),
      Effect.tapError((cause) =>
        Effect.logWarning("Could not read the process list to stop a thread's programs", { cause }),
      ),
      Effect.orElseSucceed((): ReadonlyArray<ProcessRow> => []),
    );

  /** What each thread's last sample held; a pid counts only with its start time. */
  const sampled = new Map<string, ThreadProcessSnapshot>();
  let openSamplers = 0;

  const sample = Effect.gen(function* () {
    const rows = yield* readRows;
    // A read that failed says nothing about who is still there.
    if (rows.length === 0) return;
    const threadIds = new Set([
      ...sampled.keys(),
      ...rows.flatMap((row) => (row.threadId === null ? [] : [row.threadId])),
    ]);
    for (const threadId of threadIds) {
      if (process.env[AGENT_THREAD_ENV] === threadId) continue;
      const members = threadMembers({
        rows,
        threadId,
        known: sampled.get(threadId) ?? NOTHING,
        serverPid: process.pid,
      });
      if (members.length === 0) sampled.delete(threadId);
      else sampled.set(threadId, new Map(members.map((row) => [row.pid, row.startedAt])));
    }
  }).pipe(Effect.withTracerEnabled(false));

  const sampleEveryInterval = Effect.suspend(() => (openSamplers > 0 ? sample : Effect.void)).pipe(
    Effect.andThen(Effect.sleep(SAMPLE_INTERVAL)),
    Effect.forever,
  );

  const sampleWhileOpen: ThreadProcessesShape["sampleWhileOpen"] = Effect.acquireRelease(
    Effect.sync(() => {
      openSamplers += 1;
    }),
    () =>
      Effect.sync(() => {
        openSamplers -= 1;
      }),
  );

  /** The process list for Stop, or nothing when a loaded Mac cannot answer in time. */
  const readRowsForStop = readRows.pipe(
    Effect.timeoutOption(STOP_READ_BUDGET),
    Effect.map((rows) => (Option.isSome(rows) && rows.value.length > 0 ? rows : Option.none())),
  );

  const snapshot: ThreadProcessesShape["snapshot"] = Effect.fn("ThreadProcesses.snapshot")(
    function* (threadId) {
      // A server started from this thread carries its id, and so does everything else it started.
      if (process.env[AGENT_THREAD_ENV] === threadId) return NOTHING;
      const known = sampled.get(threadId) ?? NOTHING;
      const rows = yield* readRowsForStop;
      if (Option.isNone(rows)) return known;
      const members = threadMembers({
        rows: rows.value,
        threadId,
        known,
        serverPid: process.pid,
      });
      return new Map(members.map((row) => [row.pid, row.startedAt]));
    },
  );

  const endKnown = Effect.fn("ThreadProcesses.endKnown")(function* (
    threadId: string,
    known: Map<number, string>,
  ) {
    const readMembers = readRows.pipe(
      Effect.map((rows) => threadMembers({ rows, threadId: null, known, serverPid: process.pid })),
      Effect.tap((members) =>
        Effect.sync(() => {
          for (const row of members) known.set(row.pid, row.startedAt);
        }),
      ),
    );
    const first = yield* readMembers;
    if (first.length === 0) return;
    signal(first, "SIGTERM");
    const deadline = (yield* Clock.currentTimeMillis) + graceMs;
    while ((yield* Clock.currentTimeMillis) < deadline) {
      yield* Effect.sleep(POLL_MS);
      if ((yield* readMembers).length === 0) return;
    }
    const stubborn = yield* readMembers;
    signal(stubborn, "SIGKILL");
    // One of them can have forked in the moment before it died.
    yield* Effect.sleep(POLL_MS);
    const late = yield* readMembers;
    signal(late, "SIGKILL");
    yield* Effect.logInfo("Stop killed programs that outlived the grace period", {
      threadId,
      killed: stubborn.length + late.length,
    });
  });

  const endAll: ThreadProcessesShape["endAll"] = Effect.fn("ThreadProcesses.endAll")(
    function* (threadId, before) {
      if (before.size === 0) return;
      yield* endKnown(threadId, new Map(before));
    },
  );

  const members: ThreadProcessesShape["members"] = Effect.fn("ThreadProcesses.members")(
    function* (threadId) {
      if (process.env[AGENT_THREAD_ENV] === threadId) return [];
      const rows = yield* readRowsForStop;
      if (Option.isNone(rows)) return [];
      return threadMembers({
        rows: rows.value,
        threadId,
        known: sampled.get(threadId) ?? NOTHING,
        serverPid: process.pid,
      });
    },
  );

  const endOrphans: ThreadProcessesShape["endOrphans"] = Effect.fn("ThreadProcesses.endOrphans")(
    function* (threadId, before) {
      const watched = new Map(
        before.filter((row) => row.ppid !== 1).map((row) => [row.pid, row.startedAt]),
      );
      if (watched.size === 0) return;
      const deadline = (yield* Clock.currentTimeMillis) + orphanWindowMs;
      while (true) {
        const orphans = (yield* readRows).filter(
          (row) => row.ppid === 1 && watched.get(row.pid) === row.startedAt,
        );
        if (orphans.length > 0) {
          yield* endKnown(threadId, new Map(orphans.map((row) => [row.pid, row.startedAt])));
        }
        if ((yield* Clock.currentTimeMillis) >= deadline) return;
        yield* Effect.sleep(ORPHAN_POLL_MS);
      }
    },
  );

  const threadProcesses: ThreadProcessesShape = {
    snapshot,
    endAll,
    members,
    endOrphans,
    sampleWhileOpen,
  };
  return { ...threadProcesses, sample, sampleEveryInterval };
});

export const layer = Layer.effect(
  ThreadProcesses,
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return ThreadProcesses.defaultValue();
    const threadProcesses = yield* make();
    yield* threadProcesses.sampleEveryInterval.pipe(Effect.forkScoped);
    return threadProcesses;
  }),
).pipe(Layer.provide(ProcessRunner.layer));
