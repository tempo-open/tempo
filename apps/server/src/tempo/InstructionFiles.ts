/**
 * Tempo: the CLAUDE.md / AGENTS.md / rules / auto memory files Claude and Codex sessions load,
 * for the Instructions settings page. Reads and writes are limited to files the list could show
 * (provider homes, the person's homes, registered projects, auto memory folders), by instruction
 * file name, with symlinks resolved and a size cap.
 */
import {
  INSTRUCTION_FILE_MAX_BYTES,
  InstructionFileError,
  type InstructionFileDeleteInput,
  type InstructionFileEntry,
  type InstructionFileGroup,
  type InstructionFileKind,
  type InstructionFileReadInput,
  type InstructionFileReadResult,
  type InstructionFilesListInput,
  type InstructionFilesListResult,
  type InstructionFileWriteInput,
  type InstructionFileWriteResult,
  type InstructionImport,
  type InstructionProvider,
  type Project,
  type ProjectId,
  type ServerSettings,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Random from "effect/Random";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  CLAUDE_IMPORT_MAX_DEPTH,
  RULES_MAX_DEPTH,
  isOpenableImportPath,
  isInsidePath,
  matchesInstructionPattern,
  parseClaudeImports,
  projectInstructionFileNames,
  resolveClaudeImport,
  walkMarkdownFiles,
  walkProjectInstructionFiles,
  type InstructionRoot,
} from "./instructionDiscovery.ts";
import {
  CODEX_DEFAULT_PROJECT_DOC_CONFIG,
  InstructionProviderInstances,
  applyPersonalInstructions,
  personalInstructionFile,
  personalInstructionsState,
  readCodexProjectDocConfig,
  resolveClaudeMemoryDir,
  resolveInstructionHomes,
  resolvePersonalInstructionDirs,
  type CodexProjectDocConfig,
  type InstructionHome,
} from "./InstructionRoots.ts";

/** Claude loads this much of MEMORY.md at the start of a session. */
const CLAUDE_MEMORY_INDEX_MAX_LINES = 200;
const CLAUDE_MEMORY_INDEX_MAX_BYTES = 25 * 1024;

/** Files Claude or Codex read from a project's parent folders, before Codex fallbacks. */
const ANCESTOR_FILE_NAMES = [
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  "CLAUDE.local.md",
  "AGENTS.md",
  ".claude/AGENTS.md",
  "AGENTS.override.md",
] as const;

const EXTERNAL_IMPORT_WARNING = `Claude Code asks once per project before it loads imports from outside the project. ${TEMPO_APP_BASE_NAME} cannot show that prompt, so this loads only if you approved it in Claude Code.`;

/** Lines as an editor counts them: a final newline does not start another line. */
const countLines = (text: string) =>
  text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);

export class InstructionFiles extends Context.Service<
  InstructionFiles,
  {
    /** Every instruction file new Claude and Codex sessions here can load, grouped by scope. */
    readonly list: (
      input: InstructionFilesListInput,
    ) => Effect.Effect<InstructionFilesListResult, InstructionFileError>;
    readonly read: (
      input: InstructionFileReadInput,
    ) => Effect.Effect<InstructionFileReadResult, InstructionFileError>;
    /** Create or replace a file, failing with `conflict` if it changed since `expectedMtimeMs`. */
    readonly write: (
      input: InstructionFileWriteInput,
    ) => Effect.Effect<InstructionFileWriteResult, InstructionFileError>;
    /** Delete a file the person confirmed, unless it changed since they saw it. */
    readonly remove: (
      input: InstructionFileDeleteInput,
    ) => Effect.Effect<void, InstructionFileError>;
  }
>()("t3/tempo/InstructionFiles") {}

interface MemoryFolder {
  readonly directory: string;
  readonly enabled: boolean;
  readonly projects: ReadonlyArray<Project>;
}

/** Everything one list or authorization needs, resolved once. */
interface ScanContext {
  readonly settings: ServerSettings;
  readonly homeDirectory: string;
  readonly claudeHomes: ReadonlyArray<InstructionHome>;
  readonly codexHomes: ReadonlyArray<InstructionHome>;
  readonly personal: { readonly claude: string; readonly codex: string };
  readonly projects: ReadonlyArray<Project>;
  readonly codexConfig: CodexProjectDocConfig;
  readonly memoryFolders: ReadonlyArray<MemoryFolder>;
  readonly roots: ReadonlyArray<InstructionRoot>;
  /** Real paths of `roots`; resolved files must stay inside one. */
  readonly realRoots: ReadonlyArray<string>;
  readonly projectFileNames: ReadonlySet<string>;
}

interface Draft {
  readonly path: string;
  readonly kind: InstructionFileKind;
  readonly providers: ReadonlyArray<InstructionProvider>;
  readonly loadedBy: ReadonlyArray<string>;
  readonly warning?: string;
  readonly importedFrom?: string;
}

/** Whether Codex loads a project file, in a sentence, with a size warning. */
interface CodexFileStatus {
  readonly providers: boolean;
  readonly sentence: string;
  readonly warning?: string;
}

interface FileState {
  readonly exists: boolean;
  readonly size: number | null;
  readonly mtimeMs: number | null;
  readonly linkTarget?: string;
}

const providerList = (claude: boolean, codex: boolean): ReadonlyArray<InstructionProvider> => [
  ...(claude ? (["claude"] as const) : []),
  ...(codex ? (["codex"] as const) : []),
];

const io = (path: string) => (cause: unknown) =>
  new InstructionFileError({ path, reason: "io", cause });

const hasPathsFrontmatter = (content: string) => {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)?.[1];
  return frontmatter !== undefined && /^paths\s*:/m.test(frontmatter);
};

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
  const projectService = yield* ProjectService.ProjectService;
  const vcsProcess = yield* VcsProcess.VcsProcess;
  const providerInstances = yield* InstructionProviderInstances;

  const withPlatform = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | VcsProcess.VcsProcess>,
  ) =>
    effect.pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(VcsProcess.VcsProcess, vcsProcess),
    );

  const realPathOrResolved = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));

  const statFile = Effect.fn("InstructionFiles.statFile")(function* (file: string) {
    const info = yield* fileSystem.stat(file).pipe(Effect.option);
    const link = yield* fileSystem.readLink(file).pipe(Effect.option);
    const linkTarget = Option.match(link, {
      onNone: () => ({}),
      onSome: (target) => ({ linkTarget: path.resolve(path.dirname(file), target) }),
    });
    if (Option.isNone(info) || info.value.type !== "File") {
      return { exists: false, size: null, mtimeMs: null, ...linkTarget } satisfies FileState;
    }
    return {
      exists: true,
      size: Number(info.value.size),
      mtimeMs: Option.match(info.value.mtime, {
        onNone: () => 0,
        onSome: (date) => date.getTime(),
      }),
      ...linkTarget,
    } satisfies FileState;
  });

  /** Text of an instruction file within the cap, or None. Used for discovery only. */
  const readSmallText = (file: string) =>
    statFile(file).pipe(
      Effect.flatMap((state) =>
        state.exists && (state.size ?? 0) <= INSTRUCTION_FILE_MAX_BYTES
          ? fileSystem.readFileString(file).pipe(Effect.option)
          : Effect.succeed(Option.none<string>()),
      ),
    );

  /** Whether a file holds more than whitespace; a file past the cap counts as text. */
  const hasText = (file: string) =>
    statFile(file).pipe(
      Effect.flatMap((state) =>
        !state.exists
          ? Effect.succeed(false)
          : (state.size ?? 0) > INSTRUCTION_FILE_MAX_BYTES
            ? Effect.succeed(true)
            : readSmallText(file).pipe(
                Effect.map((text) => Option.isSome(text) && text.value.trim().length > 0),
              ),
      ),
    );

  const loadContext = Effect.fn("InstructionFiles.loadContext")(function* (
    projectId: ProjectId | undefined,
  ) {
    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError(io(serverConfig.settingsPath)),
    );
    const homeDirectory = yield* HostProcess.HomeDirectory;
    const homes = yield* withPlatform(
      resolveInstructionHomes(yield* providerInstances.configMap(settings), serverConfig.stateDir),
    );
    const claudeHomes = homes.filter((home) => home.provider === "claude");
    const codexHomes = homes.filter((home) => home.provider === "codex");
    const personal = yield* withPlatform(resolvePersonalInstructionDirs());
    const snapshot = yield* projectService.snapshot.pipe(Effect.mapError(io(serverConfig.dbPath)));
    const projects = snapshot.projects.filter(
      (project) =>
        project.deletedAt === null && (projectId === undefined || project.id === projectId),
    );
    const codexConfig =
      codexHomes[0] === undefined
        ? CODEX_DEFAULT_PROJECT_DOC_CONFIG
        : yield* withPlatform(readCodexProjectDocConfig(codexHomes[0].home));
    const memoryByDirectory = new Map<string, MemoryFolder>();
    for (const home of claudeHomes) {
      for (const project of projects) {
        const memory = yield* withPlatform(
          resolveClaudeMemoryDir({
            configDir: home.home,
            cwd: project.workspaceRoot,
            environment: home.environment,
          }),
        );
        const existing = memoryByDirectory.get(memory.directory);
        memoryByDirectory.set(memory.directory, {
          directory: memory.directory,
          enabled: memory.enabled || existing?.enabled === true,
          projects: [...(existing?.projects ?? []), project],
        });
      }
    }
    const memoryFolders = [...memoryByDirectory.values()];
    const roots: ReadonlyArray<InstructionRoot> = [
      ...claudeHomes.map((home) => ({ kind: "claude-home" as const, directory: home.home })),
      { kind: "claude-home", directory: personal.claude },
      ...codexHomes.map((home) => ({ kind: "codex-home" as const, directory: home.home })),
      { kind: "codex-home", directory: personal.codex },
      ...projects.map((project) => ({
        kind: "project" as const,
        directory: path.resolve(project.workspaceRoot),
      })),
      ...memoryFolders.map((folder) => ({ kind: "memory" as const, directory: folder.directory })),
    ];
    const realRoots = yield* Effect.forEach(roots, (root) => realPathOrResolved(root.directory));
    return {
      settings,
      homeDirectory,
      claudeHomes,
      codexHomes,
      personal,
      projects,
      codexConfig,
      memoryFolders,
      roots,
      realRoots,
      projectFileNames: projectInstructionFileNames(codexConfig.fallbackFilenames),
    } satisfies ScanContext;
  });

  const displayPath = (context: ScanContext, root: string, file: string) => {
    if (isInsidePath(path, root, file)) return path.relative(root, file);
    return isInsidePath(path, context.homeDirectory, file)
      ? path.join("~", path.relative(context.homeDirectory, file))
      : file;
  };

  /** Whether `file` sits in a Claude or Codex home: the person's own setup, links included. */
  const isProviderHomeFile = (context: ScanContext, file: string) =>
    context.roots.some(
      (root) =>
        (root.kind === "claude-home" || root.kind === "codex-home") &&
        isInsidePath(path, root.directory, file),
    );

  /** The folder holding `file` when it is an instruction file in a project's parent folder. */
  const ancestorOwner = (context: ScanContext, file: string): string | null => {
    const names = [...ANCESTOR_FILE_NAMES, ...context.codexConfig.fallbackFilenames];
    for (const project of context.projects) {
      let current = path.resolve(project.workspaceRoot);
      while (path.dirname(current) !== current) {
        current = path.dirname(current);
        if (names.some((name) => path.join(current, name) === file)) return current;
      }
    }
    return null;
  };

  /**
   * Whether a file whose real path is `real` may be opened as `target`: a text
   * document or instruction file inside an allowed folder. A file in a Claude or
   * Codex home may link anywhere, as dotfiles managers do, but only to text, so
   * a link can never reach credentials such as `auth.json`.
   */
  const resolvedAccess = (
    context: ScanContext,
    target: string,
    real: string,
    extraRoots: ReadonlyArray<string>,
  ): "ok" | "not-text" | "outside" => {
    const textual =
      isOpenableImportPath(path, real) || context.projectFileNames.has(path.basename(real));
    if (!textual) return "not-text";
    return [...context.realRoots, ...extraRoots].some((root) => isInsidePath(path, root, real)) ||
      isProviderHomeFile(context, target)
      ? "ok"
      : "outside";
  };

  /** Folders a parent-folder instruction file may also resolve into: its own. */
  const extraRootsFor = Effect.fn("InstructionFiles.extraRootsFor")(function* (
    context: ScanContext,
    file: string,
  ) {
    const owner = ancestorOwner(context, file);
    return owner === null ? [] : [yield* realPathOrResolved(owner)];
  });

  const toEntry = Effect.fn("InstructionFiles.toEntry")(function* (
    context: ScanContext,
    root: string,
    draft: Draft,
  ) {
    const state = yield* statFile(draft.path);
    let unopenable: string | undefined;
    if (state.exists) {
      const real = yield* realPathOrResolved(draft.path);
      const access = resolvedAccess(
        context,
        draft.path,
        real,
        yield* extraRootsFor(context, draft.path),
      );
      const shown = displayPath(context, root, real);
      if (access === "not-text") {
        unopenable = `It links to ${shown}, which is not a text document, so ${TEMPO_APP_BASE_NAME} does not open it.`;
      } else if (access === "outside") {
        unopenable = `It links to ${shown}, outside the folders ${TEMPO_APP_BASE_NAME} edits, so ${TEMPO_APP_BASE_NAME} does not open it. Edit that file directly.`;
      }
    }
    return {
      path: draft.path,
      displayPath: displayPath(context, root, draft.path),
      kind: draft.kind,
      providers: draft.providers,
      exists: state.exists,
      size: state.size,
      mtimeMs: state.mtimeMs,
      loadedBy: draft.loadedBy.join(" "),
      ...(draft.warning === undefined ? {} : { warning: draft.warning }),
      ...(state.linkTarget === undefined ? {} : { linkTarget: state.linkTarget }),
      ...(unopenable === undefined ? {} : { unopenable }),
      ...(draft.importedFrom === undefined ? {} : { importedFrom: draft.importedFrom }),
    } satisfies InstructionFileEntry;
  });

  /**
   * Follow Claude `@path` imports from `sources` up to Claude's hop limit. Each
   * import is a text file that resolves inside an instruction root; anything else
   * stays unopened. Returns import edges in discovery order.
   */
  const collectImports = Effect.fn("InstructionFiles.collectImports")(function* (
    context: ScanContext,
    sources: ReadonlyArray<string>,
  ) {
    const edges: Array<{ readonly from: string; readonly to: string }> = [];
    const visited = new Set(sources);
    const queue = sources.map((file) => ({ file, depth: 0 }));
    while (queue.length > 0) {
      const { file, depth } = queue.shift()!;
      if (depth >= CLAUDE_IMPORT_MAX_DEPTH) continue;
      const content = yield* readSmallText(file);
      if (Option.isNone(content)) continue;
      for (const token of parseClaudeImports(content.value)) {
        const target = resolveClaudeImport({
          path,
          token,
          fromFile: file,
          homeDirectory: context.homeDirectory,
        });
        if (!(yield* isOpenableImport(context, target))) continue;
        edges.push({ from: file, to: target });
        if (visited.has(target)) continue;
        visited.add(target);
        queue.push({ file: target, depth: depth + 1 });
      }
    }
    return edges;
  });

  const isOpenableImport = Effect.fn("InstructionFiles.isOpenableImport")(function* (
    context: ScanContext,
    target: string,
  ) {
    if (!isOpenableImportPath(path, target)) return false;
    const state = yield* statFile(target);
    if (!state.exists) return false;
    // The link's own name says nothing; what it resolves to must be text too.
    const real = yield* realPathOrResolved(target);
    return (
      isOpenableImportPath(path, real) &&
      context.realRoots.some((root) => isInsidePath(path, root, real))
    );
  });

  /** Add import entries (and Claude as a loader of already-listed targets) to a group's drafts. */
  const withImports = Effect.fn("InstructionFiles.withImports")(function* (
    context: ScanContext,
    group: { readonly scope: InstructionFileGroup["scope"]; readonly root: string },
    drafts: ReadonlyArray<Draft>,
    sourceStates: ReadonlyMap<string, FileState>,
  ) {
    const sources = drafts
      .filter((draft) => draft.providers.includes("claude") && sourceStates.get(draft.path)?.exists)
      .map((draft) => draft.path);
    const edges = yield* collectImports(context, sources);
    const byPath = new Map(drafts.map((draft) => [draft.path, draft] as const));
    for (const edge of edges) {
      const importer = displayPath(context, group.root, edge.from);
      // Claude trusts imports from the person's own files; a project file importing
      // from outside the project needs a one-time approval in Claude Code.
      const external =
        group.scope === "project" &&
        !isProviderHomeFile(context, edge.from) &&
        !isInsidePath(path, group.root, edge.to);
      const sentence = external
        ? `Claude loads it with ${importer}, which imports it, once you approve imports from outside this project.`
        : `Claude loads it with ${importer}, which imports it.`;
      const warning = external ? { warning: EXTERNAL_IMPORT_WARNING } : {};
      const existing = byPath.get(edge.to);
      if (existing === undefined) {
        byPath.set(edge.to, {
          path: edge.to,
          kind: "import",
          providers: ["claude"],
          loadedBy: [sentence],
          importedFrom: edge.from,
          ...warning,
        });
      } else if (!existing.loadedBy.includes(sentence)) {
        byPath.set(edge.to, {
          ...(existing.warning === undefined ? warning : {}),
          ...existing,
          providers: existing.providers.includes("claude")
            ? existing.providers
            : (["claude", ...existing.providers] as const),
          loadedBy: [...existing.loadedBy, sentence],
        });
      }
    }
    return [...byPath.values()];
  });

  const buildGroup = Effect.fn("InstructionFiles.buildGroup")(function* (
    context: ScanContext,
    group: Omit<InstructionFileGroup, "entries"> & { readonly drafts: ReadonlyArray<Draft> },
  ) {
    const states = new Map<string, FileState>();
    for (const draft of group.drafts) states.set(draft.path, yield* statFile(draft.path));
    const drafts = yield* withImports(context, group, group.drafts, states);
    const { drafts: _drafts, ...rest } = group;
    return {
      ...rest,
      entries: yield* Effect.forEach(drafts, (draft) => toEntry(context, group.root, draft)),
    } satisfies InstructionFileGroup;
  });

  const ruleSentence = Effect.fn("InstructionFiles.ruleSentence")(function* (
    rule: string,
    always: string,
  ) {
    const content = yield* readSmallText(rule);
    return Option.isSome(content) && hasPathsFrontmatter(content.value)
      ? "Claude loads it when it works on files matching its `paths`."
      : always;
  });

  const claudeGlobalGroup = Effect.fn("InstructionFiles.claudeGlobalGroup")(function* (
    context: ScanContext,
    home: InstructionHome,
  ) {
    const rules = yield* withPlatform(
      walkMarkdownFiles(path.join(home.home, "rules"), RULES_MAX_DEPTH),
    );
    const drafts: Draft[] = [
      {
        path: path.join(home.home, "CLAUDE.md"),
        kind: "claude-user",
        providers: ["claude"],
        loadedBy: ["Claude loads it at the start of every session, in every project."],
      },
    ];
    for (const rule of rules.files) {
      drafts.push({
        path: rule,
        kind: "claude-user-rule",
        providers: ["claude"],
        loadedBy: [
          yield* ruleSentence(
            rule,
            "Claude loads it at the start of every session, in every project.",
          ),
        ],
      });
    }
    const state = yield* withPlatform(
      personalInstructionsState({
        provider: "claude",
        home: home.home,
        personalDir: context.personal.claude,
        baseDir: serverConfig.baseDir,
        enabled: context.settings.tempoUsePersonalInstructions,
      }),
    );
    return yield* buildGroup(context, {
      id: `global:claude:${home.home}`,
      scope: "global",
      title: "Claude",
      root: home.home,
      providers: ["claude"],
      truncated: rules.truncated,
      personal: {
        path: yield* withPlatform(personalInstructionFile("claude", context.personal.claude)),
        state,
      },
      drafts,
    });
  });

  const codexGlobalGroup = Effect.fn("InstructionFiles.codexGlobalGroup")(function* (
    context: ScanContext,
    home: InstructionHome,
  ) {
    // Codex takes the first of these with more than whitespace in it.
    const overridePath = path.join(home.home, "AGENTS.override.md");
    const agentsPath = path.join(home.home, "AGENTS.md");
    const override = yield* statFile(overridePath);
    const overrideWins = override.exists && (yield* hasText(overridePath));
    const agentsBlank = (yield* statFile(agentsPath)).exists && !(yield* hasText(agentsPath));
    const drafts: Draft[] = [];
    if (override.exists) {
      drafts.push({
        path: overridePath,
        kind: "codex-global",
        providers: overrideWins ? ["codex"] : [],
        loadedBy: [
          overrideWins
            ? "Codex loads it at the start of every session, in every project, instead of AGENTS.md."
            : "Codex skips it because it is empty.",
        ],
      });
    }
    drafts.push({
      path: agentsPath,
      kind: "codex-global",
      providers: overrideWins || agentsBlank ? [] : ["codex"],
      loadedBy: [
        overrideWins
          ? "Codex skips it while AGENTS.override.md has content."
          : agentsBlank
            ? "Codex skips it because it is empty."
            : "Codex loads it at the start of every session, in every project.",
      ],
    });
    const state = yield* withPlatform(
      personalInstructionsState({
        provider: "codex",
        home: home.home,
        personalDir: context.personal.codex,
        baseDir: serverConfig.baseDir,
        enabled: context.settings.tempoUsePersonalInstructions,
      }),
    );
    return yield* buildGroup(context, {
      id: `global:codex:${home.home}`,
      scope: "global",
      title: "Codex",
      root: home.home,
      providers: ["codex"],
      truncated: false,
      personal: {
        path: yield* withPlatform(personalInstructionFile("codex", context.personal.codex)),
        state,
      },
      drafts,
    });
  });

  /** Global files are listed once, in their own group, even when a project's parent folder holds them. */
  const globalPaths = (context: ScanContext) =>
    new Set([
      ...context.claudeHomes.map((home) => path.join(home.home, "CLAUDE.md")),
      path.join(context.personal.claude, "CLAUDE.md"),
      ...context.codexHomes.flatMap((home) => [
        path.join(home.home, "AGENTS.md"),
        path.join(home.home, "AGENTS.override.md"),
      ]),
      path.join(context.personal.codex, "AGENTS.md"),
      path.join(context.personal.codex, "AGENTS.override.md"),
    ]);

  /** Codex's project root: the nearest folder holding a root marker, else the folder itself. */
  const codexProjectRoot = Effect.fn("InstructionFiles.codexProjectRoot")(function* (
    context: ScanContext,
    root: string,
  ) {
    if (context.codexConfig.rootMarkers.length === 0) return root;
    let directory = root;
    while (true) {
      for (const marker of context.codexConfig.rootMarkers) {
        if (
          yield* fileSystem
            .exists(path.join(directory, marker))
            .pipe(Effect.orElseSucceed(() => false))
        ) {
          return directory;
        }
      }
      const parent = path.dirname(directory);
      if (parent === directory) return root;
      directory = parent;
    }
  });

  const projectGroup = Effect.fn("InstructionFiles.projectGroup")(function* (
    context: ScanContext,
    project: Project,
  ) {
    const root = path.resolve(project.workspaceRoot);
    const hasClaude = context.claudeHomes.length > 0;
    const hasCodex = context.codexHomes.length > 0;
    const globals = globalPaths(context);
    const walk = yield* withPlatform(walkProjectInstructionFiles(root, context.projectFileNames));

    const ancestors: string[] = [];
    for (let current = root; path.dirname(current) !== current; current = path.dirname(current)) {
      ancestors.unshift(path.dirname(current));
    }
    const ancestorFiles: string[] = [];
    for (const directory of ancestors) {
      for (const name of [...ANCESTOR_FILE_NAMES, ...context.codexConfig.fallbackFilenames]) {
        const file = path.join(directory, name);
        if (!globals.has(file) && (yield* statFile(file)).exists) ancestorFiles.push(file);
      }
    }

    const files = new Set([...ancestorFiles, ...walk.files]);
    const states = new Map<string, FileState>();
    for (const file of files) states.set(file, yield* statFile(file));
    const exists = (file: string) => states.get(file)?.exists === true;

    // Claude reads AGENTS.md only when no CLAUDE.md, .claude/CLAUDE.md, or CLAUDE.local.md
    // sits in the session folder or above it (the user's global file does not count).
    const claudeMdFiles = [...ancestors, root]
      .flatMap((directory) =>
        ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"].map((name) =>
          path.join(directory, name),
        ),
      )
      .filter((file) => !globals.has(file));
    for (const file of claudeMdFiles) {
      if (!states.has(file)) states.set(file, yield* statFile(file));
    }
    const claudeReadsAgents = hasClaude && !claudeMdFiles.some(exists);

    // Codex: from its project root down to the session folder, the first of override,
    // AGENTS.md, then fallbacks that exists in each folder; a blank one loads nothing
    // (Codex does not fall through to the next name); a byte budget across folders.
    const codexRoot = yield* codexProjectRoot(context, root);
    const codexChain: string[] = [];
    for (let current = root; ; current = path.dirname(current)) {
      codexChain.unshift(current);
      if (current === codexRoot || path.dirname(current) === current) break;
    }
    const codexNames = [
      "AGENTS.override.md",
      "AGENTS.md",
      ...context.codexConfig.fallbackFilenames,
    ];
    const codexStatus = new Map<string, CodexFileStatus>();
    let budget = context.codexConfig.maxBytes;
    const foldersWithWinner = new Set<string>();
    for (const directory of codexChain) {
      let winner: string | null = null;
      for (const name of codexNames) {
        const file = path.join(directory, name);
        if (!states.has(file)) states.set(file, yield* statFile(file));
        const state = states.get(file)!;
        if (!state.exists) continue;
        if (winner !== null) {
          codexStatus.set(file, {
            providers: false,
            sentence: `Codex skips it: ${path.basename(winner)} in the same folder takes precedence.`,
          });
          continue;
        }
        winner = file;
        foldersWithWinner.add(directory);
        if (!(yield* hasText(file))) {
          codexStatus.set(file, {
            providers: false,
            sentence:
              "Codex skips it because it is empty, and loads nothing else from this folder.",
          });
          continue;
        }
        const size = state.size ?? 0;
        const sentence = "Codex loads it at the start of every session in this project.";
        if (budget <= 0) {
          codexStatus.set(file, {
            providers: false,
            sentence: "Codex skips it: earlier project instructions used its whole size limit.",
            warning: `Codex reads at most ${context.codexConfig.maxBytes} bytes of project instructions (project_doc_max_bytes).`,
          });
        } else if (size > budget) {
          codexStatus.set(file, {
            providers: true,
            sentence,
            warning: `Codex reads only the first ${budget} bytes of this file (project_doc_max_bytes is ${context.codexConfig.maxBytes}).`,
          });
        } else {
          codexStatus.set(file, { providers: true, sentence });
        }
        budget -= size;
      }
    }

    const drafts = new Map<string, Draft>();
    const add = (draft: Draft) => {
      if (!globals.has(draft.path) && !drafts.has(draft.path)) drafts.set(draft.path, draft);
    };
    const folderLabel = (directory: string) => `${displayPath(context, root, directory) || "."}/`;

    const classify = (file: string, offered: boolean): Draft | null => {
      if (!offered && !exists(file)) return null;
      const segments = path.relative(root, file).split(path.sep);
      const isAncestor = segments[0] === "..";
      const claudeIndex = segments.indexOf(".claude");
      const folder = isAncestor
        ? path.dirname(file)
        : path.join(root, ...segments.slice(0, claudeIndex === -1 ? -1 : claudeIndex));
      const atStart = isAncestor || folder === root;
      const name = path.basename(file);
      const where = isAncestor
        ? "at the start of every session in this project (it is in a parent folder)."
        : atStart
          ? "at the start of every session in this project."
          : `when it reads or edits a file in ${folderLabel(folder)}.`;

      if (claudeIndex !== -1 && segments[claudeIndex + 1] === "rules") {
        return {
          path: file,
          kind: "claude-rule",
          providers: providerList(hasClaude, false),
          loadedBy: [
            `Claude loads it ${atStart ? "at the start of every session in this project." : `when it works in ${folderLabel(folder)}.`}`,
          ],
        };
      }
      if (name === "CLAUDE.md" || name === "CLAUDE.local.md") {
        return {
          path: file,
          kind: name === "CLAUDE.md" ? "claude-project" : "claude-local",
          providers: providerList(hasClaude, false),
          loadedBy: [
            `Claude loads it ${where}`,
            ...(name === "CLAUDE.local.md" ? ["It is personal: keep it out of git."] : []),
          ],
        };
      }
      // AGENTS.md, AGENTS.override.md, .claude/AGENTS.md, and Codex fallback names.
      // A missing AGENTS.md in the Codex chain would load once created, unless the folder has another.
      const codex: CodexFileStatus | undefined =
        codexStatus.get(file) ??
        (!exists(file) &&
        name === "AGENTS.md" &&
        claudeIndex === -1 &&
        codexChain.includes(folder) &&
        !foldersWithWinner.has(folder)
          ? {
              providers: true,
              sentence: "Codex loads it at the start of every session in this project.",
            }
          : undefined);
      const nestedAgents = !atStart && name === "AGENTS.md" && claudeIndex === -1;
      const codexLoads = hasCodex && (codex?.providers === true || nestedAgents);
      const claudeCandidate = name === "AGENTS.md";
      const folderHasClaudeMd = ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"].some(
        (other) => exists(path.join(folder, other)),
      );
      const claudeLoads = claudeCandidate && claudeReadsAgents && (atStart || !folderHasClaudeMd);
      const sentences: string[] = [];
      if (hasCodex) {
        if (claudeIndex !== -1) sentences.push("Codex does not read .claude/ files.");
        else if (codex !== undefined) sentences.push(codex.sentence);
        else if (nestedAgents) {
          sentences.push(
            `Codex follows it when it changes files in ${folderLabel(folder)} (its instructions point it at nested AGENTS.md).`,
          );
        } else sentences.push("Codex does not load it from this folder.");
      }
      if (hasClaude && claudeCandidate) {
        sentences.push(
          claudeLoads
            ? atStart
              ? "Claude loads it at the start of every session, because this project has no CLAUDE.md (Claude Code 2.1.277 or later)."
              : `Claude loads it when it reads a file in ${folderLabel(folder)}, which has no CLAUDE.md (Claude Code 2.1.277 or later).`
            : "Claude reads CLAUDE.md here instead, unless a CLAUDE.md imports this file.",
        );
      }
      return {
        path: file,
        kind: "agents",
        providers: providerList(claudeLoads, codexLoads),
        loadedBy: sentences,
        ...(codex?.warning === undefined ? {} : { warning: codex.warning }),
      };
    };

    // Root files people create first, then everything found, parents first.
    for (const name of ["CLAUDE.md", "CLAUDE.local.md"]) {
      if (!hasClaude) continue;
      const draft = classify(path.join(root, name), true);
      if (draft) add(draft);
    }
    const rootAgents = classify(path.join(root, "AGENTS.md"), true);
    if (rootAgents) add(rootAgents);
    for (const file of [
      ...ancestorFiles,
      ...[
        ".claude/CLAUDE.md",
        "AGENTS.override.md",
        ".claude/AGENTS.md",
        ...context.codexConfig.fallbackFilenames,
      ].map((name) => path.join(root, name)),
      ...walk.files,
    ]) {
      const draft = classify(file, false);
      if (draft) add(draft);
    }
    // Rules without frontmatter load at start; with `paths` they load on demand.
    for (const [file, draft] of drafts) {
      if (draft.kind === "claude-rule") {
        drafts.set(file, {
          ...draft,
          loadedBy: [yield* ruleSentence(file, draft.loadedBy[0] ?? "")],
        });
      }
    }

    return yield* buildGroup(context, {
      id: `project:${project.id}`,
      scope: "project",
      title: project.title,
      root,
      projectId: project.id,
      providers: providerList(hasClaude, hasCodex),
      truncated: walk.truncated,
      drafts: [...drafts.values()],
    });
  });

  const memoryGroup = Effect.fn("InstructionFiles.memoryGroup")(function* (
    context: ScanContext,
    folder: MemoryFolder,
  ) {
    const index = path.join(folder.directory, "MEMORY.md");
    const indexText = yield* readSmallText(index);
    const overLimit = Option.match(indexText, {
      onNone: () => false,
      onSome: (text) =>
        countLines(text) > CLAUDE_MEMORY_INDEX_MAX_LINES ||
        new TextEncoder().encode(text).byteLength > CLAUDE_MEMORY_INDEX_MAX_BYTES,
    });
    const off = "Auto memory is off for this Claude home, so Claude does not load it.";
    const topics = yield* withPlatform(walkMarkdownFiles(folder.directory, 1));
    const drafts: Draft[] = [
      {
        path: index,
        kind: "claude-memory-index",
        providers: folder.enabled ? ["claude"] : [],
        loadedBy: [
          folder.enabled
            ? "Claude loads its first 200 lines (25 KB) at the start of every session in this repository, worktrees included, and keeps it up to date itself."
            : off,
        ],
        ...(overLimit
          ? { warning: "Only the first 200 lines or 25 KB load at session start." }
          : {}),
      },
      ...topics.files
        .filter((file) => file !== index)
        .map((file): Draft => ({
          path: file,
          kind: "claude-memory",
          providers: folder.enabled ? ["claude"] : [],
          loadedBy: [
            folder.enabled ? "Claude reads it when it needs it; MEMORY.md indexes it." : off,
          ],
        })),
    ];
    const first = folder.projects[0];
    return yield* buildGroup(context, {
      id: `memory:${folder.directory}`,
      scope: "memory",
      title: folder.projects.map((project) => project.title).join(", "),
      root: folder.directory,
      ...(first === undefined ? {} : { projectId: first.id }),
      providers: ["claude"],
      truncated: topics.truncated,
      drafts,
    });
  });

  const scan = Effect.fn("InstructionFiles.scan")(function* (context: ScanContext) {
    const groups: InstructionFileGroup[] = [];
    for (const home of context.claudeHomes) groups.push(yield* claudeGlobalGroup(context, home));
    for (const home of context.codexHomes) groups.push(yield* codexGlobalGroup(context, home));
    const projectGroups = yield* Effect.forEach(
      context.projects,
      (project) => projectGroup(context, project),
      { concurrency: 4 },
    );
    groups.push(...projectGroups);
    for (const folder of context.memoryFolders) groups.push(yield* memoryGroup(context, folder));
    return groups;
  });

  const list: InstructionFiles["Service"]["list"] = Effect.fn("InstructionFiles.list")(
    function* (input) {
      const context = yield* loadContext(input.projectId);
      return {
        groups: yield* scan(context),
        usePersonalInstructions: context.settings.tempoUsePersonalInstructions,
      };
    },
  );

  const notAllowed = (target: string) =>
    new InstructionFileError({ path: target, reason: "not-allowed" });

  /** Where `target` really lands: its real path, or for a new file its nearest real parent plus the rest. */
  const realTarget = Effect.fn("InstructionFiles.realTarget")(function* (target: string) {
    const state = yield* statFile(target);
    if (state.exists) return yield* fileSystem.realPath(target).pipe(Effect.mapError(io(target)));
    // A dangling symlink would create its target, which nothing checked.
    if (state.linkTarget !== undefined) return yield* notAllowed(target);
    const missing: string[] = [];
    let current = target;
    while (!(yield* fileSystem.exists(current).pipe(Effect.orElseSucceed(() => false)))) {
      const parent = path.dirname(current);
      if (parent === current) return yield* notAllowed(target);
      missing.unshift(path.basename(current));
      current = parent;
    }
    const real = yield* fileSystem.realPath(current).pipe(Effect.mapError(io(target)));
    return path.join(real, ...missing);
  });

  /** `allowance` without the search: instruction files by name and place, and parent-folder files. */
  const directAllowance = Effect.fn("InstructionFiles.directAllowance")(function* (
    context: ScanContext,
    target: string,
  ) {
    if (
      matchesInstructionPattern({
        path,
        roots: context.roots,
        projectFileNames: context.projectFileNames,
        target,
      })
    ) {
      return Option.some<ReadonlyArray<string>>([]);
    }
    return ancestorOwner(context, target) === null
      ? Option.none<ReadonlyArray<string>>()
      : Option.some(yield* extraRootsFor(context, target));
  });

  /** Whether `importer`, an instruction file found without a search, imports `target`. */
  const importsDirectly = Effect.fn("InstructionFiles.importsDirectly")(function* (
    context: ScanContext,
    importer: string,
    target: string,
  ) {
    const importerAllowance = yield* directAllowance(context, importer);
    if (Option.isNone(importerAllowance)) return false;
    const real = yield* realPathOrResolved(importer);
    if (resolvedAccess(context, importer, real, importerAllowance.value) !== "ok") return false;
    const content = yield* readSmallText(importer);
    if (Option.isNone(content)) return false;
    const imports = parseClaudeImports(content.value).map((token) =>
      resolveClaudeImport({
        path,
        token,
        fromFile: importer,
        homeDirectory: context.homeDirectory,
      }),
    );
    return imports.includes(target) && (yield* isOpenableImport(context, target));
  });

  /**
   * Which folders `target` may resolve into, or None when it is not an
   * instruction file: by name and place under a root, a project's parent-folder
   * file, an import of `via`, or (last, as it searches every project) any file
   * the list shows, such as an import of an import.
   */
  const allowance = Effect.fn("InstructionFiles.allowance")(function* (
    context: ScanContext,
    target: string,
    via: string | undefined,
  ) {
    const direct = yield* directAllowance(context, target);
    if (Option.isSome(direct)) return direct;
    if (
      via !== undefined &&
      path.isAbsolute(via) &&
      (yield* importsDirectly(context, path.resolve(via), target))
    ) {
      return Option.some<ReadonlyArray<string>>([]);
    }
    const groups = yield* scan(context);
    return groups.some((group) => group.entries.some((entry) => entry.path === target))
      ? Option.some<ReadonlyArray<string>>([])
      : Option.none<ReadonlyArray<string>>();
  });

  /**
   * Allow only instruction files (see `allowance`), resolved through symlinks to
   * a text file inside an allowed folder, or anywhere for a link in a provider home.
   */
  const authorize = Effect.fn("InstructionFiles.authorize")(function* (
    requested: string,
    via: string | undefined,
  ) {
    if (!path.isAbsolute(requested)) return yield* notAllowed(requested);
    const target = path.resolve(requested);
    const context = yield* loadContext(undefined);
    const extraRoots = yield* allowance(context, target, via);
    if (Option.isNone(extraRoots)) return yield* notAllowed(target);
    const real = yield* realTarget(target);
    if (resolvedAccess(context, target, real, extraRoots.value) !== "ok") {
      return yield* new InstructionFileError({
        path: target,
        reason: real === target ? "not-allowed" : "links-outside",
      });
    }
    return { target, context };
  });

  /** A new or removed personal file changes what tempo-managed homes include. */
  const syncPersonalInstructions = (context: ScanContext, target: string) =>
    path.dirname(target) === context.personal.claude ||
    path.dirname(target) === context.personal.codex
      ? withPlatform(
          applyPersonalInstructions(context.settings).pipe(
            Effect.provideService(ServerConfig.ServerConfig, serverConfig),
            Effect.provideService(InstructionProviderInstances, providerInstances),
          ),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not apply personal instructions", { cause }),
          ),
        )
      : Effect.void;

  const read: InstructionFiles["Service"]["read"] = Effect.fn("InstructionFiles.read")(
    function* (input) {
      const { target, context } = yield* authorize(input.path, input.via);
      const state = yield* statFile(target);
      if (!state.exists || state.mtimeMs === null) {
        return yield* new InstructionFileError({ path: target, reason: "not-found" });
      }
      if ((state.size ?? 0) > INSTRUCTION_FILE_MAX_BYTES) {
        return yield* new InstructionFileError({ path: target, reason: "too-large" });
      }
      const bytes = yield* fileSystem.readFile(target).pipe(Effect.mapError(io(target)));
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: (cause) => new InstructionFileError({ path: target, reason: "not-text", cause }),
      });
      const imports: InstructionImport[] = [];
      for (const token of parseClaudeImports(content)) {
        const resolved = resolveClaudeImport({
          path,
          token,
          fromFile: target,
          homeDirectory: context.homeDirectory,
        });
        imports.push({
          token,
          path: resolved,
          exists: (yield* statFile(resolved)).exists,
          openable: yield* isOpenableImport(context, resolved),
        });
      }
      return {
        path: target,
        content,
        size: bytes.byteLength,
        mtimeMs: state.mtimeMs,
        imports,
      };
    },
  );

  const write: InstructionFiles["Service"]["write"] = Effect.fn("InstructionFiles.write")(
    function* (input) {
      const { target, context } = yield* authorize(input.path, input.via);
      const bytes = new TextEncoder().encode(input.content);
      if (bytes.byteLength > INSTRUCTION_FILE_MAX_BYTES) {
        return yield* new InstructionFileError({ path: target, reason: "too-large" });
      }
      const state = yield* statFile(target);
      if (input.expectedMtimeMs === null) {
        if (state.exists) {
          return yield* new InstructionFileError({ path: target, reason: "already-exists" });
        }
      } else if (!state.exists) {
        return yield* new InstructionFileError({ path: target, reason: "not-found" });
      } else if (state.mtimeMs !== input.expectedMtimeMs) {
        return yield* new InstructionFileError({ path: target, reason: "conflict" });
      }
      // Write through a symlink to the file it names, and replace that file in one rename.
      const destination = state.exists
        ? yield* fileSystem.realPath(target).pipe(Effect.mapError(io(target)))
        : target;
      const directory = path.dirname(destination);
      yield* fileSystem
        .makeDirectory(directory, { recursive: true })
        .pipe(Effect.mapError(io(target)));
      const suffix = Math.abs(yield* Random.nextInt).toString(36);
      const temporary = path.join(directory, `.${path.basename(destination)}.tempo-${suffix}.tmp`);
      const mode = state.exists
        ? yield* fileSystem.stat(destination).pipe(
            Effect.map((info) => info.mode & 0o777),
            Effect.orElseSucceed(() => 0o644),
          )
        : 0o644;
      yield* fileSystem.writeFile(temporary, bytes, { mode }).pipe(
        Effect.andThen(fileSystem.chmod(temporary, mode)),
        Effect.andThen(fileSystem.rename(temporary, destination)),
        Effect.mapError(io(target)),
        Effect.tapError(() => fileSystem.remove(temporary).pipe(Effect.ignore)),
      );
      const written = yield* statFile(target);
      if (!state.exists) yield* syncPersonalInstructions(context, target);
      return {
        path: target,
        size: written.size ?? bytes.byteLength,
        mtimeMs: written.mtimeMs ?? 0,
      };
    },
  );

  const remove: InstructionFiles["Service"]["remove"] = Effect.fn("InstructionFiles.remove")(
    function* (input) {
      const { target, context } = yield* authorize(input.path, input.via);
      const state = yield* statFile(target);
      if (!state.exists) {
        return yield* new InstructionFileError({ path: target, reason: "not-found" });
      }
      if (state.mtimeMs !== input.expectedMtimeMs) {
        return yield* new InstructionFileError({ path: target, reason: "conflict" });
      }
      // A symlinked file loses the link, never the file it points to.
      yield* fileSystem.remove(target).pipe(Effect.mapError(io(target)));
      yield* syncPersonalInstructions(context, target);
    },
  );

  return InstructionFiles.of({ list, read, write, remove });
});

export const layer = Layer.effect(InstructionFiles, make);
