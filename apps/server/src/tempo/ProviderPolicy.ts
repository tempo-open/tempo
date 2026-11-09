/**
 * The provider rules, as pure functions. Tempo runs exactly two instances, Claude and Codex, always
 * enabled, each on this Mac's own sign-in. Settings may tune harmless options but never how a
 * provider launches; such edits fail with `TempoManagedProviderError`.
 */
import {
  TEMPO_MANAGED_PROVIDER_IDS,
  TEMPO_MANAGED_PROVIDER_NAMES,
  TempoManagedProviderError,
  type TempoManagedProviderId,
  isTempoManagedProvider,
  type ModelSelection,
  type ProjectSettingsOverrides,
  ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
  type ProviderInstanceEnvironmentVariable,
  ProviderInstanceId,
  type ProviderInstanceMutation,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { fallbackTextGenerationModelSelection } from "@t3tools/shared/serverSettings";
import * as Equal from "effect/Equal";
import type * as Types from "effect/Types";

const TEMPO_CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");
const TEMPO_CODEX_INSTANCE_ID = ProviderInstanceId.make("codex");

/**
 * Config keys that decide how a provider launches. Settings may not change
 * them on a managed instance; the policy sets the ones it needs itself.
 */
const LAUNCH_CONFIG_KEYS = [
  "enabled",
  "binaryPath",
  "homePath",
  "shadowHomePath",
  "launchArgs",
  "setupMode",
  "customModels",
] as const;

// Variables that would send a provider to another backend or with another
// credential. Removed from the process environment every provider inherits.
const PROVIDER_VARIABLE_PREFIXES = [
  "ANTHROPIC_",
  "OPENAI_",
  "AZURE_OPENAI_",
  "CLAUDE_CODE_USE_",
  "CLAUDE_CODE_SKIP_",
  "CLAUDE_CODE_OAUTH_",
] as const;
const PROVIDER_VARIABLES = new Set([
  "AWS_BEARER_TOKEN_BEDROCK",
  "CLAUDE_CONFIG_DIR",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "T3CODE_CODEX_LAUNCH_ARGS",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "MISTRAL_API_KEY",
  "GROQ_API_KEY",
  "XAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_HOST",
  "VERTEX_PROJECT_ID",
]);

/** Whether a process variable could redirect a provider or carry a credential other than its own login. */
const isProviderCredentialVariable = (name: string): boolean => {
  const upper = name.toUpperCase();
  return (
    PROVIDER_VARIABLES.has(upper) ||
    PROVIDER_VARIABLE_PREFIXES.some((prefix) => upper.startsWith(prefix))
  );
};

/** A copy of `env` without provider credentials or backend overrides. */
export function sanitizeProviderEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!isProviderCredentialVariable(name)) next[name] = value;
  }
  return next;
}

/**
 * Codex's home: this Mac's own (`$CODEX_HOME`, else `~/.codex`), else
 * `<baseDir>/provider-homes/codex` when that home lies inside Tempo's own data.
 */
export const codexHomeOf = (
  nativeCodexHome: string | null,
  baseDir: string,
  join: (...segments: Array<string>) => string,
): string => nativeCodexHome ?? join(baseDir, "provider-homes", "codex");

const variable = (name: string, value: string): ProviderInstanceEnvironmentVariable => ({
  name,
  value,
  sensitive: false,
});

/**
 * Instance variables for Claude. CLAUDE_CONFIG_DIR stays unset, so Claude Code reads its own login
 * and `~/.claude.json` (the person's MCP servers). The scrub flag makes Claude Code strip its
 * credentials from Bash, hooks, and stdio MCP servers, as Codex's `shell_environment_policy.exclude`
 * does for its tool shells.
 */
const claudeEnvironment = (): Array<ProviderInstanceEnvironmentVariable> => [
  variable("CLAUDE_CODE_SUBPROCESS_ENV_SCRUB", "1"),
  // On both providers so the agents' shells inherit it: a repository's
  // prepare-commit-msg hook can read it to tell agents' commits apart.
  // Tempo's own Commit action sets it too (vcs/GitVcsDriverCore.ts).
  variable("TEMPO_AGENT", "1"),
];

/** Instance variables for Codex: its own CODEX_HOME. */
const codexEnvironment = (codexHome: string): Array<ProviderInstanceEnvironmentVariable> => [
  variable("CODEX_HOME", codexHome),
  variable("TEMPO_AGENT", "1"),
];

const tunableConfig = (config: unknown): Record<string, unknown> => {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return {};
  const next: Record<string, unknown> = { ...(config as Record<string, unknown>) };
  for (const key of LAUNCH_CONFIG_KEYS) delete next[key];
  return next;
};

/**
 * The two managed instances, whatever settings.json holds. Kept settings:
 * the instance's tunable config (never its launch keys) and its accent color.
 */
export function managedProviderInstanceConfigMap(
  settings: Pick<ServerSettings, "providerInstances">,
  codexHome: string,
): ProviderInstanceConfigMap {
  const saved = (id: TempoManagedProviderId): ProviderInstanceConfig | undefined => {
    const entry = settings.providerInstances[ProviderInstanceId.make(id)];
    return entry?.driver === id ? entry : undefined;
  };
  const envelope = (
    id: TempoManagedProviderId,
    environment: Array<ProviderInstanceEnvironmentVariable>,
    config: Record<string, unknown>,
  ): ProviderInstanceConfig => {
    const accentColor = saved(id)?.accentColor;
    return {
      driver: ProviderDriverKind.make(id),
      displayName: TEMPO_MANAGED_PROVIDER_NAMES[id],
      ...(accentColor === undefined ? {} : { accentColor }),
      enabled: true,
      environment,
      config,
    };
  };
  return {
    [TEMPO_CLAUDE_INSTANCE_ID]: envelope(
      "claudeAgent",
      claudeEnvironment(),
      tunableConfig(saved("claudeAgent")?.config),
    ),
    [TEMPO_CODEX_INSTANCE_ID]: envelope("codex", codexEnvironment(codexHome), {
      ...tunableConfig(saved("codex")?.config),
      setupMode: "managed",
      homePath: codexHome,
    }),
  } as ProviderInstanceConfigMap;
}

const launchConfig = (config: unknown) => {
  const record =
    config !== null && typeof config === "object" && !Array.isArray(config)
      ? (config as Record<string, unknown>)
      : {};
  // Absent, empty, and default values all mean "not set".
  const isUnset = (key: (typeof LAUNCH_CONFIG_KEYS)[number], value: unknown) =>
    value === undefined ||
    value === "" ||
    (key === "enabled" && value === true) ||
    (Array.isArray(value) && value.length === 0);
  return Object.fromEntries(
    LAUNCH_CONFIG_KEYS.flatMap((key) => (isUnset(key, record[key]) ? [] : [[key, record[key]]])),
  );
};

/**
 * Refuses a settings mutation that would add a provider, remove a managed
 * one, or change how one launches. Returns undefined when it is allowed.
 * Settings writes that keep a managed instance's launch config as it is
 * (renaming accent colours, tuning auto-compact) pass.
 */
export function checkProviderInstanceMutation(
  current: Pick<ServerSettings, "providerInstances">,
  mutation: ProviderInstanceMutation | undefined,
): TempoManagedProviderError | undefined {
  if (mutation === undefined) return undefined;
  const refuse = () =>
    new TempoManagedProviderError({
      instanceId: mutation.instanceId,
      operation: mutation.operation,
    });
  if (!isTempoManagedProvider(mutation.instanceId)) return refuse();
  if (mutation.operation === "remove") return refuse();
  const next = mutation.instance;
  if (String(next.driver) !== String(mutation.instanceId)) return refuse();
  if (next.enabled === false) return refuse();
  const previous = current.providerInstances[mutation.instanceId];
  // Clients send back the envelope they read, with saved secrets redacted;
  // any other variable, or another value, is an edit.
  const previousEnvironment = previous?.environment ?? [];
  const unchanged = (entry: ProviderInstanceEnvironmentVariable) =>
    previousEnvironment.some(
      (old) =>
        old.name === entry.name &&
        (old.value === entry.value || (entry.valueRedacted === true && entry.value === "")),
    );
  if (!(next.environment ?? []).every(unchanged)) return refuse();
  const previousLaunch = previous?.driver === next.driver ? previous.config : undefined;
  return Equal.equals(launchConfig(previousLaunch), launchConfig(next.config))
    ? undefined
    : refuse();
}

/**
 * Refuses any settings write that `checkProviderInstanceMutation` would, also
 * when it comes as a whole `providerInstances` map, and project overrides
 * that would turn Claude or Codex off or name another instance.
 */
export function checkSettingsWrite(
  current: Pick<ServerSettings, "providerInstances">,
  patch: Pick<ServerSettingsPatch, "providerInstances" | "projectSettingsOverrides">,
  mutation: ProviderInstanceMutation | undefined,
): TempoManagedProviderError | undefined {
  const mutationRefusal = checkProviderInstanceMutation(current, mutation);
  if (mutationRefusal !== undefined) return mutationRefusal;
  if (patch.providerInstances !== undefined) {
    const next: Readonly<Record<string, ProviderInstanceConfig | undefined>> =
      patch.providerInstances;
    const ids = new Set([...Object.keys(next), ...TEMPO_MANAGED_PROVIDER_IDS]);
    for (const id of ids) {
      const instance = next[id];
      const refusal =
        instance === undefined
          ? new TempoManagedProviderError({ instanceId: id, operation: "remove" })
          : checkProviderInstanceMutation(current, {
              operation: "upsert",
              instanceId: ProviderInstanceId.make(id),
              instance,
            });
      if (refusal !== undefined) return refusal;
    }
  }
  for (const override of Object.values(patch.projectSettingsOverrides ?? {})) {
    for (const [id, entry] of Object.entries(override?.providerInstances ?? {})) {
      if (!isTempoManagedProvider(id) || entry.enabled === false) {
        return new TempoManagedProviderError({ instanceId: id, operation: "project-override" });
      }
    }
  }
  return undefined;
}

const namesManagedProvider = (selection: ModelSelection | null | undefined): boolean =>
  selection === null || selection === undefined || isTempoManagedProvider(selection.instanceId);

const PROJECT_SELECTION_KEYS = [
  "defaultModelSelection",
  "textGenerationModelSelection",
  "sourceControlWriterModelSelection",
  "reviewGuideModelSelection",
] as const;

/** A project's overrides without provider switches or selections of other instances. */
const projectOverridesView = (overrides: ProjectSettingsOverrides): ProjectSettingsOverrides => {
  const { providerInstances: _providerInstances, ...rest } = overrides;
  const next: Types.Mutable<ProjectSettingsOverrides> = { ...rest };
  // An override that names another instance is dropped, so the project inherits.
  for (const key of PROJECT_SELECTION_KEYS) {
    if (!namesManagedProvider(next[key])) delete next[key];
  }
  return next;
};

/**
 * Settings as everything in Tempo reads them, so code outside the provider registry agrees with it:
 * Claude and Codex are the only instances, always enabled (project overrides too), with the homes
 * they run from and no saved environment; other selections fall back to them, and Cursor's
 * keychain usage reader stays off. Applied on every read: the file converges as clients write back.
 */
export function tempoProviderSettingsView(
  settings: ServerSettings,
  codexHome: string,
): ServerSettings {
  const instance = (id: TempoManagedProviderId, homePath?: string): ProviderInstanceConfig => {
    const saved = settings.providerInstances[ProviderInstanceId.make(id)];
    const kept = saved?.driver === id ? saved : undefined;
    return {
      driver: ProviderDriverKind.make(id),
      displayName: TEMPO_MANAGED_PROVIDER_NAMES[id],
      ...(kept?.accentColor === undefined ? {} : { accentColor: kept.accentColor }),
      config: { ...tunableConfig(kept?.config), ...(homePath === undefined ? {} : { homePath }) },
    };
  };
  const providerInstances = {
    [TEMPO_CLAUDE_INSTANCE_ID]: instance("claudeAgent"),
    [TEMPO_CODEX_INSTANCE_ID]: instance("codex", codexHome),
  } as ServerSettings["providerInstances"];
  const textGenerationFallback = fallbackTextGenerationModelSelection(
    providerInstances,
    isTempoManagedProvider,
  );
  return {
    ...settings,
    providerInstances,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([projectId, overrides]) => [
        projectId,
        projectOverridesView(overrides),
      ]),
    ) as ServerSettings["projectSettingsOverrides"],
    defaultModelSelection: namesManagedProvider(settings.defaultModelSelection)
      ? settings.defaultModelSelection
      : null,
    textGenerationModelSelection:
      namesManagedProvider(settings.textGenerationModelSelection) || textGenerationFallback === null
        ? settings.textGenerationModelSelection
        : textGenerationFallback,
    sourceControlWriterModelSelection: namesManagedProvider(
      settings.sourceControlWriterModelSelection,
    )
      ? settings.sourceControlWriterModelSelection
      : null,
    reviewGuideModelSelection: namesManagedProvider(settings.reviewGuideModelSelection)
      ? settings.reviewGuideModelSelection
      : null,
    cursorKeychainUsageEnabled: false,
  };
}
