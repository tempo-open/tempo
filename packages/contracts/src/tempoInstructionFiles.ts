/**
 * tempo: the instruction and memory files (CLAUDE.md, AGENTS.md, rules,
 * auto memory) that this environment's Claude and Codex sessions load. The
 * server lists, reads, and writes only files it can prove a provider loads;
 * edits apply to sessions started afterwards.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Larger instruction files are neither shown nor saved; providers read far less than this. */
export const INSTRUCTION_FILE_MAX_BYTES = 256 * 1024;

export const InstructionProvider = Schema.Literals(["claude", "codex"]);
export type InstructionProvider = typeof InstructionProvider.Type;

/** What role a file plays; the UI groups and labels entries by it. */
export const InstructionFileKind = Schema.Literals([
  /** `<Claude config dir>/CLAUDE.md`: the person's instructions for every project. */
  "claude-user",
  /** `<Claude config dir>/rules/**.md`. */
  "claude-user-rule",
  /** `CLAUDE.md` or `.claude/CLAUDE.md` in a project or one of its folders. */
  "claude-project",
  /** `CLAUDE.local.md`: personal, usually gitignored. */
  "claude-local",
  /** `.claude/rules/**.md`. */
  "claude-rule",
  /** Auto memory index, `MEMORY.md`. */
  "claude-memory-index",
  /** An auto memory topic file. */
  "claude-memory",
  /** `<CODEX_HOME>/AGENTS.md` or `AGENTS.override.md`. */
  "codex-global",
  /** A project `AGENTS.md`, `AGENTS.override.md`, or configured fallback name. */
  "agents",
  /** A file pulled in by an `@path` import from another instruction file. */
  "import",
]);
export type InstructionFileKind = typeof InstructionFileKind.Type;

export const InstructionFileEntry = Schema.Struct({
  /** Absolute path on the environment's machine; the identity used to read and write. */
  path: TrimmedNonEmptyString,
  /** Path relative to the group's root, for display. */
  displayPath: Schema.String,
  kind: InstructionFileKind,
  /** Providers that load this file at all (at start, on demand, or through an import). */
  providers: Schema.Array(InstructionProvider),
  exists: Schema.Boolean,
  size: Schema.NullOr(NonNegativeInt),
  mtimeMs: Schema.NullOr(Schema.Number),
  /** When and why each provider loads it, in a sentence. */
  loadedBy: Schema.String,
  /** Something that makes the file load differently than expected, such as a size cap. */
  warning: Schema.optionalKey(Schema.String),
  /** Set when the path is a symlink: the file it points to. */
  linkTarget: Schema.optionalKey(Schema.String),
  /** Set when the server will not open this file here, with why (e.g. it links outside). */
  unopenable: Schema.optionalKey(Schema.String),
  /** Import entries: an instruction file that imports this one. Pass it as `via` to open it. */
  importedFrom: Schema.optionalKey(Schema.String),
});
export type InstructionFileEntry = typeof InstructionFileEntry.Type;

/**
 * Whether the person's own instruction files reach a provider home tempo manages: `direct` (the
 * provider uses their own folder), `included` (tempo's home imports or links them), `excluded` (the
 * setting is off), `missing` (on, but they have no such file), or `blocked` (tempo's Codex home has
 * its own global file, so theirs cannot load).
 */
export const PersonalInstructionsState = Schema.Literals([
  "direct",
  "included",
  "excluded",
  "missing",
  "blocked",
]);
export type PersonalInstructionsState = typeof PersonalInstructionsState.Type;

export const InstructionFileGroup = Schema.Struct({
  id: TrimmedNonEmptyString,
  scope: Schema.Literals(["global", "project", "memory"]),
  title: Schema.String,
  /** The folder entries are relative to. */
  root: Schema.String,
  projectId: Schema.optionalKey(ProjectId),
  providers: Schema.Array(InstructionProvider),
  entries: Schema.Array(InstructionFileEntry),
  /** The folder walk stopped at a depth, folder, or file cap; some nested files may be missing. */
  truncated: Schema.Boolean,
  /** Global groups only: where the person's own file is and whether it loads here. */
  personal: Schema.optionalKey(
    Schema.Struct({
      path: Schema.String,
      state: PersonalInstructionsState,
    }),
  ),
});
export type InstructionFileGroup = typeof InstructionFileGroup.Type;

export const InstructionFilesListInput = Schema.Struct({
  /** Only this project's groups (plus global ones); omitted lists every project. */
  projectId: Schema.optionalKey(ProjectId),
});
export type InstructionFilesListInput = typeof InstructionFilesListInput.Type;

export const InstructionFilesListResult = Schema.Struct({
  groups: Schema.Array(InstructionFileGroup),
  usePersonalInstructions: Schema.Boolean,
});
export type InstructionFilesListResult = typeof InstructionFilesListResult.Type;

/** An `@path` import found in a file, resolved the way Claude Code resolves it. */
export const InstructionImport = Schema.Struct({
  /** The text after `@`, as written. */
  token: Schema.String,
  path: Schema.String,
  exists: Schema.Boolean,
  /** The server will read this file; false for files outside the allowed folders or types. */
  openable: Schema.Boolean,
});
export type InstructionImport = typeof InstructionImport.Type;

/**
 * The instruction file that imports `path`, when it was opened through an
 * import; the server checks that import instead of searching every project.
 */
const via = Schema.optionalKey(TrimmedNonEmptyString);

export const InstructionFileReadInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  via,
});
export type InstructionFileReadInput = typeof InstructionFileReadInput.Type;

export const InstructionFileReadResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
  size: NonNegativeInt,
  mtimeMs: Schema.Number,
  imports: Schema.Array(InstructionImport),
});
export type InstructionFileReadResult = typeof InstructionFileReadResult.Type;

export const InstructionFileWriteInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  content: Schema.String,
  /** The mtime the editor loaded; null creates the file and fails if it already exists. */
  expectedMtimeMs: Schema.NullOr(Schema.Number),
  via,
});
export type InstructionFileWriteInput = typeof InstructionFileWriteInput.Type;

export const InstructionFileWriteResult = Schema.Struct({
  path: TrimmedNonEmptyString,
  size: NonNegativeInt,
  mtimeMs: Schema.Number,
});
export type InstructionFileWriteResult = typeof InstructionFileWriteResult.Type;

export const InstructionFileDeleteInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  /** The mtime the person saw when they confirmed; a newer file is not deleted. */
  expectedMtimeMs: Schema.Number,
  via,
});
export type InstructionFileDeleteInput = typeof InstructionFileDeleteInput.Type;

export const InstructionFileFailureReason = Schema.Literals([
  "not-allowed",
  "links-outside",
  "not-found",
  "conflict",
  "already-exists",
  "too-large",
  "not-text",
  "io",
]);
export type InstructionFileFailureReason = typeof InstructionFileFailureReason.Type;

const INSTRUCTION_FILE_FAILURE_MESSAGES: Record<InstructionFileFailureReason, string> = {
  "not-allowed": "This file is not an instruction file Claude or Codex loads on this environment.",
  "links-outside":
    // tempo: TEMPO_APP_BASE_NAME (contracts cannot import @t3tools/shared).
    "This file links to a file outside the folders Tempo edits, or to a file that is not a text document, so Tempo does not open it. Edit the file it links to directly.",
  "not-found": "The file no longer exists.",
  conflict: "The file changed on disk since it was opened. Reload it, then make your edit again.",
  "already-exists": "The file already exists. Reload the list to open it.",
  "too-large": "Instruction files larger than 256 KB cannot be opened or saved here.",
  "not-text": "The file is not UTF-8 text.",
  io: "The file could not be read or written on this environment.",
};

/** Reading, writing, or deleting an instruction file failed. The message is shown to people. */
export class InstructionFileError extends Schema.TaggedError<InstructionFileError>()(
  "InstructionFileError",
  {
    path: Schema.String,
    reason: InstructionFileFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return INSTRUCTION_FILE_FAILURE_MESSAGES[this.reason];
  }
}

/** Spread into WS_METHODS so every caller names these as `WS_METHODS.tempoInstructionFiles*`. */
export const TEMPO_INSTRUCTION_FILES_WS_METHODS = {
  tempoInstructionFilesList: "tempo.instructionFiles.list",
  tempoInstructionFilesRead: "tempo.instructionFiles.read",
  tempoInstructionFilesWrite: "tempo.instructionFiles.write",
  tempoInstructionFilesDelete: "tempo.instructionFiles.delete",
} as const;

export const WsTempoInstructionFilesListRpc = Rpc.make(
  TEMPO_INSTRUCTION_FILES_WS_METHODS.tempoInstructionFilesList,
  {
    payload: InstructionFilesListInput,
    success: InstructionFilesListResult,
    error: Schema.Union([InstructionFileError, EnvironmentAuthorizationError]),
  },
);

export const WsTempoInstructionFilesReadRpc = Rpc.make(
  TEMPO_INSTRUCTION_FILES_WS_METHODS.tempoInstructionFilesRead,
  {
    payload: InstructionFileReadInput,
    success: InstructionFileReadResult,
    error: Schema.Union([InstructionFileError, EnvironmentAuthorizationError]),
  },
);

/** Creates (expectedMtimeMs null) or replaces a file; fails with `conflict` if it changed. */
export const WsTempoInstructionFilesWriteRpc = Rpc.make(
  TEMPO_INSTRUCTION_FILES_WS_METHODS.tempoInstructionFilesWrite,
  {
    payload: InstructionFileWriteInput,
    success: InstructionFileWriteResult,
    error: Schema.Union([InstructionFileError, EnvironmentAuthorizationError]),
  },
);

export const WsTempoInstructionFilesDeleteRpc = Rpc.make(
  TEMPO_INSTRUCTION_FILES_WS_METHODS.tempoInstructionFilesDelete,
  {
    payload: InstructionFileDeleteInput,
    success: Schema.Struct({}),
    error: Schema.Union([InstructionFileError, EnvironmentAuthorizationError]),
  },
);
