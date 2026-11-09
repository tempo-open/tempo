/**
 * tempo: the repos volume, an APFS volume at `~/repos` that Spotlight skips and FSEvents keeps no log
 * of (macOS hosts only). Tempo never runs its setup, since every step needs the person's password:
 * `prepare` writes the vendored script privately for them to run in a terminal here. `status` only
 * reads whether a volume is mounted there, without a subprocess.
 */
import {
  TempoReposVolumeError,
  type TempoReposVolumePrepareResult,
  type TempoReposVolumeStatus,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

import * as ServerConfig from "../../config.ts";
import { REPOS_VOLUME_SCRIPT } from "./reposVolumeScript.ts";

export class ReposVolume extends Context.Service<
  ReposVolume,
  {
    readonly status: Effect.Effect<TempoReposVolumeStatus, TempoReposVolumeError>;
    /** Writes the setup script, replacing an earlier copy whole. */
    readonly prepare: Effect.Effect<TempoReposVolumePrepareResult, TempoReposVolumeError>;
  }
>()("t3/tempo/reposVolume/ReposVolume") {}

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  const home = yield* HostProcess.HomeDirectory;
  const volumePath = path.join(home, "repos");
  const scriptDirectory = path.join(stateDir, "repos-volume");
  const scriptPath = path.join(scriptDirectory, "repos-volume.sh");

  const status = Effect.gen(function* () {
    const worktreesPath = path.join(volumePath, ".worktrees");
    // `stat` follows a link to its target's device, but a link is never a mount point.
    const isLink = yield* fileSystem.readLink(volumePath).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
    const volume = isLink
      ? Option.none()
      : yield* fileSystem.stat(volumePath).pipe(
          Effect.asSome,
          Effect.catchIf(
            (cause) => cause.reason._tag === "NotFound",
            () => Effect.succeedNone,
          ),
        );
    if (Option.isNone(volume)) return { path: volumePath, mounted: false, worktreesPath };
    const parent = yield* fileSystem.stat(home);
    return { path: volumePath, mounted: volume.value.dev !== parent.dev, worktreesPath };
  }).pipe(
    Effect.mapError((cause) => new TempoReposVolumeError({ operation: "status", cause })),
    Effect.withSpan("ReposVolume.status"),
  );

  // The script runs with sudo inside, so it lands whole by rename, only ever readable by
  // this user; a shell already running the old copy keeps reading the old file.
  const prepare = Effect.gen(function* () {
    yield* fileSystem.makeDirectory(scriptDirectory, { recursive: true, mode: 0o700 });
    yield* fileSystem.chmod(scriptDirectory, 0o700);
    const suffix = Math.abs(yield* Random.nextInt).toString(36);
    const temporary = path.join(scriptDirectory, `.repos-volume.sh.${suffix}.tmp`);
    yield* fileSystem
      .writeFileString(temporary, REPOS_VOLUME_SCRIPT, { flag: "wx", mode: 0o700 })
      .pipe(
        Effect.andThen(fileSystem.chmod(temporary, 0o700)),
        Effect.andThen(fileSystem.rename(temporary, scriptPath)),
        Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)),
      );
    return { scriptPath, cwd: home };
  }).pipe(
    Effect.mapError((cause) => new TempoReposVolumeError({ operation: "prepare", cause })),
    Effect.withSpan("ReposVolume.prepare"),
  );

  return ReposVolume.of({ status, prepare });
});

export const layer = Layer.effect(ReposVolume, make);
