/**
 * tempo: iOS simulators Tempo boots come up slim. simslim (https://github.com/MobAI-App/simslim,
 * MIT) writes launchd overrides into a simulator's own launchd database that turn off about 170
 * background daemons. Tempo records the simulators it slimmed so `tempoSlimSimulators` off restores them.
 */
import type { DevicePlatform } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { DeviceHostReady } from "../../device/DeviceHost.ts";
import * as ProcessRunner from "../../processRunner.ts";

export const SIMSLIM_VERSION = "0.13.0";
const SIMSLIM_ARCHIVE = {
  url: `https://github.com/MobAI-App/simslim/releases/download/v${SIMSLIM_VERSION}/simslim-v${SIMSLIM_VERSION}-macos-arm64.tar.gz`,
  sha256: "76807efb5beb57b73b40959eea04defe21fc18265811a495db1509b5e7be07c1",
};

/**
 * Categories left on, so app tests keep what they commonly need: push and StoreKit (`store`),
 * universal links (`web`), Recents in Files and the document picker (`search`), and the photo
 * picker and Photos library (`photos`). Each idles at 50-80 MB, against about 3 GB saved.
 */
const SIMSLIM_KEPT_CATEGORIES = "store,web,search,photos";

// simslim gives up on its own first; the runner's limit only stops a hung process.
const SIMSLIM_BOOT_TIMEOUT = "150s";
const SIMSLIM_RUN_TIMEOUT_MS = 180_000;

class SimSlimInstallError extends Schema.TaggedError<SimSlimInstallError>()("SimSlimInstallError", {
  step: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Installing simslim failed while ${this.step}.`;
  }
}

const installLock = Semaphore.makeUnsafe(1);

/**
 * The pinned simslim binary under the Tempo home, checksummed before it is unpacked; null off Apple
 * silicon Macs. A file Node writes has no quarantine flag, so Gatekeeper never assesses the
 * ad-hoc-signed binary; macOS tar would copy a flag on the archive onto it.
 */
export const ensureSimSlim = Effect.fn("SimSlim.ensure")(function* (
  baseDir: string,
  archive: { readonly url: string; readonly sha256: string } = SIMSLIM_ARCHIVE,
) {
  if ((yield* HostProcess.Platform) !== "darwin" || (yield* HostProcess.Architecture) !== "arm64")
    return null;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installDir = path.join(baseDir, "tools", "simslim", SIMSLIM_VERSION);
  const binary = path.join(installDir, "simslim");
  const installed = Effect.all([
    fs.exists(binary),
    fs.readFileString(path.join(installDir, ".install-complete")),
  ]).pipe(
    Effect.map(([exists, sentinel]) => exists && sentinel.trim() === SIMSLIM_VERSION),
    Effect.orElseSucceed(() => false),
  );
  if (yield* installed) return binary;
  return yield* installLock.withPermit(
    Effect.gen(function* () {
      if (yield* installed) return binary;
      const http = yield* HttpClient.HttpClient;
      const crypto = yield* Crypto.Crypto;
      const runner = yield* ProcessRunner.ProcessRunner;
      const fail = (step: string) => (cause: unknown) => new SimSlimInstallError({ step, cause });
      const bytes = yield* http.execute(HttpClientRequest.get(archive.url)).pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.timeout("1 minute"),
        Effect.map((buffer) => new Uint8Array(buffer)),
        Effect.mapError(fail("downloading the release")),
      );
      const digest = yield* crypto
        .digest("SHA-256", bytes)
        .pipe(Effect.mapError(fail("verifying the download")));
      if (Hex.encode(digest) !== archive.sha256) {
        return yield* new SimSlimInstallError({ step: "verifying the download" });
      }
      yield* fs
        .remove(installDir, { recursive: true, force: true })
        .pipe(Effect.mapError(fail("removing an incomplete install")));
      yield* fs
        .makeDirectory(path.dirname(installDir), { recursive: true })
        .pipe(Effect.mapError(fail("preparing the install directory")));
      const staging = yield* fs
        .makeTempDirectory({ directory: path.dirname(installDir), prefix: ".staging-" })
        .pipe(Effect.mapError(fail("preparing the install directory")));
      return yield* Effect.gen(function* () {
        const archivePath = path.join(staging, "simslim.tar.gz");
        yield* fs.writeFile(archivePath, bytes).pipe(Effect.mapError(fail("writing the download")));
        const extracted = yield* runner
          .run({
            command: "tar",
            args: ["-xzf", archivePath, "-C", staging, "simslim"],
            timeout: "1 minute",
          })
          .pipe(Effect.mapError(fail("unpacking the release")));
        if (extracted.code !== 0) {
          return yield* new SimSlimInstallError({
            step: "unpacking the release",
            cause: extracted,
          });
        }
        yield* fs.remove(archivePath).pipe(Effect.ignore);
        const version = yield* runner
          .run({ command: path.join(staging, "simslim"), args: ["version"], timeout: "10 seconds" })
          .pipe(Effect.mapError(fail("running the binary")));
        if (version.code !== 0 || version.stdout.trim() !== `simslim ${SIMSLIM_VERSION}`) {
          return yield* new SimSlimInstallError({ step: "running the binary", cause: version });
        }
        yield* fs
          .writeFileString(path.join(staging, ".install-complete"), `${SIMSLIM_VERSION}\n`)
          .pipe(Effect.mapError(fail("recording the install")));
        yield* fs.rename(staging, installDir).pipe(Effect.mapError(fail("publishing the install")));
        return binary;
      }).pipe(
        Effect.ensuring(fs.remove(staging, { recursive: true, force: true }).pipe(Effect.ignore)),
      );
    }),
  );
});

export interface SimSlimDevice {
  readonly id: string;
  readonly platform: DevicePlatform;
  /** As the device hub reports it, such as "iOS 26.5". */
  readonly version: string;
  readonly booted: boolean;
  readonly physical: boolean;
}

export interface SimSlimStep {
  readonly action: "on" | "off";
  readonly args: ReadonlyArray<string>;
}

// Overrides survive a reboot from iOS 18.5; earlier runtimes come back stock.
const keepsOverrides = (version: string) => {
  const [major = 0, minor = 0] = /(\d+)\.(\d+)/.exec(version)?.slice(1).map(Number) ?? [];
  return major > 18 || (major === 18 && minor >= 5);
};

/**
 * What runs before Tempo boots or attaches a simulator. Both `on` and `off` boot a stopped one, so
 * the hub's boot finds it running: on a runtime that keeps overrides, `on` writes them while it is
 * off and it boots slim once; elsewhere, and on a running one, `--no-reboot` slims the session.
 */
export const simSlimStep = (
  device: SimSlimDevice,
  options: { readonly enabled: boolean; readonly slimmed: boolean },
): SimSlimStep | null => {
  if (device.platform !== "ios" || device.physical) return null;
  const command = (...args: ReadonlyArray<string>) => [
    "--boot-timeout",
    SIMSLIM_BOOT_TIMEOUT,
    ...args,
  ];
  // Restoring a running simulator would reboot it under the user, so that waits for its next boot.
  if (!options.enabled) {
    return options.slimmed && !device.booted
      ? { action: "off", args: command("off", device.id) }
      : null;
  }
  const persistent = keepsOverrides(device.version);
  if (device.booted && persistent && options.slimmed) return null;
  return {
    action: "on",
    args: command(
      "on",
      device.id,
      ...(device.booted || !persistent ? ["--no-reboot"] : []),
      "--except",
      SIMSLIM_KEPT_CATEGORIES,
    ),
  };
};

const SlimmedSimulators = Schema.Array(
  Schema.Struct({ hostId: Schema.String, deviceId: Schema.String }),
);
const decodeSlimmed = Schema.decodeUnknownEffect(Schema.fromJsonString(SlimmedSimulators));
const encodeSlimmed = Schema.encodeEffect(Schema.fromJsonString(SlimmedSimulators));

export const slimKey = (hostId: string, deviceId: string) => `${hostId}\u0000${deviceId}`;

export interface SimSlim {
  /** This machine can run simslim: an Apple silicon Mac. */
  readonly supported: boolean;
  /** `slimKey`s of the simulators Tempo slimmed and has not restored yet. */
  readonly slimmed: Effect.Effect<ReadonlySet<string>>;
  /** Slims or restores a simulator about to boot or attach; true when its slim mark changed. */
  readonly prepare: (
    host: { readonly hostId: string } & Pick<DeviceHostReady, "run" | "helpers">,
    device: SimSlimDevice,
    enabled: boolean,
  ) => Effect.Effect<boolean>;
}

/** Keeps the record of slimmed simulators in `recordPath`, under Tempo's state directory. */
export const make = Effect.fn("SimSlim.make")(function* (recordPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const supported =
    (yield* HostProcess.Platform) === "darwin" && (yield* HostProcess.Architecture) === "arm64";
  const entries = yield* SynchronizedRef.make(
    yield* fs.readFileString(recordPath).pipe(
      Effect.flatMap(decodeSlimmed),
      Effect.orElseSucceed((): typeof SlimmedSimulators.Type => []),
    ),
  );

  const record = (hostId: string, deviceId: string, slim: boolean) =>
    SynchronizedRef.modifyEffect(entries, (current) => {
      const others = current.filter(
        (entry) => entry.hostId !== hostId || entry.deviceId !== deviceId,
      );
      const next = slim ? [...others, { hostId, deviceId }] : others;
      if (next.length === current.length) return Effect.succeed([false, current] as const);
      return encodeSlimmed(next).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath: recordPath, contents })),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.catch((cause) =>
          Effect.logWarning(`Could not save which simulators ${TEMPO_APP_BASE_NAME} slimmed`, {
            cause,
          }),
        ),
        Effect.as([true, next] as const),
      );
    });

  const prepare: SimSlim["prepare"] = Effect.fn("SimSlim.prepare")(
    function* (host, device, enabled) {
      const binary = host.helpers.simslim;
      if (!binary) return false;
      const step = simSlimStep(device, {
        enabled,
        slimmed: (yield* SynchronizedRef.get(entries)).some(
          (entry) => entry.hostId === host.hostId && entry.deviceId === device.id,
        ),
      });
      if (!step) return false;
      // Recorded first: a failed `on` can still leave overrides behind for `off` to undo.
      const marked = step.action === "on" && (yield* record(host.hostId, device.id, true));
      const result = yield* host.run(binary, step.args, { timeoutMs: SIMSLIM_RUN_TIMEOUT_MS });
      if (result.code !== 0) {
        yield* Effect.logWarning("simslim failed; the simulator starts as it was", {
          hostId: host.hostId,
          deviceId: device.id,
          action: step.action,
          exitCode: result.code,
          stderr: result.stderr.slice(-1_000),
        });
        return marked;
      }
      return step.action === "off" ? yield* record(host.hostId, device.id, false) : marked;
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("simslim could not run; the simulator starts as it was", { cause }).pipe(
        Effect.as(false),
      ),
    ),
  );

  return {
    supported,
    slimmed: SynchronizedRef.get(entries).pipe(
      Effect.map(
        (current) => new Set(current.map((entry) => slimKey(entry.hostId, entry.deviceId))),
      ),
    ),
    prepare,
  } satisfies SimSlim;
});
