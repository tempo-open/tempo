/**
 * tempo: bringing a machine's T3 Code threads (the same codebase, its own home) into its Tempo install.
 * `scan` reads T3 Code's database without changing it and reports what an import would do; `run`
 * copies each project's threads, history only. A rerun skips threads it already brought over.
 */
import * as Schema from "effect/Schema";
import * as Rpc from "effect/rpc/Rpc";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, PositiveInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TempoT3ImportInput = Schema.Struct({
  /** T3 Code's home folder on the server's machine; `~/.t3` when omitted. */
  t3Home: Schema.optional(TrimmedNonEmptyString),
  /** Also bring threads T3 Code has settled or archived, which otherwise stay there. */
  includeSettled: Schema.optional(Schema.Boolean),
});
export type TempoT3ImportInput = typeof TempoT3ImportInput.Type;

/**
 * Why this Tempo cannot read T3 Code's database: it predates T3 Code's current
 * format, or T3 Code has changes this Tempo build does not know.
 */
export const TempoT3ImportIncompatibility = Schema.Literals(["tooOld", "tooNew"]);
export type TempoT3ImportIncompatibility = typeof TempoT3ImportIncompatibility.Type;

export function tempoT3ImportIncompatibilityMessage(reason: TempoT3ImportIncompatibility): string {
  return reason === "tooOld"
    ? "T3 Code's data is in an older format. Update T3 Code and open it once, then try again."
    : "T3 Code is newer than this Tempo build. Update Tempo, then try again.";
}

/**
 * Why a thread stays in T3 Code: settled or archived there, running or waiting there, its history
 * from before T3 Code's database update was never loaded, it cannot be read, its project folder is
 * gone, its Tempo project was removed after an earlier import, or copying it failed.
 */
export const TempoT3ImportSkipReason = Schema.Literals([
  "settled",
  "live",
  "notHydrated",
  "unreadable",
  "folderMissing",
  "projectRemoved",
  "failed",
]);
export type TempoT3ImportSkipReason = typeof TempoT3ImportSkipReason.Type;

export const TempoT3ImportSkipped = Schema.Struct({
  reason: TempoT3ImportSkipReason,
  count: PositiveInt,
});
export type TempoT3ImportSkipped = typeof TempoT3ImportSkipped.Type;

/** Every T3 Code thread of a project lands in exactly one of these counts. */
const TempoT3ImportProjectFields = {
  t3ProjectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  /** The Tempo project for the same folder; null until the import creates one. */
  tempoProject: Schema.NullOr(Schema.Struct({ id: ProjectId, title: TrimmedNonEmptyString })),
  alreadyImported: NonNegativeInt,
  skipped: Schema.Array(TempoT3ImportSkipped),
};

export const TempoT3ImportScanProject = Schema.Struct({
  ...TempoT3ImportProjectFields,
  toImport: NonNegativeInt,
});
export type TempoT3ImportScanProject = typeof TempoT3ImportScanProject.Type;

export const TempoT3ImportScanResult = Schema.Struct({
  t3Home: TrimmedNonEmptyString,
  /** False when T3 Code has no database in `t3Home`. */
  found: Schema.Boolean,
  /** The database with its write-ahead log. */
  sizeBytes: NonNegativeInt,
  /** T3 Code's server is up, or it wrote to its database in the last minute. */
  t3Running: Schema.Boolean,
  /** Null when this Tempo can read the database. */
  incompatibility: Schema.NullOr(TempoT3ImportIncompatibility),
  /** T3 Code's projects that have threads, in creation order. */
  projects: Schema.Array(TempoT3ImportScanProject),
});
export type TempoT3ImportScanResult = typeof TempoT3ImportScanResult.Type;

export const TempoT3ImportRunProject = Schema.Struct({
  ...TempoT3ImportProjectFields,
  imported: NonNegativeInt,
  /** This run created `tempoProject`. */
  createdProject: Schema.Boolean,
});
export type TempoT3ImportRunProject = typeof TempoT3ImportRunProject.Type;

export const TempoT3ImportRunResult = Schema.Struct({
  projects: Schema.Array(TempoT3ImportRunProject),
  /** Attachments T3 Code no longer had on disk; their messages arrive without them. */
  missingAttachments: NonNegativeInt,
  /** Imported threads whose provider this machine lacks; pick a model before continuing them. */
  needsModel: NonNegativeInt,
});
export type TempoT3ImportRunResult = typeof TempoT3ImportRunResult.Type;

export class TempoT3ImportNotFoundError extends Schema.TaggedError<TempoT3ImportNotFoundError>()(
  "TempoT3ImportNotFoundError",
  { t3Home: TrimmedNonEmptyString },
) {
  override get message(): string {
    return `T3 Code has no data in ${this.t3Home}.`;
  }
}

/** The folder is this Tempo's own home: importing it would copy Tempo's threads into itself. */
export class TempoT3ImportOwnDataError extends Schema.TaggedError<TempoT3ImportOwnDataError>()(
  "TempoT3ImportOwnDataError",
  { t3Home: TrimmedNonEmptyString },
) {
  override get message(): string {
    // tempo: TEMPO_APP_BASE_NAME (contracts cannot import @t3tools/shared).
    return `${this.t3Home} is where Tempo keeps its own data, not T3 Code's.`;
  }
}

export class TempoT3ImportIncompatibleError extends Schema.TaggedError<TempoT3ImportIncompatibleError>()(
  "TempoT3ImportIncompatibleError",
  { reason: TempoT3ImportIncompatibility },
) {
  override get message(): string {
    return tempoT3ImportIncompatibilityMessage(this.reason);
  }
}

export class TempoT3ImportReadError extends Schema.TaggedError<TempoT3ImportReadError>()(
  "TempoT3ImportReadError",
  { t3Home: TrimmedNonEmptyString, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Tempo could not read T3 Code's data in ${this.t3Home}.`;
  }
}

/** A failure on Tempo's side. Threads imported before it stay; running the import again finishes. */
export class TempoT3ImportFailedError extends Schema.TaggedError<TempoT3ImportFailedError>()(
  "TempoT3ImportFailedError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "The import from T3 Code stopped. Threads it already copied stay; try again to finish.";
  }
}

export const TempoT3ImportError = Schema.Union([
  TempoT3ImportNotFoundError,
  TempoT3ImportOwnDataError,
  TempoT3ImportIncompatibleError,
  TempoT3ImportReadError,
  TempoT3ImportFailedError,
]);
export type TempoT3ImportError = typeof TempoT3ImportError.Type;

export const TEMPO_T3_IMPORT_WS_METHODS = {
  scan: "tempo.t3Import.scan",
  run: "tempo.t3Import.run",
} as const;

const TempoT3ImportRpcError = Schema.Union([TempoT3ImportError, EnvironmentAuthorizationError]);

export const TempoT3ImportScanRpc = Rpc.make(TEMPO_T3_IMPORT_WS_METHODS.scan, {
  payload: TempoT3ImportInput,
  success: TempoT3ImportScanResult,
  error: TempoT3ImportRpcError,
});

export const TempoT3ImportRunRpc = Rpc.make(TEMPO_T3_IMPORT_WS_METHODS.run, {
  payload: TempoT3ImportInput,
  success: TempoT3ImportRunResult,
  error: TempoT3ImportRpcError,
});
