/**
 * Tempo: "Sync to <host>" in Settings → Instructions. The laptop's server exports the person's
 * agent files below `.claude`, `.codex` and `.agents`; the host's imports them. Only instruction
 * files and `SYNCED_FOLDERS` travel, never settings or credentials, and links only between synced
 * paths. An import never deletes or replaces anything.
 */
import {
  AGENT_FILE_MAX_BYTES,
  AGENT_FILES_MAX_TOTAL_BYTES,
  AgentFilesError,
  type AgentFile,
  type AgentFileLink,
  type AgentFileSkipped,
  type AgentFileSkipReason,
  type AgentFilesExportResult,
  type AgentFilesImportInput,
  type AgentFilesImportResult,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Random from "effect/Random";

import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import {
  NEVER_LINKED_CLAUDE_ENTRIES,
  PERSONAL_CLAUDE_FOLDERS,
  linkPersonalClaudeFoldersInto,
} from "./ClaudePersonalFolders.ts";
import { linkPersonalCodexSkillsInto } from "./CodexPersonalSkills.ts";
import {
  InstructionProviderInstances,
  applyPersonalInstructions,
  resolveInstructionHomes,
  resolvePersonalInstructionDirs,
} from "./InstructionRoots.ts";

const ROOTS = ["claude", "codex", "agents"] as const;
type AgentFileRoot = (typeof ROOTS)[number];

/** How a sync path names each root. */
const ROOT_NAMES: Record<AgentFileRoot, string> = {
  claude: ".claude",
  codex: ".codex",
  agents: ".agents",
};

/** The person's global instruction files, by the path a sync names them with. */
const INSTRUCTION_FILES = [
  { path: ".claude/CLAUDE.md", root: "claude", name: "CLAUDE.md" },
  { path: ".codex/AGENTS.md", root: "codex", name: "AGENTS.md" },
  { path: ".codex/AGENTS.override.md", root: "codex", name: "AGENTS.override.md" },
] as const satisfies ReadonlyArray<{ path: string; root: AgentFileRoot; name: string }>;

const INSTRUCTION_PATHS: ReadonlySet<string> = new Set(INSTRUCTION_FILES.map((file) => file.path));

/**
 * The folders a sync carries below each root: Claude's skills, commands, agents, workflows and
 * output styles (as ClaudePersonalFolders links them) and rules; Codex's skills; the Agent Skills
 * folder. Codex's `agents` role files are config layers, so they stay out with its settings.
 */
const SYNCED_FOLDERS: Record<AgentFileRoot, ReadonlyArray<string>> = {
  claude: [...PERSONAL_CLAUDE_FOLDERS, "rules"],
  codex: ["skills"],
  agents: ["skills"],
};

/**
 * Folders a provider keeps in a skills folder and rewrites itself: Claude's
 * skills from claude.ai (`synced`) and the ones it set aside (`.trash`), and
 * the skills Codex installs (`.system`).
 */
const MANAGED_SKILL_FOLDERS: Record<AgentFileRoot, ReadonlySet<string>> = {
  claude: new Set(["synced", ".trash"]),
  codex: new Set([".system"]),
  agents: new Set([".system"]),
};

/** Paths below the Claude folders ClaudePersonalFolders links into Tempo's Claude home. */
const LINKED_CLAUDE_PREFIXES = PERSONAL_CLAUDE_FOLDERS.map((folder) => `.claude/${folder}/`);

/** Paths that change which skills CodexPersonalSkills links into Tempo's Codex home. */
const CODEX_SKILL_PREFIXES = [".codex/skills/", ".agents/skills/"];

/** Paths that change what personal instructions Tempo's homes include (see InstructionRoots). */
const isPersonalInstruction = (file: string) =>
  INSTRUCTION_PATHS.has(file) || file.startsWith(".claude/rules/");

/** Folders a sync never enters: dependencies and git internals. */
const IGNORED_FOLDER_NAMES: ReadonlySet<string> = new Set(["node_modules", ".git"]);

/** The longest base64 text a file within `AGENT_FILE_MAX_BYTES` encodes to. */
const MAX_BASE64_LENGTH = 4 * Math.ceil(AGENT_FILE_MAX_BYTES / 3);

interface AgentFileLocation {
  readonly root: AgentFileRoot;
  /** Below the root folder; the last one is the file's name. */
  readonly segments: ReadonlyArray<string>;
}

const rootNamed = (name: string | undefined) =>
  ROOTS.find((candidate) => ROOT_NAMES[candidate] === name);

/** Whether a sync path's first three segments name a folder in `MANAGED_SKILL_FOLDERS`. */
function isManagedSkillFolder([top, folder, name]: ReadonlyArray<string>): boolean {
  const root = rootNamed(top);
  return (
    root !== undefined &&
    folder === "skills" &&
    name !== undefined &&
    MANAGED_SKILL_FOLDERS[root].has(name)
  );
}

/**
 * Where a sync path lands below one of the person's roots, or null when a sync
 * may not carry it. Export and import both decide with this, for every file
 * and for both ends of every link.
 */
function agentFileLocation(value: string): AgentFileLocation | null {
  const [top, ...segments] = value.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "" ||
        segment === "." ||
        segment === ".." ||
        segment.includes("\\") ||
        segment.includes("\0"),
    )
  ) {
    return null;
  }
  const instruction = INSTRUCTION_FILES.find((file) => file.path === value);
  if (instruction !== undefined) return { root: instruction.root, segments };
  const root = rootNamed(top);
  if (root === undefined || segments.length < 2 || !SYNCED_FOLDERS[root].includes(segments[0]!)) {
    return null;
  }
  if (isManagedSkillFolder([ROOT_NAMES[root], ...segments])) return null;
  return segments.some(
    (segment) => IGNORED_FOLDER_NAMES.has(segment) || NEVER_LINKED_CLAUDE_ENTRIES.has(segment),
  )
    ? null
    : { root, segments };
}

/** `mode` with execute permission wherever it grants read, or with none. */
const withExecutable = (mode: number, executable: boolean) =>
  executable ? mode | ((mode & 0o444) >> 2) : mode & ~0o111;

const isExecutable = (mode: number) => (mode & 0o111) !== 0;

interface PlannedFile {
  readonly path: string;
  readonly location: AgentFileLocation;
  readonly bytes: Buffer;
  readonly executable: boolean;
}

interface PlannedLink {
  readonly path: string;
  readonly location: AgentFileLocation;
  readonly target: AgentFileLocation;
}

type WriteOutcome = "written" | "unchanged" | AgentFileSkipReason;

export class AgentFilesSync extends Context.Service<
  AgentFilesSync,
  {
    /**
     * This environment's agent files and links, and what was left out and why.
     * A file that cannot be read is skipped, never fatal.
     */
    readonly exportFiles: Effect.Effect<AgentFilesExportResult>;
    /**
     * Write files and make links another environment exported. Every path and
     * size is checked first; one that is not allowed refuses the whole set and
     * writes nothing. Identical files stay as they are and nothing is deleted.
     */
    readonly importFiles: (
      input: AgentFilesImportInput,
    ) => Effect.Effect<AgentFilesImportResult, AgentFilesError>;
  }
>()("t3/tempo/AgentFilesSync") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
  const providerInstances = yield* InstructionProviderInstances;

  const withPlatform = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      FileSystem.FileSystem | Path.Path | ServerConfig.ServerConfig | InstructionProviderInstances
    >,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(ServerConfig.ServerConfig, serverConfig),
      Effect.provideService(InstructionProviderInstances, providerInstances),
    );

  /** A link (never followed), what `stat` sees, or "missing" when nothing readable is there. */
  const inspect = Effect.fn("AgentFilesSync.inspect")(function* (file: string) {
    const link = yield* fileSystem.readLink(file).pipe(Effect.option);
    if (Option.isSome(link)) return "symlink" as const;
    return yield* fileSystem.stat(file).pipe(Effect.orElseSucceed(() => "missing" as const));
  });

  const exportFiles = Effect.gen(function* () {
    const personal = yield* withPlatform(resolvePersonalInstructionDirs());
    const files: AgentFile[] = [];
    const links: AgentFileLink[] = [];
    const skipped: AgentFileSkipped[] = [];
    let total = 0;
    const skip = (segments: ReadonlyArray<string>, reason: AgentFileSkipReason) => {
      skipped.push({ path: segments.join("/"), reason });
    };
    /** Why a file of `size` bytes stays out, if it does; one past the total leaves room for smaller ones. */
    const capReason = (size: number): AgentFileSkipReason | null =>
      size > AGENT_FILE_MAX_BYTES
        ? "too-large"
        : total + size > AGENT_FILES_MAX_TOTAL_BYTES
          ? "total-limit"
          : null;

    const addFile = Effect.fn("AgentFilesSync.addFile")(function* (
      segments: ReadonlyArray<string>,
      file: string,
      info: FileSystem.File.Info,
    ) {
      const before = capReason(Number(info.size));
      if (before !== null) return skip(segments, before);
      const bytes = yield* fileSystem.readFile(file).pipe(Effect.option);
      if (Option.isNone(bytes)) return skip(segments, "io");
      // The file may have grown since it was measured.
      const after = capReason(bytes.value.byteLength);
      if (after !== null) return skip(segments, after);
      total += bytes.value.byteLength;
      files.push({
        path: segments.join("/"),
        contentBase64: Buffer.from(bytes.value).toString("base64"),
        executable: isExecutable(info.mode),
      });
    });

    /** The sync path the link at `file` points to, when a sync carries it and it is there. */
    const linkTarget = Effect.fn("AgentFilesSync.linkTarget")(function* (file: string) {
      const target = yield* fileSystem.readLink(file).pipe(Effect.option);
      if (Option.isNone(target)) return null;
      const absolute = path.resolve(path.dirname(file), target.value);
      for (const root of ROOTS) {
        const relative = path.relative(personal[root], absolute);
        if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
        const syncPath = [ROOT_NAMES[root], ...relative.split(path.sep)].join("/");
        if (agentFileLocation(syncPath) === null) return null;
        return (yield* inspect(absolute)) === "missing" ? null : syncPath;
      }
      return null;
    });

    /** A link travels as a link when both of its ends are paths a sync carries. */
    const addLink = Effect.fn("AgentFilesSync.addLink")(function* (
      segments: ReadonlyArray<string>,
      file: string,
    ) {
      const linkPath = segments.join("/");
      const target = agentFileLocation(linkPath) === null ? null : yield* linkTarget(file);
      if (target === null) return skip(segments, "symlink");
      links.push({ path: linkPath, target });
    });

    /** A file, or a folder's files depth first in name order; links are never followed. */
    const addEntry: (segments: ReadonlyArray<string>, file: string) => Effect.Effect<void> =
      Effect.fn("AgentFilesSync.addEntry")(function* (segments, file) {
        const name = segments.at(-1) ?? "";
        if (IGNORED_FOLDER_NAMES.has(name)) return skip(segments, "ignored-folder");
        const entry = yield* inspect(file);
        if (entry === "symlink") return yield* addLink(segments, file);
        if (entry === "missing") return skip(segments, "io");
        if (entry.type === "Directory") {
          // The provider's own, not the person's: nothing to sync or report.
          if (isManagedSkillFolder(segments)) return;
          // Below a synced folder, a folder is entered only where a file could sit.
          if (segments.length > 2 && agentFileLocation(segments.join("/")) === null) {
            return skip(segments, "not-allowed");
          }
          const names = yield* fileSystem.readDirectory(file).pipe(Effect.option);
          if (Option.isNone(names)) return skip(segments, "io");
          for (const child of names.value.toSorted()) {
            yield* addEntry([...segments, child], path.join(file, child));
          }
          return;
        }
        if (agentFileLocation(segments.join("/")) === null) return skip(segments, "not-allowed");
        if (entry.type !== "File") return skip(segments, "not-a-file");
        yield* addFile(segments, file, entry);
      });

    for (const instruction of INSTRUCTION_FILES) {
      const segments = instruction.path.split("/");
      const file = path.join(personal[instruction.root], instruction.name);
      const entry = yield* inspect(file);
      // The person has no such file: nothing to sync, nothing to report.
      if (entry === "missing") continue;
      if (entry === "symlink") yield* addLink(segments, file);
      else if (entry.type !== "File") skip(segments, "not-a-file");
      else yield* addFile(segments, file, entry);
    }
    for (const root of ROOTS) {
      for (const folder of SYNCED_FOLDERS[root]) {
        const directory = path.join(personal[root], folder);
        if ((yield* inspect(directory)) !== "missing") {
          yield* addEntry([ROOT_NAMES[root], folder], directory);
        }
      }
    }
    return { files, links, skipped } satisfies AgentFilesExportResult;
  }).pipe(Effect.withSpan("AgentFilesSync.exportFiles"));

  /**
   * Why nothing may be written at `segments` below `root`: a link on the way
   * (never written through) or a file where one of its folders goes. Null
   * when the way is clear.
   */
  const blockedFolder = Effect.fn("AgentFilesSync.blockedFolder")(function* (
    root: string,
    segments: ReadonlyArray<string>,
  ) {
    let folder = root;
    for (const segment of segments.slice(0, -1)) {
      folder = path.join(folder, segment);
      const entry = yield* inspect(folder);
      if (entry === "symlink") return "symlink" as const;
      // Everything below a missing folder is missing too.
      if (entry === "missing") return null;
      if (entry.type !== "Directory") return "not-a-file" as const;
    }
    return null;
  });

  /** Writes one checked file below `root`, unless the environment has something else in its way. */
  const writeFile = Effect.fn("AgentFilesSync.writeFile")(function* (
    root: string,
    file: PlannedFile,
  ): Effect.fn.Return<WriteOutcome, PlatformError.PlatformError> {
    const blocked = yield* blockedFolder(root, file.location.segments);
    if (blocked !== null) return blocked;
    const target = path.join(root, ...file.location.segments);
    const existing = yield* inspect(target);
    if (existing === "symlink") return "symlink";
    let mode = file.executable ? 0o755 : 0o644;
    if (existing !== "missing") {
      if (existing.type !== "File") return "not-a-file";
      const current = existing.mode & 0o777;
      const sameMode = isExecutable(current) === file.executable;
      mode = sameMode ? current : withExecutable(current, file.executable);
      const sameContent =
        Number(existing.size) === file.bytes.byteLength &&
        file.bytes.equals(yield* fileSystem.readFile(target));
      if (sameContent) {
        if (sameMode) return "unchanged";
        yield* fileSystem.chmod(target, mode);
        return "written";
      }
    }
    // Replace the file in one rename, so an agent starting now reads the old or the new one.
    const directory = path.dirname(target);
    yield* fileSystem.makeDirectory(directory, { recursive: true });
    const suffix = Math.abs(yield* Random.nextInt).toString(36);
    const temporary = path.join(directory, `.${path.basename(target)}.tempo-${suffix}.tmp`);
    yield* fileSystem.writeFile(temporary, file.bytes, { mode }).pipe(
      Effect.andThen(fileSystem.chmod(temporary, mode)),
      Effect.andThen(fileSystem.rename(temporary, target)),
      Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)),
    );
    return "written";
  });

  /**
   * Makes one checked link, pointing at this environment's own copy of its
   * target, where the environment has nothing at its path. A link already
   * pointing there is unchanged; anything else there stays.
   */
  const writeLink = Effect.fn("AgentFilesSync.writeLink")(function* (
    personal: Record<AgentFileRoot, string>,
    link: PlannedLink,
  ): Effect.fn.Return<WriteOutcome, PlatformError.PlatformError> {
    const root = personal[link.location.root];
    const blocked = yield* blockedFolder(root, link.location.segments);
    if (blocked !== null) return blocked;
    const linkPath = path.join(root, ...link.location.segments);
    const target = path.join(personal[link.target.root], ...link.target.segments);
    const existing = yield* inspect(linkPath);
    if (existing === "symlink") {
      const current = yield* fileSystem.readLink(linkPath);
      return path.resolve(path.dirname(linkPath), current) === target ? "unchanged" : "symlink";
    }
    if (existing !== "missing") return "symlink";
    yield* fileSystem.makeDirectory(path.dirname(linkPath), { recursive: true });
    yield* fileSystem.symlink(path.relative(path.dirname(linkPath), target) || ".", linkPath);
    return "written";
  });

  /**
   * New personal files change what Tempo's own provider homes load: Claude there
   * imports the person's CLAUDE.md and links their rules, and Codex links their
   * AGENTS.md (see InstructionRoots); Claude links their folders and Codex
   * their skills, which may only now exist.
   */
  const refreshManagedHomes = Effect.fn("AgentFilesSync.refreshManagedHomes")(function* (
    written: ReadonlyArray<string>,
  ) {
    const startsWithAny = (prefixes: ReadonlyArray<string>) =>
      written.some((file) => prefixes.some((prefix) => file.startsWith(prefix)));
    const instructions = written.some(isPersonalInstruction);
    const claudeFolders = startsWithAny(LINKED_CLAUDE_PREFIXES);
    const codexSkills = startsWithAny(CODEX_SKILL_PREFIXES);
    if (!instructions && !claudeFolders && !codexSkills) return;
    const settings = yield* serverSettings.getSettings;
    if (instructions) yield* withPlatform(applyPersonalInstructions(settings));
    if (!claudeFolders && !codexSkills) return;
    const homes = yield* withPlatform(
      resolveInstructionHomes(yield* providerInstances.configMap(settings), serverConfig.stateDir),
    );
    for (const home of homes) {
      if (home.provider === "claude" && claudeFolders) {
        yield* withPlatform(linkPersonalClaudeFoldersInto(home.home));
      }
      if (home.provider === "codex" && codexSkills) {
        yield* withPlatform(linkPersonalCodexSkillsInto(home.home));
      }
    }
  });

  const importFiles: AgentFilesSync["Service"]["importFiles"] = Effect.fn(
    "AgentFilesSync.importFiles",
  )(function* (input) {
    const notAllowed = (syncPath: string) =>
      new AgentFilesError({ path: syncPath, reason: "not-allowed" });
    const planned: PlannedFile[] = [];
    let total = 0;
    for (const file of input.files) {
      const location = agentFileLocation(file.path);
      if (location === null) return yield* notAllowed(file.path);
      // Longer text would decode past the cap anyway; this refuses it before decoding.
      if (file.contentBase64.length > MAX_BASE64_LENGTH) {
        return yield* new AgentFilesError({ path: file.path, reason: "too-large" });
      }
      const bytes = Buffer.from(file.contentBase64, "base64");
      if (bytes.toString("base64") !== file.contentBase64) {
        return yield* new AgentFilesError({ path: file.path, reason: "not-base64" });
      }
      total += bytes.byteLength;
      if (bytes.byteLength > AGENT_FILE_MAX_BYTES || total > AGENT_FILES_MAX_TOTAL_BYTES) {
        return yield* new AgentFilesError({ path: file.path, reason: "too-large" });
      }
      planned.push({ path: file.path, location, bytes, executable: file.executable });
    }
    const plannedLinks: PlannedLink[] = [];
    for (const link of input.links) {
      const location = agentFileLocation(link.path);
      if (location === null) return yield* notAllowed(link.path);
      const target = agentFileLocation(link.target);
      if (target === null) return yield* notAllowed(link.target);
      plannedLinks.push({ path: link.path, location, target });
    }

    const personal = yield* withPlatform(resolvePersonalInstructionDirs());
    const written: string[] = [];
    const unchanged: string[] = [];
    const skipped: AgentFileSkipped[] = [];
    const record = (
      syncPath: string,
      write: Effect.Effect<WriteOutcome, PlatformError.PlatformError>,
    ) =>
      write.pipe(
        Effect.catchTags({
          PlatformError: (cause) =>
            Effect.logWarning("Could not write a synced agent file", {
              path: syncPath,
              cause,
            }).pipe(Effect.as("io" as const)),
        }),
        Effect.map((outcome) => {
          if (outcome === "written") written.push(syncPath);
          else if (outcome === "unchanged") unchanged.push(syncPath);
          else skipped.push({ path: syncPath, reason: outcome });
        }),
      );
    // Files first, so each link made after them finds what it points to.
    for (const file of planned) {
      yield* record(file.path, writeFile(personal[file.location.root], file));
    }
    for (const link of plannedLinks) yield* record(link.path, writeLink(personal, link));
    yield* refreshManagedHomes(written).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          `Could not refresh ${TEMPO_APP_BASE_NAME}'s provider homes after a sync`,
          {
            cause,
          },
        ),
      ),
    );
    yield* Effect.logInfo("Imported synced agent files", {
      written: written.length,
      unchanged: unchanged.length,
      skipped: skipped.length,
    });
    return { written, unchanged, skipped };
  });

  return AgentFilesSync.of({ exportFiles, importFiles });
});

export const layer = Layer.effect(AgentFilesSync, make);
