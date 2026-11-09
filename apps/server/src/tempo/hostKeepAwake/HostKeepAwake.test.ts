import { describe, expect, it } from "@effect/vitest";
import { DEFAULT_SERVER_SETTINGS, RunId, type ServerSettings, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/process";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettingsService from "../../serverSettings.ts";
import * as HostKeepAwake from "./HostKeepAwake.ts";

const CAFFEINATE = `/usr/bin/caffeinate -s -w ${process.pid}`;
const CAFFEINATE_TURN = `/usr/bin/caffeinate -i -w ${process.pid}`;
const LID_ON = "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 1";
const LID_OFF = "/usr/bin/sudo -n /usr/bin/pmset -a disablesleep 0";

/**
 * A host with a stored tunnel config while `tunnel` holds, settings pushed through `settings`,
 * and a spawner that reports each process start and stop, in order, on `events`.
 */
const makeHost = Effect.fn("test.makeKeepAwakeHost")(function* (input: {
  readonly platform: NodeJS.Platform;
  readonly tunnel: boolean;
  readonly turnRunning?: boolean;
  readonly sudoAllowed?: boolean;
  readonly devUrl?: URL;
}) {
  const events = yield* Queue.unbounded<string>();
  // pmset and its watchdog, apart from `events`: a host runs them whether or not sudo allows it.
  const lidEvents = yield* Queue.unbounded<string>();
  const turnRunning = yield* Ref.make(input.turnRunning ?? false);
  const backgroundWork = yield* Ref.make(false);
  const backgroundSince = yield* Ref.make<DateTime.Utc | null>(null);
  const limitCandidates = yield* Ref.make<
    ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>
  >([]);
  const settings = yield* Queue.unbounded<ServerSettings>();
  const tunnel = yield* Ref.make(input.tunnel);
  const secretReads = yield* Ref.make(0);
  const spawner = ChildProcessSpawner.make((command) => {
    const { command: executable, args } = command as unknown as {
      readonly command: string;
      readonly args: ReadonlyArray<string>;
    };
    const line = [executable, ...args].join(" ");
    if (executable === "/usr/bin/sudo") {
      return Queue.offer(lidEvents, line).pipe(
        Effect.as(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(4243),
            exitCode: Effect.succeed(
              ChildProcessSpawner.ExitCode(input.sudoAllowed === true ? 0 : 1),
            ),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      );
    }
    const log = executable === "/bin/sh" ? lidEvents : events;
    const name = executable === "/bin/sh" ? `watchdog of ${args.at(-1)}` : line;
    return Queue.offer(log, `start ${name}`).pipe(
      Effect.andThen(Effect.addFinalizer(() => Queue.offer(log, `stop ${name}`))),
      Effect.as(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.empty,
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
  });
  const layer = HostKeepAwake.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          hasRunningTurn: Ref.get(turnRunning),
          hasAwaitedBackgroundWork: (since) =>
            Ref.set(backgroundSince, since).pipe(Effect.andThen(Ref.get(backgroundWork))),
          getLimitRecoveryCandidates: () => Ref.get(limitCandidates),
        }),
        Layer.succeed(ServerConfig.ServerConfig, {
          devUrl: input.devUrl,
        } as ServerConfig.ServerConfig["Service"]),
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
          subscribeChanges: Effect.succeed(Stream.fromQueue(settings)),
        }),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: (name) =>
            Ref.update(secretReads, (count) => count + 1).pipe(
              Effect.andThen(Ref.get(tunnel)),
              Effect.map((present) =>
                present && name === "cloud-endpoint-runtime-config"
                  ? Option.some(new Uint8Array([1]))
                  : Option.none(),
              ),
            ),
        }),
      ),
    ),
    Layer.provide(Layer.succeed(HostProcess.Platform, input.platform)),
  );
  const setKeepAwake = (enabled: boolean) =>
    Queue.offer(settings, { ...DEFAULT_SERVER_SETTINGS, tempoKeepAwakeOnPower: enabled });
  return {
    layer,
    events,
    lidEvents,
    tunnel,
    turnRunning,
    backgroundWork,
    backgroundSince,
    limitCandidates,
    secretReads,
    setKeepAwake,
  };
});

const limitCandidate = (input: {
  readonly resetAt?: string | null;
  readonly completedAt?: DateTime.Utc | null;
  readonly autoResume?: boolean;
  readonly snoozedUntil?: DateTime.Utc;
}) =>
  ({
    id: ThreadId.make("thread"),
    latestRunId: RunId.make("run"),
    usageLimitResetAt: input.resetAt ?? null,
    latestRunCompletedAt: input.completedAt ?? null,
    limitRecovery:
      input.autoResume === undefined
        ? null
        : {
            runId: RunId.make("run"),
            resetAt: input.resetAt ?? null,
            autoResume: input.autoResume,
          },
    snoozedUntil: input.snoozedUntil ?? null,
  }) as unknown as ProjectionStore.ProjectionLimitRecoveryCandidate;

describe("recoveryNeedsAwakeMac", () => {
  const now = DateTime.makeUnsafe("2026-11-03T12:00:00.000Z");
  const nowMs = DateTime.toEpochMillis(now);
  const ago = (minutes: number) => DateTime.subtract(now, { minutes });
  const iso = (minutes: number) => DateTime.formatIso(DateTime.add(now, { minutes }));
  const holds = (input: {
    readonly limits?: ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>;
  }) => HostKeepAwake.recoveryNeedsAwakeMac({ nowMs, limits: [], ...input });

  it("holds for a limit that resets within 6 hours, and 15 minutes past it", () => {
    expect(holds({ limits: [limitCandidate({ resetAt: iso(5 * 60) })] })).toBe(true);
    expect(holds({ limits: [limitCandidate({ resetAt: iso(7 * 60) })] })).toBe(false);
    expect(holds({ limits: [limitCandidate({ resetAt: iso(-14) })] })).toBe(true);
    expect(holds({ limits: [limitCandidate({ resetAt: iso(-16) })] })).toBe(false);
  });

  it("holds for a limit with no reset for an hour", () => {
    expect(holds({ limits: [limitCandidate({ completedAt: ago(59) })] })).toBe(true);
    expect(holds({ limits: [limitCandidate({ completedAt: ago(61) })] })).toBe(false);
  });

  it("does not hold for a limit someone chose not to resume, or snoozed", () => {
    expect(holds({ limits: [limitCandidate({ resetAt: iso(10), autoResume: false })] })).toBe(
      false,
    );
    expect(
      holds({
        limits: [
          limitCandidate({ resetAt: iso(10), snoozedUntil: DateTime.add(now, { hours: 1 }) }),
        ],
      }),
    ).toBe(false);
  });
});

describe("HostKeepAwake", () => {
  it.effect("keeps a Mac with a tunnel awake until the setting is turned off", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "darwin", tunnel: true });
      yield* Layer.build(host.layer);
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE}`);

      yield* host.setKeepAwake(false);
      expect(yield* Queue.take(host.events)).toBe(`stop ${CAFFEINATE}`);

      yield* host.setKeepAwake(true);
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE}`);
    }).pipe(Effect.scoped),
  );

  it.effect("starts once a tunnel is set up, and lets go when it is removed", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "darwin", tunnel: false });
      yield* Layer.build(host.layer);
      yield* Ref.set(host.tunnel, true);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE}`);

      yield* Ref.set(host.tunnel, false);
      yield* TestClock.adjust("1 minute");
      expect(yield* Queue.take(host.events)).toBe(`stop ${CAFFEINATE}`);
    }).pipe(Effect.scoped),
  );

  it.effect("holds idle sleep off only while a turn is running, with or without a tunnel", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "darwin", tunnel: false, turnRunning: true });
      yield* Layer.build(host.layer);
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);

      yield* Ref.set(host.turnRunning, false);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.events)).toBe(`stop ${CAFFEINATE_TURN}`);

      yield* Ref.set(host.turnRunning, true);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);
    }).pipe(Effect.scoped),
  );

  it.effect("holds a Mac awake for a settled turn's awaited work, as of 12 hours back", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "darwin", tunnel: false });
      yield* Layer.build(host.layer);
      yield* Ref.set(host.backgroundWork, true);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);
      const now = yield* DateTime.now;
      expect(
        DateTime.toEpochMillis(now) -
          DateTime.toEpochMillis((yield* Ref.get(host.backgroundSince))!),
      ).toBe(12 * 60 * 60 * 1000);

      yield* Ref.set(host.backgroundWork, false);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.events)).toBe(`stop ${CAFFEINATE_TURN}`);
    }).pipe(Effect.scoped),
  );

  it.effect("turns lid sleep off for the hold and back on after, with a watchdog between", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "darwin", tunnel: false, sudoAllowed: true });
      yield* Layer.build(host.layer);
      yield* TestClock.adjust("1 second");
      // No turn is running at start, so whatever a killed server left set is cleared.
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_OFF);

      yield* Ref.set(host.turnRunning, true);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_ON);
      expect(yield* Queue.take(host.lidEvents)).toBe(`start watchdog of ${process.pid}`);

      yield* Ref.set(host.turnRunning, false);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.lidEvents)).toBe(`stop watchdog of ${process.pid}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_OFF);
      expect(yield* Queue.take(host.events)).toBe(`stop ${CAFFEINATE_TURN}`);
    }).pipe(Effect.scoped),
  );

  it.effect("lets the lid sleep after 12 hours in one hold, and keeps caffeinate", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({
        platform: "darwin",
        tunnel: false,
        turnRunning: true,
        sudoAllowed: true,
      });
      yield* Layer.build(host.layer);
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_ON);
      expect(yield* Queue.take(host.lidEvents)).toBe(`start watchdog of ${process.pid}`);

      yield* TestClock.adjust("12 hours");
      expect(yield* Queue.take(host.lidEvents)).toBe(`stop watchdog of ${process.pid}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_OFF);
      expect(yield* Queue.size(host.events)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("releases lid sleep when the server shuts down mid turn", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({
        platform: "darwin",
        tunnel: false,
        turnRunning: true,
        sudoAllowed: true,
      });
      yield* Effect.scoped(
        Layer.build(host.layer).pipe(
          Effect.andThen(Queue.take(host.events)),
          Effect.tap((event) => Effect.sync(() => expect(event).toBe(`start ${CAFFEINATE_TURN}`))),
        ),
      );
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_ON);
      expect(yield* Queue.take(host.lidEvents)).toBe(`start watchdog of ${process.pid}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(`stop watchdog of ${process.pid}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_OFF);
    }),
  );

  it.effect("still holds caffeinate where sudo asks for a password, and starts no watchdog", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "darwin", tunnel: false, turnRunning: true });
      yield* Layer.build(host.layer);
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);
      expect(yield* Queue.take(host.lidEvents)).toBe(LID_ON);
      expect(yield* Queue.size(host.lidEvents)).toBe(0);

      yield* Ref.set(host.turnRunning, false);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(host.events)).toBe(`stop ${CAFFEINATE_TURN}`);
      expect(yield* Queue.size(host.lidEvents)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves lid sleep alone in a development copy", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({
        platform: "darwin",
        tunnel: false,
        turnRunning: true,
        sudoAllowed: true,
        devUrl: new URL("http://localhost:5733"),
      });
      yield* Layer.build(host.layer);
      expect(yield* Queue.take(host.events)).toBe(`start ${CAFFEINATE_TURN}`);
      expect(yield* Queue.size(host.lidEvents)).toBe(0);
    }).pipe(Effect.scoped),
  );

  it.effect("does nothing off a Mac", () =>
    Effect.gen(function* () {
      const host = yield* makeHost({ platform: "linux", tunnel: true, turnRunning: true });
      yield* Layer.build(host.layer);
      yield* TestClock.adjust("5 minutes");
      expect(yield* Ref.get(host.secretReads)).toBe(0);
      expect(yield* Queue.size(host.events)).toBe(0);
    }).pipe(Effect.scoped),
  );
});
