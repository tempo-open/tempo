/**
 * tempo: the repos volume, a separate APFS volume at `~/repos` on a Mac host.
 *
 * Tempo never creates or mounts it. `prepare` writes the setup script privately on
 * the server, and the person runs it in a terminal on that machine, where macOS
 * asks for their password. `status` only reads whether something is mounted there.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";

const AbsolutePath = Schema.String.check(Schema.isNonEmpty());

export const TempoReposVolumeStatus = Schema.Struct({
  /** `~/repos` on the server's machine. */
  path: AbsolutePath,
  /** A volume is mounted at `path`: its device differs from its parent folder's. */
  mounted: Schema.Boolean,
  /** Where new worktrees go when they are kept on the volume. */
  worktreesPath: AbsolutePath,
});
export type TempoReposVolumeStatus = typeof TempoReposVolumeStatus.Type;

export const TempoReposVolumePrepareResult = Schema.Struct({
  /** The setup script, readable only by the server's user. */
  scriptPath: AbsolutePath,
  /** The home folder, where the terminal that runs it opens. */
  cwd: AbsolutePath,
});
export type TempoReposVolumePrepareResult = typeof TempoReposVolumePrepareResult.Type;

export class TempoReposVolumeError extends Schema.TaggedError<TempoReposVolumeError>()(
  "TempoReposVolumeError",
  {
    operation: Schema.Literals(["status", "prepare"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.operation === "status"
      ? "Could not check ~/repos on this machine."
      : "Could not write the repos volume setup script.";
  }
}

export const TEMPO_REPOS_VOLUME_WS_METHODS = {
  status: "tempo.reposVolume.status",
  prepare: "tempo.reposVolume.prepare",
} as const;

const TempoReposVolumeRpcError = Schema.Union([
  TempoReposVolumeError,
  EnvironmentAuthorizationError,
]);

export const TempoReposVolumeStatusRpc = Rpc.make(TEMPO_REPOS_VOLUME_WS_METHODS.status, {
  payload: Schema.Struct({}),
  success: TempoReposVolumeStatus,
  error: TempoReposVolumeRpcError,
});

export const TempoReposVolumePrepareRpc = Rpc.make(TEMPO_REPOS_VOLUME_WS_METHODS.prepare, {
  payload: Schema.Struct({}),
  success: TempoReposVolumePrepareResult,
  error: TempoReposVolumeRpcError,
});
