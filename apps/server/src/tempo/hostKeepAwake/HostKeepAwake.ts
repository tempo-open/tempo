/**
 * tempo: with a tunnel and `tempoKeepAwakeOnPower`, `caffeinate -s` keeps the Mac awake on AC power. While
 * a thread has work going, `caffeinate -i` stops idle sleep too, and `pmset disablesleep` holds off
 * lid sleep where sudoers allows it. Nothing asks for a password. These end with this server.
 */
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import { CLOUD_ENDPOINT_RUNTIME_CONFIG } from "../../cloud/config.ts";
import * as ServerConfig from "../../config.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../../serverSettings.ts";

/** How soon a tunnel being set up or removed is noticed; the setting is noticed at once. */
const TUNNEL_CHECK_INTERVAL = "1 minute";
/** How soon a turn starting or ending is noticed; idle sleep takes minutes to come. */
const RUNNING_TURN_CHECK_INTERVAL = "10 seconds";
/** How long the assertion waits to be taken again after caffeinate failed or ended. */
const RETRY_DELAY = "1 minute";
/** Awaited background work with no news for this long is taken as stuck, and the Mac may sleep. */
const BACKGROUND_WORK_HOLD_MS = 12 * 60 * 60 * 1000;
/** A usage limit holds the Mac awake only when it resets this soon; weekly limits do not. */
const LIMIT_RESET_HOLD_MS = 6 * 60 * 60 * 1000;
/** How long past its reset a limited thread may take to continue before the hold lets go. */
const LIMIT_RESET_GRACE_MS = 15 * 60 * 1000;
/** A limit that names no reset is rechecked against fresh quota for this long. */
const UNKNOWN_LIMIT_RESET_HOLD_MS = 60 * 60 * 1000;
/** A closed lid stays awake this long in one hold, so a stuck turn cannot cook a Mac in a bag. */
const LID_HOLD_LIMIT = "12 hours";
const PMSET_TIMEOUT = "10 seconds";
const SUDO = "/usr/bin/sudo";
const PMSET = "/usr/bin/pmset";
// Exactly the command the sudoers line allows, run once this server is gone by any means.
const LID_WATCHDOG = `while kill -0 "$1" 2>/dev/null; do /bin/sleep 5; done; exec ${SUDO} -n ${PMSET} -a disablesleep 0`;

/** tempo: whether a limited thread is about to continue by itself, which needs the Mac awake. */
export function recoveryNeedsAwakeMac(input: {
  readonly nowMs: number;
  readonly limits: ReadonlyArray<ProjectionStore.ProjectionLimitRecoveryCandidate>;
}): boolean {
  const { nowMs } = input;
  const since = (at: DateTime.Utc | null | undefined) =>
    at == null ? Number.POSITIVE_INFINITY : nowMs - DateTime.toEpochMillis(at);
  return input.limits.some((thread) => {
    if (
      (thread.limitRecovery?.runId === thread.latestRunId &&
        thread.limitRecovery?.autoResume === false) ||
      since(thread.snoozedUntil) < 0
    )
      return false;
    const resetMs = Date.parse(thread.usageLimitResetAt ?? "");
    return Number.isFinite(resetMs)
      ? resetMs - nowMs < LIMIT_RESET_HOLD_MS && nowMs - resetMs < LIMIT_RESET_GRACE_MS
      : since(thread.latestRunCompletedAt) < UNKNOWN_LIMIT_RESET_HOLD_MS;
  });
}

const runCaffeinate = Effect.fn("HostKeepAwake.runCaffeinate")(function* (assertion: "-s" | "-i") {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const caffeinate = yield* spawner.spawn(
    ChildProcess.make("/usr/bin/caffeinate", [assertion, "-w", String(process.pid)], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  yield* caffeinate.exitCode;
}, Effect.scoped);

/** Holds the assertion for as long as it runs, and takes it again if caffeinate ends. */
const holdAwake = (assertion: "-s" | "-i") =>
  runCaffeinate(assertion).pipe(
    Effect.catch((cause) => Effect.logWarning("Could not keep this Mac awake.", { cause })),
    Effect.andThen(Effect.sleep(RETRY_DELAY)),
    Effect.forever,
  );

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    if ((yield* HostProcess.Platform) !== "darwin") return;
    const settings = yield* ServerSettings.ServerSettingsService;
    const secrets = yield* ServerSecretStore.ServerSecretStore;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const { devUrl } = yield* ServerConfig.ServerConfig;
    const wanted = yield* SubscriptionRef.make({
      enabled: false,
      tunnel: false,
      autoResumeLimited: true,
    });
    const workGoing = yield* SubscriptionRef.make(false);

    // Reading the settings loads every stored secret, so the switch follows their changes.
    const noteEnabled = (current: {
      readonly tempoKeepAwakeOnPower: boolean;
      readonly autoResumeLimitedThreads: boolean;
    }) =>
      SubscriptionRef.update(wanted, (state) => ({
        ...state,
        enabled: current.tempoKeepAwakeOnPower,
        autoResumeLimited: current.autoResumeLimitedThreads,
      }));
    const settingsChanges = yield* settings.subscribeChanges;
    yield* settings.getSettings.pipe(
      Effect.flatMap(noteEnabled),
      Effect.catch((cause) => Effect.logWarning("keep awake could not read settings", { cause })),
    );
    yield* Stream.runForEach(settingsChanges, noteEnabled).pipe(Effect.forkScoped);

    yield* secrets.get(CLOUD_ENDPOINT_RUNTIME_CONFIG).pipe(
      Effect.map(Option.isSome),
      Effect.orElseSucceed(() => false),
      Effect.flatMap((tunnel) => SubscriptionRef.update(wanted, (state) => ({ ...state, tunnel }))),
      Effect.repeat(Schedule.spaced(TUNNEL_CHECK_INTERVAL)),
      Effect.forkScoped,
    );

    yield* SubscriptionRef.changes(wanted).pipe(
      Stream.map(({ enabled, tunnel }) => enabled && tunnel),
      Stream.changes,
      Stream.switchMap((awake) => (awake ? Stream.fromEffect(holdAwake("-s")) : Stream.empty)),
      Stream.runDrain,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkScoped,
    );

    let notedNoSudo = false;
    /** Whether sudo ran it. A development copy leaves this to the installed app. */
    const setLidSleepDisabled = (value: "0" | "1") =>
      devUrl !== undefined
        ? Effect.succeed(false)
        : Effect.scoped(
            spawner
              .spawn(
                ChildProcess.make(SUDO, ["-n", PMSET, "-a", "disablesleep", value], {
                  stdin: "ignore",
                  stdout: "ignore",
                  stderr: "ignore",
                }),
              )
              .pipe(
                Effect.flatMap((sudo) => sudo.exitCode),
                Effect.map((code) => Number(code) === 0),
              ),
          ).pipe(
            Effect.timeoutOption(PMSET_TIMEOUT),
            Effect.map((ran) => Option.getOrElse(ran, () => false)),
            Effect.orElseSucceed(() => false),
            Effect.tap((ran) =>
              ran || notedNoSudo
                ? Effect.void
                : Effect.logInfo(
                    "A closed lid still sleeps this Mac during a turn: sudo does not allow pmset without a password.",
                  ).pipe(
                    Effect.andThen(
                      Effect.sync(() => {
                        notedNoSudo = true;
                      }),
                    ),
                  ),
            ),
          );

    // pmset where sudo allows it, up to the limit; the watchdog ends with the hold.
    const holdLidAwake = Effect.scoped(
      Effect.gen(function* () {
        const held = yield* Effect.acquireRelease(setLidSleepDisabled("1"), (ran) =>
          ran ? setLidSleepDisabled("0") : Effect.void,
        );
        if (!held) return;
        yield* spawner
          .spawn(
            ChildProcess.make(
              "/bin/sh",
              ["-c", LID_WATCHDOG, "tempo-lid-watchdog", String(process.pid)],
              { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
            ),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not start the closed lid watchdog.", { cause }),
            ),
          );
        yield* Effect.sleep(LID_HOLD_LIMIT);
      }),
    );

    const readWorkGoing = Effect.gen(function* () {
      if (yield* projections.hasRunningTurn) return true;
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      if (
        yield* projections.hasAwaitedBackgroundWork(
          DateTime.subtract(now, { milliseconds: BACKGROUND_WORK_HOLD_MS }),
        )
      ) {
        return true;
      }
      const { autoResumeLimited } = yield* SubscriptionRef.get(wanted);
      return recoveryNeedsAwakeMac({
        nowMs,
        limits: autoResumeLimited
          ? yield* projections.getLimitRecoveryCandidates({
              now,
              autoResume: true,
              snooze: false,
              quotaRecovery: true,
            })
          : [],
      });
    }).pipe(
      Effect.orElseSucceed(() => false),
      Effect.withTracerEnabled(false),
    );

    // A server that was killed mid turn cannot have released it; a turn it recovers takes it again.
    if (!(yield* readWorkGoing)) yield* setLidSleepDisabled("0").pipe(Effect.forkScoped);

    yield* readWorkGoing.pipe(
      Effect.flatMap((going) => SubscriptionRef.set(workGoing, going)),
      Effect.repeat(Schedule.spaced(RUNNING_TURN_CHECK_INTERVAL)),
      Effect.forkScoped,
    );

    yield* SubscriptionRef.changes(workGoing).pipe(
      Stream.changes,
      Stream.switchMap((awake) =>
        awake
          ? Stream.fromEffect(
              Effect.all([holdLidAwake, holdAwake("-i")], { concurrency: "unbounded" }),
            )
          : Stream.empty,
      ),
      Stream.runDrain,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.forkScoped,
    );
  }),
);
