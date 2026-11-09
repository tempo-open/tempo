/**
 * Tempo: where Claude and Codex sessions read instruction files. The Instructions page and the
 * personal instructions sync resolve homes only through these functions, from the configs
 * `InstructionProviderInstances` returns, so the page shows what a new session loads. Only the
 * person's instructions are shared, never their credentials, settings or environment.
 */
import {
  ClaudeSettings,
  CodexSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type InstructionProvider,
  type PersonalInstructionsState,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { resolveManagedCodexHomeLayout } from "../provider/CodexManagedHome.ts";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import * as ServerSettingsModule from "../serverSettings.ts";

const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");

/**
 * The instance configs new provider sessions launch with. Upstream T3 derives them from settings;
 * on tempo, server.ts provides `layerFrom(TempoManagedProviders.configMap)`, the provider policy's.
 */
export class InstructionProviderInstances extends Context.Service<
  InstructionProviderInstances,
  {
    readonly configMap: (settings: ServerSettings) => Effect.Effect<ProviderInstanceConfigMap>;
  }
>()("t3/tempo/InstructionRoots/InstructionProviderInstances") {
  static readonly layerFrom = <R>(
    configMap: (settings: ServerSettings) => Effect.Effect<ProviderInstanceConfigMap, never, R>,
  ) =>
    Layer.effect(
      InstructionProviderInstances,
      Effect.gen(function* () {
        const context = yield* Effect.context<R>();
        return InstructionProviderInstances.of({
          configMap: Effect.fn("InstructionProviderInstances.configMap")(function (settings) {
            return configMap(settings).pipe(Effect.provideContext(context));
          }),
        });
      }),
    );

  /** Upstream hydration: settings entries plus each built-in default instance. */
  static readonly layer = InstructionProviderInstances.layerFrom((settings) =>
    Effect.succeed(deriveProviderInstanceConfigMap(settings)),
  );
}

/** One folder a provider reads its global instructions from, and the instances using it. */
export interface InstructionHome {
  readonly provider: InstructionProvider;
  readonly home: string;
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  /** The environment the provider runs with; auto memory naming reads it. */
  readonly environment: NodeJS.ProcessEnv;
}

/** The effective CLAUDE_CONFIG_DIR of a Claude instance. */
const resolveClaudeInstructionHome = Effect.fn("resolveClaudeInstructionHome")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
) {
  return yield* resolveClaudeHomePath(config, environment);
});

/**
 * The folder whose AGENTS.md a Codex instance reads. A shadow (auth overlay)
 * home links every shared entry, AGENTS.md included, so its instructions live
 * in the shared home.
 */
export const resolveCodexInstructionHome = Effect.fn("resolveCodexInstructionHome")(function* (
  instanceId: ProviderInstanceId,
  config: CodexSettings,
  environment: NodeJS.ProcessEnv,
  stateDir: string,
) {
  const path = yield* Path.Path;
  if (config.setupMode === "managed") {
    const layout = yield* resolveManagedCodexHomeLayout(stateDir, instanceId, config);
    return layout.mode === "authOverlay"
      ? layout.sharedHomePath
      : (layout.effectiveHomePath ?? layout.sharedHomePath);
  }
  const layout = yield* resolveCodexHomeLayout(config);
  if (layout.mode === "authOverlay") return layout.sharedHomePath;
  // Without a configured home T3 leaves CODEX_HOME to the inherited environment.
  const inherited = environment.CODEX_HOME?.trim() ?? "";
  if (config.homePath.trim().length === 0 && inherited.length > 0) {
    return path.resolve(expandHomePath(inherited, yield* HostProcess.HomeDirectory));
  }
  return layout.sharedHomePath;
});

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);

/** Every distinct Claude and Codex instruction home among the enabled instances of `configMap`. */
export const resolveInstructionHomes = Effect.fn("resolveInstructionHomes")(function* (
  configMap: ProviderInstanceConfigMap,
  stateDir: string,
) {
  const hostEnvironment = yield* HostProcess.Environment;
  const homes = new Map<string, InstructionHome>();
  for (const [rawId, instance] of Object.entries(configMap)) {
    if (instance.driver !== CLAUDE_DRIVER_KIND && instance.driver !== CODEX_DRIVER_KIND) continue;
    if (!resolveProviderInstanceEnabled(instance)) continue;
    const instanceId = ProviderInstanceId.make(rawId);
    const environment = yield* mergeProviderInstanceEnvironment(
      instance.environment,
      hostEnvironment,
    );
    let provider: InstructionProvider;
    let home: string;
    if (instance.driver === CLAUDE_DRIVER_KIND) {
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      provider = "claude";
      home = yield* resolveClaudeInstructionHome(config.value, environment);
    } else {
      const config = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(config)) continue;
      provider = "codex";
      home = yield* resolveCodexInstructionHome(instanceId, config.value, environment, stateDir);
    }
    const key = `${provider}\0${home}`;
    const existing = homes.get(key);
    homes.set(
      key,
      existing === undefined
        ? { provider, home, instanceIds: [instanceId], environment }
        : { ...existing, instanceIds: [...existing.instanceIds, instanceId] },
    );
  }
  return [...homes.values()];
});

/**
 * The person's own Claude config dir and Codex home, from the server's
 * environment, and their Agent Skills folder, which Codex reads from the home
 * folder whatever CODEX_HOME says.
 */
export const resolvePersonalInstructionDirs = Effect.fn("resolvePersonalInstructionDirs")(
  function* () {
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    const environment = yield* HostProcess.Environment;
    const fromEnvironment = (value: string | undefined, fallback: string) => {
      const trimmed = value?.trim() ?? "";
      return path.resolve(trimmed.length > 0 ? expandHomePath(trimmed, home) : fallback);
    };
    return {
      claude: fromEnvironment(environment.CLAUDE_CONFIG_DIR, path.join(home, ".claude")),
      codex: fromEnvironment(environment.CODEX_HOME, path.join(home, ".codex")),
      agents: path.resolve(home, ".agents"),
    };
  },
);

const isInside = (path: Path.Path, root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/** Homes under the server's base directory are tempo's to change; any other home is the person's. */
const isTempoManagedHome = Effect.fn("isTempoManagedHome")(function* (
  home: string,
  baseDir: string,
) {
  const path = yield* Path.Path;
  return isInside(path, path.resolve(baseDir), path.resolve(home));
});

/** Whether a file exists and holds more than whitespace, the way Codex decides a file counts. */
const hasText = Effect.fn("hasText")(function* (file: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
  return Option.isSome(text) && text.value.trim().length > 0;
});

/**
 * The file a provider treats as the person's global instructions: Claude's
 * CLAUDE.md, and for Codex AGENTS.override.md when it has text, else AGENTS.md.
 */
export const personalInstructionFile = Effect.fn("personalInstructionFile")(function* (
  provider: InstructionProvider,
  personalDir: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  if (provider === "claude") return path.join(personalDir, "CLAUDE.md");
  const override = path.join(personalDir, "AGENTS.override.md");
  return (yield* hasText(override)) ? override : path.join(personalDir, "AGENTS.md");
});

const readLinkOption = (fileSystem: FileSystem.FileSystem, linkPath: string) =>
  fileSystem
    .readLink(linkPath)
    .pipe(
      Effect.asSome,
      Effect.catchTags({ PlatformError: () => Effect.succeed(Option.none<string>()) }),
    );

/** Where `<home>/AGENTS.md` links, if it is a link Tempo made to one of the person's Codex files. */
const personalCodexLink = Effect.fn("personalCodexLink")(function* (
  home: string,
  personalDir: string,
): Effect.fn.Return<Option.Option<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeFile = path.join(home, "AGENTS.md");
  const link = yield* readLinkOption(fileSystem, homeFile);
  if (Option.isNone(link)) return Option.none();
  const target = path.resolve(path.dirname(homeFile), link.value);
  return path.dirname(target) === path.resolve(personalDir) &&
    (path.basename(target) === "AGENTS.md" || path.basename(target) === "AGENTS.override.md")
    ? Option.some(target)
    : Option.none();
});

interface PersonalInstructionsInput {
  readonly provider: InstructionProvider;
  readonly home: string;
  readonly personalDir: string;
  readonly baseDir: string;
  readonly enabled: boolean;
}

/**
 * What new sessions using `home` get of the person's own instruction file.
 * Read-only: `ensurePersonalInstructions` applies it.
 */
export const personalInstructionsState = Effect.fn("personalInstructionsState")(function* (
  input: PersonalInstructionsInput,
): Effect.fn.Return<PersonalInstructionsState, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const realPath = (value: string) =>
    fileSystem.realPath(value).pipe(Effect.orElseSucceed(() => path.resolve(value)));
  if ((yield* realPath(input.home)) === (yield* realPath(input.personalDir))) return "direct";
  if (!(yield* isTempoManagedHome(input.home, input.baseDir))) return "excluded";
  if (!input.enabled) return "excluded";
  const personalFile = yield* personalInstructionFile(input.provider, input.personalDir);
  const exists = yield* fileSystem.exists(personalFile).pipe(Effect.orElseSucceed(() => false));
  if (!exists) return "missing";
  if (input.provider === "claude") return "included";
  // Codex reads one global file: Tempo's own override or AGENTS.md keep the link out.
  if (yield* hasText(path.join(input.home, "AGENTS.override.md"))) return "blocked";
  const homeFile = path.join(input.home, "AGENTS.md");
  if (Option.isSome(yield* personalCodexLink(input.home, input.personalDir))) return "included";
  const homeFileExists = yield* fileSystem.exists(homeFile).pipe(Effect.orElseSucceed(() => false));
  const isLink = Option.isSome(yield* readLinkOption(fileSystem, homeFile));
  return homeFileExists && !isLink ? "blocked" : "included";
});

const PERSONAL_BLOCK_START =
  "<!-- tempo: your personal instructions. Tempo manages this block; turn it off in Settings > Instructions. -->";
const PERSONAL_BLOCK_END = "<!-- tempo: end of personal instructions -->";

/** Claude import syntax: a backslash before each space. */
const claudeImportPath = (value: string) => value.replaceAll(" ", "\\ ");

/** Drop the tempo-managed import block, leaving the rest of the file as written. */
export function stripPersonalInstructionsBlock(content: string): string {
  const start = content.indexOf(PERSONAL_BLOCK_START);
  if (start === -1) return content;
  const endMarker = content.indexOf(PERSONAL_BLOCK_END, start);
  if (endMarker === -1) return content;
  let end = endMarker + PERSONAL_BLOCK_END.length;
  while (content[end] === "\n") end += 1;
  return content.slice(0, start) + content.slice(end);
}

/** Put the import block first, so a person's file reads before tempo's own instructions. */
function withPersonalInstructionsBlock(content: string, personalFile: string): string {
  const rest = stripPersonalInstructionsBlock(content);
  const block = `${PERSONAL_BLOCK_START}\n@${claudeImportPath(personalFile)}\n${PERSONAL_BLOCK_END}\n`;
  return rest.length === 0 ? block : `${block}\n${rest}`;
}

/**
 * Links `<home>/rules` to the person's Claude rules folder while personal
 * instructions are on and the folder exists, and removes that link otherwise.
 * A real folder, or a link someone else made, stays.
 */
const ensurePersonalRulesLink = Effect.fn("ensurePersonalRulesLink")(function* (
  home: string,
  personalDir: string,
  enabled: boolean,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const homeRules = path.join(home, "rules");
  const personalRules = path.join(personalDir, "rules");
  const include =
    enabled &&
    (yield* fileSystem.stat(personalRules).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    ));
  const link = yield* readLinkOption(fileSystem, homeRules);
  if (Option.isSome(link)) {
    if (!include && path.resolve(home, link.value) === personalRules) {
      yield* fileSystem.remove(homeRules);
    }
    return;
  }
  if (!include || (yield* fileSystem.exists(homeRules))) return;
  yield* fileSystem.makeDirectory(home, { recursive: true });
  yield* fileSystem.symlink(personalRules, homeRules);
});

/**
 * Make a tempo-managed provider home include (or stop including) the person's global instructions.
 * Claude gets an `@` import atop the home's CLAUDE.md and a `rules` link to the person's rules
 * folder; Codex has no imports, so its AGENTS.md becomes a symlink to the person's file. Files
 * someone else put there stay, and homes tempo does not manage are untouched.
 */
export const ensurePersonalInstructions = Effect.fn("ensurePersonalInstructions")(function* (
  input: PersonalInstructionsInput,
): Effect.fn.Return<void, PlatformError.PlatformError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!(yield* isTempoManagedHome(input.home, input.baseDir))) return;
  const home = path.resolve(input.home);
  const personalDir = path.resolve(input.personalDir);
  if (home === personalDir) return;
  const personalFile = yield* personalInstructionFile(input.provider, personalDir);
  const include = input.enabled && (yield* fileSystem.exists(personalFile));

  if (input.provider === "claude") {
    const homeFile = path.join(home, "CLAUDE.md");
    const current = (yield* fileSystem.exists(homeFile))
      ? yield* fileSystem.readFileString(homeFile)
      : null;
    const next = include
      ? withPersonalInstructionsBlock(current ?? "", personalFile)
      : current === null
        ? null
        : stripPersonalInstructionsBlock(current);
    if (next !== null && next !== current) {
      yield* fileSystem.makeDirectory(home, { recursive: true });
      yield* fileSystem.writeFileString(homeFile, next);
    }
    yield* ensurePersonalRulesLink(home, personalDir, input.enabled);
    return;
  }

  const homeFile = path.join(home, "AGENTS.md");
  const personalLink = yield* personalCodexLink(home, personalDir);
  if (include) {
    if (Option.isSome(personalLink) && personalLink.value === personalFile) return;
    if (Option.isSome(personalLink)) yield* fileSystem.remove(homeFile);
    // A real file, or a link someone else made, stays.
    else if (yield* fileSystem.exists(homeFile)) return;
    else if (Option.isSome(yield* readLinkOption(fileSystem, homeFile))) return;
    yield* fileSystem.makeDirectory(home, { recursive: true });
    yield* fileSystem.symlink(personalFile, homeFile);
    return;
  }
  if (Option.isSome(personalLink)) yield* fileSystem.remove(homeFile);
});

/**
 * Apply `settings.tempoUsePersonalInstructions` to every tempo-managed Claude and
 * Codex home new sessions use. Failures are logged; sessions still start.
 */
export const applyPersonalInstructions = Effect.fn("applyPersonalInstructions")(function* (
  settings: ServerSettings,
) {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const instances = yield* InstructionProviderInstances;
  const homes = yield* resolveInstructionHomes(
    yield* instances.configMap(settings),
    serverConfig.stateDir,
  );
  const personal = yield* resolvePersonalInstructionDirs();
  yield* Effect.forEach(
    homes,
    (home) =>
      ensurePersonalInstructions({
        provider: home.provider,
        home: home.home,
        personalDir: personal[home.provider],
        baseDir: serverConfig.baseDir,
        enabled: settings.tempoUsePersonalInstructions,
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not apply personal instructions", { home: home.home, cause }),
        ),
      ),
    { discard: true },
  );
});

/** Applies personal instructions at startup and on every settings change. */
export const layerPersonalInstructionsSync = Layer.effectDiscard(
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsModule.ServerSettingsService;
    const changes = yield* serverSettings.subscribeChanges;
    const apply = (settings: ServerSettings) =>
      applyPersonalInstructions(settings).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Personal instructions sync failed", { cause }),
        ),
      );
    yield* serverSettings.getSettings.pipe(
      Effect.flatMap(apply),
      Effect.catchCause((cause) => Effect.logWarning("Could not read settings", { cause })),
    );
    // Applying is idempotent and writes nothing when a home is already right.
    yield* changes.pipe(
      Stream.runForEach(apply),
      Effect.catchCause((cause) =>
        Effect.logWarning("Personal instructions sync stopped", { cause }),
      ),
      Effect.forkScoped,
    );
  }),
);

/**
 * Claude Code's folder name for a project under `<config dir>/projects/`:
 * every character other than a letter or digit becomes `-`.
 */
export function encodeClaudeProjectDirName(projectRoot: string): string {
  return projectRoot.replace(/[^a-zA-Z0-9]/g, "-");
}

/** Claude Code shortens names past this length and appends a hash it does not document. */
const CLAUDE_PROJECT_DIR_NAME_MAX = 200;

/**
 * The repository folder Claude Code keys auto memory by: the main checkout of a
 * git repository (so worktrees share it), else the folder itself.
 */
const resolveClaudeMemoryProjectRoot = Effect.fn("resolveClaudeMemoryProjectRoot")(function* (
  cwd: string,
): Effect.fn.Return<string, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // Claude names the folder after its working directory as the OS reports it, symlinks resolved.
  const start = yield* fileSystem.realPath(cwd).pipe(Effect.orElseSucceed(() => path.resolve(cwd)));
  let directory = start;
  while (true) {
    const dotGit = path.join(directory, ".git");
    const info = yield* fileSystem.stat(dotGit).pipe(Effect.option);
    if (Option.isSome(info)) {
      if (info.value.type === "Directory") return directory;
      const pointer = yield* fileSystem.readFileString(dotGit).pipe(Effect.option);
      const gitDir = Option.isSome(pointer)
        ? /^gitdir:\s*(.+)$/m.exec(pointer.value)?.[1]?.trim()
        : undefined;
      if (gitDir === undefined) return directory;
      const absoluteGitDir = path.resolve(directory, gitDir);
      const commonDir = yield* fileSystem
        .readFileString(path.join(absoluteGitDir, "commondir"))
        .pipe(Effect.option);
      if (Option.isNone(commonDir)) return directory;
      const common = path.resolve(absoluteGitDir, commonDir.value.trim());
      return path.basename(common) === ".git" ? path.dirname(common) : common;
    }
    const parent = path.dirname(directory);
    if (parent === directory) return start;
    directory = parent;
  }
});

/** Settings in `<config dir>/settings.json` that move or disable auto memory. */
const ClaudeMemorySettings = Schema.Struct({
  autoMemoryEnabled: Schema.optionalKey(Schema.Boolean),
  autoMemoryDirectory: Schema.optionalKey(Schema.String),
});
const decodeClaudeMemorySettings = Schema.decodeUnknownOption(
  Schema.fromJsonString(ClaudeMemorySettings),
);

/** Where Claude keeps auto memory for sessions started in `cwd` with this config dir. */
export const resolveClaudeMemoryDir = Effect.fn("resolveClaudeMemoryDir")(function* (input: {
  readonly configDir: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}): Effect.fn.Return<
  { readonly directory: string; readonly enabled: boolean },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const settingsText = yield* fileSystem
    .readFileString(path.join(input.configDir, "settings.json"))
    .pipe(Effect.option);
  const settings = Option.flatMap(settingsText, decodeClaudeMemorySettings);
  const enabled =
    input.environment.CLAUDE_CODE_DISABLE_AUTO_MEMORY !== "1" &&
    Option.match(settings, {
      onNone: () => true,
      onSome: (value) => value.autoMemoryEnabled !== false,
    });
  const customDirectory = Option.flatMapNullishOr(settings, (value) => value.autoMemoryDirectory);
  if (Option.isSome(customDirectory) && customDirectory.value.trim().length > 0) {
    return {
      directory: path.resolve(expandHomePath(customDirectory.value.trim(), home)),
      enabled,
    };
  }
  const projectsDir = path.join(input.configDir, "projects");
  const fixedName = input.environment.CLAUDE_CODE_PROJECT_DIR_NAME?.trim() ?? "";
  let name =
    fixedName.length > 0
      ? fixedName
      : encodeClaudeProjectDirName(yield* resolveClaudeMemoryProjectRoot(input.cwd));
  if (name.length > CLAUDE_PROJECT_DIR_NAME_MAX) {
    const prefix = name.slice(0, CLAUDE_PROJECT_DIR_NAME_MAX);
    const existing = yield* fileSystem.readDirectory(projectsDir).pipe(Effect.option);
    const match = Option.flatMap(existing, (names) =>
      Option.fromNullishOr(names.find((candidate) => candidate.startsWith(prefix))),
    );
    name = Option.getOrElse(match, () => prefix);
  }
  return { directory: path.join(projectsDir, name, "memory"), enabled };
});

/** Codex's `config.toml` keys that change which project instruction files load. */
export interface CodexProjectDocConfig {
  readonly maxBytes: number;
  readonly fallbackFilenames: ReadonlyArray<string>;
  readonly rootMarkers: ReadonlyArray<string>;
}

export const CODEX_DEFAULT_PROJECT_DOC_CONFIG: CodexProjectDocConfig = {
  maxBytes: 32 * 1024,
  fallbackFilenames: [],
  rootMarkers: [".git"],
};

/** Codex ignores fallback names that are not a single file name, and so does every lookup here. */
const isPlainFileName = (name: string) =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("/") &&
  !name.includes("\\") &&
  !name.includes("\0");

const tomlStringArray = (value: string): ReadonlyArray<string> | undefined => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  const items: string[] = [];
  for (const match of trimmed.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g)) {
    items.push(match[1] ?? match[2] ?? "");
  }
  return items;
};

/**
 * Read the top-level `project_doc_*` and `project_root_markers` keys from a
 * Codex config.toml. Only those three keys are read, so this is not a TOML parser.
 */
export function parseCodexProjectDocConfig(toml: string): CodexProjectDocConfig {
  let { maxBytes, fallbackFilenames, rootMarkers } = CODEX_DEFAULT_PROJECT_DOC_CONFIG;
  const lines = toml.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.replace(/\s+#.*$/, "").trim();
    if (line.startsWith("[")) break;
    const match = /^([A-Za-z_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    // Multi-line arrays continue until the closing bracket.
    while (value.trim().startsWith("[") && !value.includes("]") && index + 1 < lines.length) {
      index += 1;
      value += lines[index]!.replace(/\s+#.*$/, "");
    }
    if (match[1] === "project_doc_max_bytes") {
      const bytes = Number(value.trim().replaceAll("_", ""));
      if (Number.isInteger(bytes) && bytes >= 0) maxBytes = bytes;
    } else if (match[1] === "project_doc_fallback_filenames") {
      const names = tomlStringArray(value);
      if (names) {
        fallbackFilenames = [
          ...new Set(
            names.filter(
              (name) =>
                isPlainFileName(name) && name !== "AGENTS.md" && name !== "AGENTS.override.md",
            ),
          ),
        ];
      }
    } else if (match[1] === "project_root_markers") {
      rootMarkers = tomlStringArray(value) ?? rootMarkers;
    }
  }
  return { maxBytes, fallbackFilenames, rootMarkers };
}

export const readCodexProjectDocConfig = Effect.fn("readCodexProjectDocConfig")(function* (
  codexHome: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const toml = yield* fileSystem
    .readFileString(path.join(codexHome, "config.toml"))
    .pipe(Effect.option);
  return Option.match(toml, {
    onNone: () => CODEX_DEFAULT_PROJECT_DOC_CONFIG,
    onSome: parseCodexProjectDocConfig,
  });
});
