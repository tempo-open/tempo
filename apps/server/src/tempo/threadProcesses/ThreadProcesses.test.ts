// @effect-diagnostics nodeBuiltinImport:off -- the programs Stop must end are real processes.
import * as NodeChildProcess from "node:child_process";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { assert, describe, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { AGENT_THREAD_ENV } from "../../preview/PortScanner.ts";
import * as ProcessRunner from "../../processRunner.ts";
import {
  endingOrphans,
  endingThreadProcesses,
  make,
  parseProcessRows,
  ThreadProcesses,
  threadMembers,
  type ProcessRow,
} from "./ThreadProcesses.ts";

const row = (
  pid: number,
  ppid: number,
  threadId: string | null = null,
  shell = false,
): ProcessRow => ({
  pid,
  ppid,
  startedAt: `start-${pid}`,
  threadId,
  shell,
});

const pids = (rows: ReadonlyArray<ProcessRow>) =>
  rows.map((entry) => entry.pid).toSorted((a, b) => a - b);

describe("parseProcessRows", () => {
  it("reads a row's thread from its environment, which comes after its arguments", () => {
    const rows = parseProcessRows(
      [
        `  101  1 Mon Nov  2 22:58:33 2026     node server.js ${AGENT_THREAD_ENV}=other PATH=/bin ${AGENT_THREAD_ENV}=thread-a`,
        "  102 101 Mon Nov  2 22:58:34 2026     /bin/sh -c sleep 5",
        "",
        "not a process row",
      ].join("\n"),
    );

    assert.deepStrictEqual(rows, [
      {
        pid: 101,
        ppid: 1,
        startedAt: "Mon Nov  2 22:58:33 2026",
        threadId: "thread-a",
        shell: false,
      },
      {
        pid: 102,
        ppid: 101,
        startedAt: "Mon Nov  2 22:58:34 2026",
        threadId: null,
        shell: true,
      },
    ]);
  });
});

describe("threadMembers", () => {
  const members = (
    rows: ReadonlyArray<ProcessRow>,
    known: ReadonlyMap<number, string> = new Map(),
  ) => pids(threadMembers({ rows, threadId: "thread-a", known, serverPid: 10 }));

  it("takes what carries the thread's id and everything those started", () => {
    assert.deepStrictEqual(
      members([
        row(1, 0),
        row(10, 1),
        row(20, 10, "thread-a"),
        row(21, 20),
        row(22, 21),
        // Orphaned to launchd, in its own session, but it still carries the id.
        row(30, 1, "thread-a"),
        row(40, 10, "thread-b"),
        row(41, 40),
        row(50, 1),
      ]),
      [20, 21, 22, 30],
    );
  });

  it("keeps a snapshot's process once its parent is gone, but not a reused pid", () => {
    const known = new Map([
      [60, "start-60"],
      [61, "an earlier process"],
    ]);
    assert.deepStrictEqual(members([row(60, 1), row(61, 1)], known), [60]);
  });

  it("takes nothing by the id once Stop has read the thread, so the next agent is safe", () => {
    assert.deepStrictEqual(
      pids(
        threadMembers({
          rows: [row(70, 10, "thread-a"), row(71, 72), row(72, 1)],
          threadId: null,
          known: new Map([[72, "start-72"]]),
          serverPid: 10,
        }),
      ),
      [71, 72],
    );
  });

  it("takes the shells above a program with the id when they lead straight to launchd", () => {
    assert.deepStrictEqual(
      members([
        // `nohup sh -c 'while :; do python3 job.py; done' &`: macOS hides the shell's environment.
        row(80, 1, null, true),
        row(81, 80, null, true),
        row(82, 81, "thread-a"),
        row(83, 80),
      ]),
      [80, 81, 82, 83],
    );
  });

  it("leaves a shell whose chain ends at anything but launchd to its parent", () => {
    assert.deepStrictEqual(
      members([
        row(10, 1),
        // Codex's app server, which outlives Stop, runs commands under a shell like this.
        row(90, 10),
        row(91, 90, null, true),
        row(92, 91, "thread-a"),
        // A shell that is not above any program with the id.
        row(93, 1, null, true),
        // Not a shell, whatever its parent is.
        row(94, 1),
        row(95, 94, "thread-a"),
        // Another thread's shell is not this thread's to take.
        row(96, 1, "thread-b", true),
        row(97, 96, "thread-a"),
      ]),
      [92, 95, 97],
    );
  });

  it("never takes this server or what is above it, even when they carry the id", () => {
    assert.deepStrictEqual(
      members([row(1, 0), row(5, 1, "thread-a"), row(10, 5, "thread-a"), row(11, 10)]),
      [],
    );
  });
});

describe("endingThreadProcesses", () => {
  it.effect(
    "reads the thread before stopping it and ends its programs even if the stop fails",
    () =>
      Effect.gen(function* () {
        const steps = yield* Ref.make<ReadonlyArray<string>>([]);
        const note = (step: string) => Ref.update(steps, (all) => [...all, step]);
        const threadProcesses = {
          ...ThreadProcesses.defaultValue(),
          snapshot: () => note("snapshot").pipe(Effect.as(new Map([[1, "start"]]))),
          endAll: (_threadId: string, snapshot: ReadonlyMap<number, string>) =>
            note(`end ${snapshot.size}`),
        };
        const scope = yield* Scope.make();

        const stop = yield* endingThreadProcesses({
          threadProcesses,
          threadId: "thread-a",
          scope,
          stop: note("stop").pipe(Effect.andThen(Effect.fail("not stopped"))),
        }).pipe(Effect.flip);
        yield* Scope.close(scope, yield* Effect.exit(Effect.void));

        assert.strictEqual(stop, "not stopped");
        assert.deepStrictEqual(yield* Ref.get(steps), ["snapshot", "stop", "end 1"]);
      }),
  );
});

describe("endingOrphans", () => {
  it.effect("reads the thread before the stop and watches it after, even if the stop fails", () =>
    Effect.gen(function* () {
      const steps = yield* Ref.make<ReadonlyArray<string>>([]);
      const note = (step: string) => Ref.update(steps, (all) => [...all, step]);
      const threadProcesses = {
        ...ThreadProcesses.defaultValue(),
        members: () => note("members").pipe(Effect.as([row(1, 2)])),
        endOrphans: (_threadId: string, before: ReadonlyArray<ProcessRow>) =>
          note(`orphans of ${before.length}`),
      };
      const scope = yield* Scope.make();

      const stop = yield* endingOrphans({
        threadProcesses,
        threadId: "thread-a",
        scope,
        stop: note("stop").pipe(Effect.andThen(Effect.fail("not stopped"))),
      }).pipe(Effect.flip);
      yield* Scope.close(scope, yield* Effect.exit(Effect.void));

      assert.strictEqual(stop, "not stopped");
      assert.deepStrictEqual(yield* Ref.get(steps), ["members", "stop", "orphans of 1"]);
    }),
  );
});

describe("reading the process list", () => {
  const list = (lines: ReadonlyArray<string>) => ({
    stdout: lines.join("\n"),
    stderr: "",
    code: 0,
    signal: null,
    timedOut: false,
    stdoutTruncated: false,
    stderrTruncated: false,
  });
  const line = (pid: number, ppid: number, rest: string) =>
    `${pid} ${ppid} Mon Nov  2 22:58:33 2026 ${rest}`;

  it.effect("tries once more when a read fails", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const threadProcesses = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () =>
            Ref.updateAndGet(reads, (count) => count + 1).pipe(
              Effect.flatMap((count) =>
                count === 1
                  ? Effect.fail(
                      new ProcessRunner.ProcessTimeoutError({
                        command: "ps",
                        argumentCount: 0,
                        timeoutMs: 1,
                      }),
                    )
                  : Effect.succeed(list([line(70_001, 1, `node ${AGENT_THREAD_ENV}=thread-a`)])),
              ),
            ),
        } as unknown as ProcessRunner.ProcessRunner["Service"]),
      );
      const snapshot = yield* threadProcesses.snapshot("thread-a");
      assert.deepStrictEqual([...snapshot.keys()], [70_001]);
      assert.strictEqual(yield* Ref.get(reads), 2);
    }),
  );

  it.effect("stops on the last sample when a loaded Mac cannot answer in time", () =>
    Effect.gen(function* () {
      const answering = yield* Ref.make(true);
      const threadProcesses = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () =>
            Ref.get(answering).pipe(
              Effect.flatMap((yes) =>
                yes
                  ? Effect.succeed(
                      list([
                        line(70_010, 1, `node ${AGENT_THREAD_ENV}=thread-a`),
                        line(70_011, 70_010, "/bin/sh -c sleep 100"),
                      ]),
                    )
                  : Effect.never,
              ),
            ),
        } as unknown as ProcessRunner.ProcessRunner["Service"]),
      );
      yield* threadProcesses.sample;
      yield* Ref.set(answering, false);

      const snapshot = yield* threadProcesses.snapshot("thread-a").pipe(Effect.forkChild);
      yield* TestClock.adjust("5 seconds");
      assert.deepStrictEqual(
        [...(yield* Fiber.join(snapshot)).keys()].toSorted((a, b) => a - b),
        [70_010, 70_011],
      );
    }),
  );

  it.effect("keeps what a sample saw when a read comes back empty", () =>
    Effect.gen(function* () {
      const rows = yield* Ref.make<ReadonlyArray<string>>([
        line(70_020, 1, `node ${AGENT_THREAD_ENV}=thread-a`),
      ]);
      const threadProcesses = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Ref.get(rows).pipe(Effect.map(list)),
        } as unknown as ProcessRunner.ProcessRunner["Service"]),
      );
      yield* threadProcesses.sample;
      yield* Ref.set(rows, []);
      yield* threadProcesses.sample;
      assert.deepStrictEqual([...(yield* threadProcesses.snapshot("thread-a")).keys()], [70_020]);
    }),
  );

  it.effect("samples only while a session is open", () =>
    Effect.gen(function* () {
      const reads = yield* Ref.make(0);
      const threadProcesses = yield* make().pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, {
          run: () => Ref.update(reads, (count) => count + 1).pipe(Effect.as(list([]))),
        } as unknown as ProcessRunner.ProcessRunner["Service"]),
      );
      yield* threadProcesses.sampleEveryInterval.pipe(Effect.forkScoped);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(yield* Ref.get(reads), 0);

      const session = yield* Scope.make();
      yield* threadProcesses.sampleWhileOpen.pipe(Effect.provideService(Scope.Scope, session));
      yield* TestClock.adjust("20 seconds");
      assert.strictEqual(yield* Ref.get(reads), 2);

      yield* Scope.close(session, Exit.void);
      yield* TestClock.adjust("30 seconds");
      assert.strictEqual(yield* Ref.get(reads), 2);
    }).pipe(Effect.scoped),
  );
});

const onMac = HostProcess.Platform.defaultValue() === "darwin";

/**
 * Starts a program the way a command might: in a new session, under a parent that exits at once so
 * launchd adopts it, or under one that stays while the program runs with no environment at all.
 * The stdout pipe stays open for as long as the program lives; `ready` is the program's pid.
 */
const startProgram = (input: {
  readonly threadId: string;
  readonly ignoreTerm?: boolean;
  readonly parentStays?: boolean;
}) => {
  const program = `${input.ignoreTerm === true ? "process.on('SIGTERM', () => {});" : ""}
    console.log(process.pid); setInterval(() => {}, 1000);`;
  const parent = `
    const { spawn } = require("node:child_process");
    spawn(process.execPath, ["-e", ${JSON.stringify(program)}], {
      detached: true,
      stdio: ["ignore", "inherit", "ignore"],
      env: ${input.parentStays === true ? "{}" : "process.env"},
    }).unref();
    ${input.parentStays === true ? "setInterval(() => {}, 1000);" : ""}`;
  const launched = NodeChildProcess.spawn(process.execPath, ["-e", parent], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: { ...process.env, [AGENT_THREAD_ENV]: input.threadId },
  });
  const ready = new Promise<number>((resolve) => {
    launched.stdout.once("data", (chunk: Buffer) => resolve(Number(chunk.toString().trim())));
  });
  const ended = new Promise<void>((resolve) => {
    launched.stdout.once("close", () => resolve());
  });
  return { launched, ready, ended };
};

const exited = (child: NodeChildProcess.ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve();
    else child.once("exit", () => resolve());
  });

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const layerRunner = ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer));

describe.skipIf(!onMac)("ThreadProcesses on a Mac", () => {
  let threadCount = 0;
  const uniqueThread = () => `reliability-test-${process.pid}-${(threadCount += 1)}`;

  it.live("ends a program that moved to its own session, and leaves another thread's alone", () =>
    Effect.gen(function* () {
      const threadId = uniqueThread();
      const escaped = startProgram({ threadId });
      const bystander = startProgram({ threadId: uniqueThread() });
      const bystanderPid = yield* Effect.promise(() => bystander.ready);
      yield* Effect.addFinalizer(() => Effect.sync(() => process.kill(bystanderPid, "SIGKILL")));
      yield* Effect.promise(() => escaped.ready);

      const threadProcesses = yield* make();
      yield* threadProcesses.endAll(threadId, yield* threadProcesses.snapshot(threadId));

      yield* Effect.promise(() => escaped.ended);
      assert.isTrue(isAlive(bystanderPid));
    }).pipe(Effect.scoped, Effect.provide(layerRunner)),
  );

  it.live("ends a program with no thread id whose parent is gone, from the earlier tree walk", () =>
    Effect.gen(function* () {
      const threadId = uniqueThread();
      const hidden = startProgram({ threadId, parentStays: true });
      yield* Effect.promise(() => hidden.ready);

      const threadProcesses = yield* make();
      const snapshot = yield* threadProcesses.snapshot(threadId);
      hidden.launched.kill("SIGKILL");
      yield* threadProcesses.endAll(threadId, snapshot);

      yield* Effect.promise(() => hidden.ended);
    }).pipe(Effect.provide(layerRunner)),
  );

  it.live("ends a sampled program with no thread id after it moved to launchd", () =>
    Effect.gen(function* () {
      const threadId = uniqueThread();
      const hidden = startProgram({ threadId, parentStays: true });
      yield* Effect.promise(() => hidden.ready);

      const threadProcesses = yield* make();
      yield* threadProcesses.sample;
      hidden.launched.kill("SIGKILL");
      yield* Effect.promise(() => exited(hidden.launched));
      yield* threadProcesses.endAll(threadId, yield* threadProcesses.snapshot(threadId));

      yield* Effect.promise(() => hidden.ended);
    }).pipe(Effect.provide(layerRunner)),
  );

  it.live("ends a daemon's macOS shell, so it cannot start its program again", () =>
    Effect.gen(function* () {
      const threadId = uniqueThread();
      // The shell shows no environment and launchd is its parent; only its program shows the id.
      const script = `while :; do ${JSON.stringify(process.execPath)} -e 'console.log(process.pid); setInterval(() => {}, 1000)'; done`;
      const parent = `
        const { spawn } = require("node:child_process");
        spawn("/bin/sh", ["-c", ${JSON.stringify(script)}], {
          detached: true,
          stdio: ["ignore", "inherit", "ignore"],
        }).unref();`;
      const launched = NodeChildProcess.spawn(process.execPath, ["-e", parent], {
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, [AGENT_THREAD_ENV]: threadId },
      });
      const ended = new Promise<void>((resolve) => {
        launched.stdout.once("close", () => resolve());
      });
      yield* Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            launched.stdout.once("data", () => resolve());
          }),
      );
      yield* Effect.promise(() => exited(launched));

      const threadProcesses = yield* make();
      yield* threadProcesses.endAll(threadId, yield* threadProcesses.snapshot(threadId));

      yield* Effect.promise(() => ended);
    }).pipe(Effect.provide(layerRunner)),
  );

  it.live("ends what a stopped agent left at launchd, and what was there before stays", () =>
    Effect.gen(function* () {
      const threadId = uniqueThread();
      const left = startProgram({ threadId, parentStays: true });
      yield* Effect.promise(() => left.ready);
      // A server the agent started earlier: it was at launchd before anything was stopped.
      const earlier = startProgram({ threadId });
      const earlierPid = yield* Effect.promise(() => earlier.ready);
      yield* Effect.addFinalizer(() => Effect.sync(() => process.kill(earlierPid, "SIGKILL")));
      yield* Effect.promise(() => exited(earlier.launched));

      const threadProcesses = yield* make({ orphanWindowMs: 2_000 });
      const before = yield* threadProcesses.members(threadId);
      left.launched.kill("SIGKILL");
      yield* threadProcesses.endOrphans(threadId, before);

      yield* Effect.promise(() => left.ended);
      assert.isTrue(isAlive(earlierPid));
    }).pipe(Effect.scoped, Effect.provide(layerRunner)),
  );

  it.live("kills a program that ignores SIGTERM once the grace period ends", () =>
    Effect.gen(function* () {
      const threadId = uniqueThread();
      const stubborn = startProgram({ threadId, ignoreTerm: true });
      yield* Effect.promise(() => stubborn.ready);

      const threadProcesses = yield* make({ graceMs: 300 });
      yield* threadProcesses.endAll(threadId, yield* threadProcesses.snapshot(threadId));

      yield* Effect.promise(() => stubborn.ended);
    }).pipe(Effect.provide(layerRunner)),
  );
});
