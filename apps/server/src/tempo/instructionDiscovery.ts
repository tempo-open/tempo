// @effect-diagnostics nodeBuiltinImport:off -- the walk needs Dirent types, which effect FileSystem does not expose.
/**
 * Tempo: finding instruction files on disk. Which names count, how deep the
 * project walk goes, and how Claude `@path` imports parse. InstructionFiles.ts
 * turns the results into the groups the Instructions page shows.
 */
import * as NodeFSP from "node:fs/promises";

import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as VcsProcess from "../vcs/VcsProcess.ts";

/** Folders below a project root the walk descends; deeper folders are not searched. */
const WALK_MAX_DEPTH = 6;
/** Folders read per project before the walk stops and reports itself truncated. */
const WALK_MAX_DIRECTORIES = 2_000;
/** Instruction files collected per walk (project, rules folder, or memory folder). */
export const WALK_MAX_FILES = 200;
/** `.claude/rules` and `<config>/rules` are searched this deep. */
export const RULES_MAX_DEPTH = 4;
/** Claude Code follows `@path` imports at most this many hops. */
export const CLAUDE_IMPORT_MAX_DEPTH = 4;

/** Never descended: dependency and VCS folders. Hidden folders are skipped too, except `.claude`. */
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".git"]);

/** Imports the page opens: text documents only, so an import cannot expose a secret file. */
const OPENABLE_IMPORT_EXTENSIONS = new Set([".md", ".mdx", ".markdown", ".txt"]);

const CLAUDE_PROJECT_FILE_NAMES = ["CLAUDE.md", "CLAUDE.local.md"] as const;
const CODEX_PROJECT_FILE_NAMES = ["AGENTS.override.md", "AGENTS.md"] as const;

/** File names that are instruction files in any project folder, given Codex's fallbacks. */
export function projectInstructionFileNames(
  codexFallbackNames: ReadonlyArray<string>,
): ReadonlySet<string> {
  return new Set<string>([
    ...CLAUDE_PROJECT_FILE_NAMES,
    ...CODEX_PROJECT_FILE_NAMES,
    ...codexFallbackNames.filter((name) => !name.includes("/") && !name.includes("\\")),
  ]);
}

/** Imports the page opens are text documents, so an import cannot expose a secret file. */
export const isOpenableImportPath = (path: Path.Path, value: string) =>
  OPENABLE_IMPORT_EXTENSIONS.has(path.extname(value).toLowerCase());

export const isInsidePath = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

type InstructionRootKind = "claude-home" | "codex-home" | "project" | "memory";

export interface InstructionRoot {
  readonly kind: InstructionRootKind;
  readonly directory: string;
}

/**
 * Whether `target` is an instruction file by name and place: the fixed names in
 * a provider home, a project's instruction names in any non-hidden folder up to
 * the walk depth, `.claude/` files and rules, or markdown in an auto memory folder.
 */
export function matchesInstructionPattern(input: {
  readonly path: Path.Path;
  readonly roots: ReadonlyArray<InstructionRoot>;
  readonly projectFileNames: ReadonlySet<string>;
  readonly target: string;
}): boolean {
  const { path, target } = input;
  return input.roots.some((root) => {
    if (!isInsidePath(path, root.directory, target)) return false;
    const segments = path.relative(root.directory, target).split(path.sep);
    if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "..")) {
      return false;
    }
    const name = segments[segments.length - 1]!;
    switch (root.kind) {
      case "claude-home":
        return (
          (segments.length === 1 && name === "CLAUDE.md") ||
          (segments[0] === "rules" &&
            name.endsWith(".md") &&
            segments.length <= RULES_MAX_DEPTH + 1)
        );
      case "codex-home":
        return segments.length === 1 && (name === "AGENTS.md" || name === "AGENTS.override.md");
      case "memory":
        return name.endsWith(".md") && segments.length <= 2;
      case "project": {
        if (segments.some((segment) => SKIPPED_DIRECTORY_NAMES.has(segment))) return false;
        const claudeIndex = segments.indexOf(".claude");
        const folders = segments.slice(0, claudeIndex === -1 ? -1 : claudeIndex);
        if (folders.length > WALK_MAX_DEPTH || folders.some((folder) => folder.startsWith("."))) {
          return false;
        }
        if (claudeIndex === -1) return input.projectFileNames.has(name);
        const inside = segments.slice(claudeIndex + 1);
        return (
          (inside.length === 1 && (name === "CLAUDE.md" || name === "AGENTS.md")) ||
          (inside[0] === "rules" &&
            name.endsWith(".md") &&
            inside.length >= 2 &&
            inside.length <= RULES_MAX_DEPTH + 1)
        );
      }
    }
  });
}

/** Strip code spans, fenced blocks, and HTML comments: imports there are not followed. */
function importableText(content: string): string {
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
  const lines: string[] = [];
  let fence: string | null = null;
  for (const line of withoutComments.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker[0]!;
      else if (marker[0] === fence) fence = null;
      lines.push("");
      continue;
    }
    lines.push(
      fence === null ? line.replace(/`+[^`\n]*`+/g, (span) => " ".repeat(span.length)) : "",
    );
  }
  return lines.join("\n");
}

/** The `@path` tokens Claude Code would import from this text, as written. */
export function parseClaudeImports(content: string): ReadonlyArray<string> {
  const tokens: string[] = [];
  for (const match of importableText(content).matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) {
    const token = match[1]!.replaceAll("\\ ", " ");
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens;
}

/**
 * Resolve an import the way Claude Code does: `~/` from the home folder,
 * absolute as is, anything else relative to the importing file.
 */
export function resolveClaudeImport(input: {
  readonly path: Path.Path;
  readonly token: string;
  readonly fromFile: string;
  readonly homeDirectory: string;
}): string {
  const { path, token } = input;
  if (token === "~" || token.startsWith("~/")) {
    return path.resolve(input.homeDirectory, token.slice(2));
  }
  if (path.isAbsolute(token)) return path.resolve(token);
  return path.resolve(path.dirname(input.fromFile), token);
}

export interface WalkResult {
  /** Absolute paths of instruction files found, in walk order. */
  readonly files: ReadonlyArray<string>;
  readonly truncated: boolean;
}

const readDirectoryEntries = (directory: string) =>
  Effect.tryPromise(() => NodeFSP.readdir(directory, { withFileTypes: true })).pipe(
    Effect.orElseSucceed(() => []),
  );

/** Collect `*.md` below `directory`, at most `maxDepth` folders deep. Symlinked folders are not followed. */
export const walkMarkdownFiles = Effect.fn("instructionDiscovery.walkMarkdownFiles")(function* (
  directory: string,
  maxDepth: number,
): Effect.fn.Return<WalkResult, never, Path.Path> {
  const path = yield* Path.Path;
  const files: string[] = [];
  let truncated = false;
  let level = [directory];
  for (let depth = 0; depth <= maxDepth && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const folder of level) {
      for (const entry of yield* readDirectoryEntries(folder)) {
        const entryPath = path.join(folder, entry.name);
        if ((entry.isFile() || entry.isSymbolicLink()) && entry.name.endsWith(".md")) {
          if (files.length >= WALK_MAX_FILES) {
            truncated = true;
            continue;
          }
          files.push(entryPath);
        } else if (entry.isDirectory() && !entry.name.startsWith(".")) {
          if (depth === maxDepth) truncated = true;
          else next.push(entryPath);
        }
      }
    }
    level = next;
  }
  files.sort();
  return { files, truncated };
});

/** Folders git ignores, from `git check-ignore`; empty outside a repository or without git. */
const ignoredFolders = Effect.fn("instructionDiscovery.ignoredFolders")(function* (
  root: string,
  relativeFolders: ReadonlyArray<string>,
): Effect.fn.Return<ReadonlySet<string>, never, VcsProcess.VcsProcess> {
  if (relativeFolders.length === 0) return new Set();
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const result = yield* vcsProcess
    .run({
      operation: "InstructionFiles.walk",
      command: "git",
      args: ["-c", "core.fsmonitor=false", "check-ignore", "-z", "--stdin"],
      cwd: root,
      // A trailing slash makes folder-only patterns such as `dist/` match.
      stdin: `${relativeFolders.map((folder) => `${folder}/`).join("\0")}\0`,
      allowNonZeroExit: true,
      timeoutMs: 10_000,
      maxOutputBytes: 4 * 1024 * 1024,
    })
    .pipe(Effect.orElseSucceed(() => undefined));
  if (!result || (result.exitCode !== 0 && result.exitCode !== 1)) return new Set();
  return new Set(
    result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.replace(/\/$/, "")),
  );
});

/**
 * Walk a project for instruction files: the given names in every folder, plus
 * `.claude/CLAUDE.md`, `.claude/AGENTS.md`, and `.claude/rules/**.md`. Skips
 * hidden, dependency, symlinked, and git-ignored folders; stops at the depth,
 * folder, and file caps and says so.
 */
export const walkProjectInstructionFiles = Effect.fn(
  "instructionDiscovery.walkProjectInstructionFiles",
)(function* (
  root: string,
  fileNames: ReadonlySet<string>,
): Effect.fn.Return<WalkResult, never, Path.Path | VcsProcess.VcsProcess> {
  const path = yield* Path.Path;
  const files: string[] = [];
  let truncated = false;
  let foldersRead = 0;
  const addFile = (file: string) => {
    if (files.length >= WALK_MAX_FILES) {
      truncated = true;
      return;
    }
    files.push(file);
  };
  let level = [""];
  for (let depth = 0; depth <= WALK_MAX_DEPTH && level.length > 0; depth += 1) {
    const next: string[] = [];
    for (const relativeFolder of level) {
      if (foldersRead >= WALK_MAX_DIRECTORIES) {
        truncated = true;
        break;
      }
      foldersRead += 1;
      const folder = path.join(root, relativeFolder);
      for (const entry of yield* readDirectoryEntries(folder)) {
        if ((entry.isFile() || entry.isSymbolicLink()) && fileNames.has(entry.name)) {
          addFile(path.join(folder, entry.name));
          continue;
        }
        if (!entry.isDirectory()) continue;
        if (entry.name === ".claude") {
          const claudeFolder = path.join(folder, ".claude");
          for (const inner of yield* readDirectoryEntries(claudeFolder)) {
            if (
              (inner.isFile() || inner.isSymbolicLink()) &&
              (inner.name === "CLAUDE.md" || inner.name === "AGENTS.md")
            ) {
              addFile(path.join(claudeFolder, inner.name));
            }
          }
          const rules = yield* walkMarkdownFiles(path.join(claudeFolder, "rules"), RULES_MAX_DEPTH);
          for (const rule of rules.files) addFile(rule);
          if (rules.truncated) truncated = true;
          continue;
        }
        if (entry.name.startsWith(".") || SKIPPED_DIRECTORY_NAMES.has(entry.name)) continue;
        if (depth === WALK_MAX_DEPTH) {
          truncated = true;
          continue;
        }
        next.push(relativeFolder === "" ? entry.name : `${relativeFolder}/${entry.name}`);
      }
    }
    const ignored = yield* ignoredFolders(root, next);
    level = next.filter((folder) => !ignored.has(folder));
  }
  return { files, truncated };
});
