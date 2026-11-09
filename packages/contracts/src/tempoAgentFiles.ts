/**
 * tempo: copying the person's own agent files between environments (Settings → Instructions →
 * Sync): a client exports them on one and imports them on the other. Only personal instruction
 * files, Claude's skills, commands, agents, workflows, rules and output styles, and the Codex and
 * Agent Skills folders' skills travel; servers check every path, follow no link, delete no file.
 */
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";

/** Larger files are skipped on export and refused on import. */
export const AGENT_FILE_MAX_BYTES = 1024 * 1024;
/** One sync carries at most this much file content; export skips files past it. */
export const AGENT_FILES_MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/**
 * A file's path from the home folder with `/` separators, such as `.claude/skills/review/SKILL.md`.
 * `.claude`, `.codex` and `.agents` stand for the person's Claude config folder, Codex home and
 * Agent Skills folder, wherever CLAUDE_CONFIG_DIR and CODEX_HOME put them on each machine.
 */
const AgentFilePath = Schema.String.check(Schema.isNonEmpty());

export const AgentFile = Schema.Struct({
  path: AgentFilePath,
  contentBase64: Schema.String,
  executable: Schema.Boolean,
});
export type AgentFile = typeof AgentFile.Type;

/**
 * A symbolic link to another path a sync carries, such as a skill in
 * `.claude/skills` that links into `.agents/skills`. It travels as a link, and
 * the host makes it again pointing at its own copy of `target`.
 */
const AgentFileLink = Schema.Struct({
  path: AgentFilePath,
  target: AgentFilePath,
});
export type AgentFileLink = typeof AgentFileLink.Type;

/** An environment from before links travelled sends none. */
const AgentFileLinks = Schema.Array(AgentFileLink).pipe(
  Schema.withDecodingDefault(Effect.succeed([])),
);

/** Why a file or folder was left out. */
export const AgentFileSkipReason = Schema.Literals([
  /**
   * A symbolic link: one that points outside what a sync carries stays
   * behind, one is never made where the environment has something else, and
   * none is followed or written through.
   */
  "symlink",
  /** Larger than `AGENT_FILE_MAX_BYTES`. */
  "too-large",
  /** It would take the sync past `AGENT_FILES_MAX_TOTAL_BYTES`. */
  "total-limit",
  /** A `node_modules` or `.git` folder. */
  "ignored-folder",
  /** A settings or credentials file, or a name a sync cannot carry. */
  "not-allowed",
  /** Not a regular file, or the environment has a folder where the file goes. */
  "not-a-file",
  /** Reading or writing it failed. */
  "io",
]);
export type AgentFileSkipReason = typeof AgentFileSkipReason.Type;

export const AgentFileSkipped = Schema.Struct({
  path: AgentFilePath,
  reason: AgentFileSkipReason,
});
export type AgentFileSkipped = typeof AgentFileSkipped.Type;

export const AgentFilesExportResult = Schema.Struct({
  files: Schema.Array(AgentFile),
  links: AgentFileLinks,
  skipped: Schema.Array(AgentFileSkipped),
});
export type AgentFilesExportResult = typeof AgentFilesExportResult.Type;

export const AgentFilesImportInput = Schema.Struct({
  files: Schema.Array(AgentFile),
  links: AgentFileLinks,
});
export type AgentFilesImportInput = typeof AgentFilesImportInput.Type;

export const AgentFilesImportResult = Schema.Struct({
  /** Created, replaced because the content differed, or given the executable bit it lacked. */
  written: Schema.Array(AgentFilePath),
  /** Already identical here. */
  unchanged: Schema.Array(AgentFilePath),
  /** Left as they are here, such as a path this environment links elsewhere. */
  skipped: Schema.Array(AgentFileSkipped),
});
export type AgentFilesImportResult = typeof AgentFilesImportResult.Type;

export const AgentFilesFailureReason = Schema.Literals(["not-allowed", "too-large", "not-base64"]);
export type AgentFilesFailureReason = typeof AgentFilesFailureReason.Type;

const AGENT_FILES_FAILURE_MESSAGES: Record<AgentFilesFailureReason, (path: string) => string> = {
  "not-allowed": (path) =>
    // tempo: TEMPO_APP_BASE_NAME (contracts cannot import @t3tools/shared).
    `${path} is not one of the files Tempo syncs: your CLAUDE.md and AGENTS.md, Claude's skills, commands, agents, workflows, rules and output styles, and your Codex and ~/.agents skills.`,
  "too-large": (path) =>
    `${path} is too large: a sync carries files up to 1 MB each and 20 MB in all.`,
  "not-base64": (path) => `${path} did not arrive as base64.`,
};

/** An import was refused before anything was written. The message is shown to people. */
export class AgentFilesError extends Schema.TaggedError<AgentFilesError>()("AgentFilesError", {
  path: Schema.String,
  reason: AgentFilesFailureReason,
}) {
  override get message(): string {
    return AGENT_FILES_FAILURE_MESSAGES[this.reason](this.path);
  }
}

/** Spread into WS_METHODS so every caller names these as `WS_METHODS.tempoAgentFiles*`. */
export const TEMPO_AGENT_FILES_WS_METHODS = {
  tempoAgentFilesExport: "tempo.agentFiles.export",
  tempoAgentFilesImport: "tempo.agentFiles.import",
} as const;

/** This environment's agent files, for a client to import on another. */
export const WsTempoAgentFilesExportRpc = Rpc.make(
  TEMPO_AGENT_FILES_WS_METHODS.tempoAgentFilesExport,
  {
    payload: Schema.Struct({}),
    success: AgentFilesExportResult,
    error: EnvironmentAuthorizationError,
  },
);

/** Writes files another environment exported; one path or size that is not allowed refuses them all. */
export const WsTempoAgentFilesImportRpc = Rpc.make(
  TEMPO_AGENT_FILES_WS_METHODS.tempoAgentFilesImport,
  {
    payload: AgentFilesImportInput,
    success: AgentFilesImportResult,
    error: Schema.Union([AgentFilesError, EnvironmentAuthorizationError]),
  },
);
