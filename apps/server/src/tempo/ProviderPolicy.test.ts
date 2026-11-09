import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  type ProviderInstanceConfig,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceMutation,
  resolveProjectProviderInstanceEnabled,
  type ServerSettings,
} from "@t3tools/contracts";

import {
  checkProviderInstanceMutation,
  codexHomeOf,
  tempoProviderSettingsView,
  managedProviderInstanceConfigMap,
  sanitizeProviderEnvironment,
} from "./ProviderPolicy.ts";

const codexHome = "/Users/ada/.codex";

const instance = (
  driver: string,
  extra: Partial<Omit<ProviderInstanceConfig, "driver">> = {},
): ProviderInstanceConfig => ({ driver: ProviderDriverKind.make(driver), ...extra });

const settingsWith = (entries: Record<string, ProviderInstanceConfig>) => ({
  providerInstances: Object.fromEntries(
    Object.entries(entries).map(([id, entry]) => [ProviderInstanceId.make(id), entry]),
  ),
});

const env = (entry: ProviderInstanceConfig | undefined) =>
  Object.fromEntries((entry?.environment ?? []).map((variable) => [variable.name, variable.value]));

describe("managedProviderInstanceConfigMap", () => {
  it("runs exactly Claude and Codex, ignoring every other instance in settings", () => {
    const map = managedProviderInstanceConfigMap(
      settingsWith({
        cursor: instance("cursor", { enabled: true }),
        codex_personal: instance("codex", { enabled: true }),
        claudeAgent: instance("claudeAgent", { enabled: false, displayName: "Mine" }),
      }),
      codexHome,
    );

    assert.deepStrictEqual(Object.keys(map).sort(), ["claudeAgent", "codex"]);
    const claude = map[ProviderInstanceId.make("claudeAgent")];
    const codex = map[ProviderInstanceId.make("codex")];
    assert.strictEqual(claude?.displayName, "Claude");
    assert.strictEqual(claude?.enabled, true);
    assert.strictEqual(codex?.displayName, "Codex");
    assert.strictEqual(codex?.enabled, true);
  });

  it("starts Claude on its own login: no base URL, token or config dir", () => {
    const map = managedProviderInstanceConfigMap(settingsWith({}), codexHome);
    const claude = map[ProviderInstanceId.make("claudeAgent")];

    assert.deepStrictEqual(env(claude), {
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      TEMPO_AGENT: "1",
    });
    assert.deepStrictEqual(claude?.config, {});
  });

  it("runs Codex from this Mac's own home through the managed runtime", () => {
    const map = managedProviderInstanceConfigMap(settingsWith({}), codexHome);
    const codex = map[ProviderInstanceId.make("codex")];
    const config = codex?.config as Record<string, unknown>;

    assert.deepStrictEqual(env(codex), { CODEX_HOME: codexHome, TEMPO_AGENT: "1" });
    assert.strictEqual(config.setupMode, "managed");
    assert.strictEqual(config.homePath, codexHome);
    assert.notProperty(config, "launchArgs");
  });

  it("keeps tunable settings but never launch settings", () => {
    const map = managedProviderInstanceConfigMap(
      settingsWith({
        claudeAgent: instance("claudeAgent", {
          accentColor: "#ff6600",
          environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant-personal", sensitive: true }],
          config: {
            autoCompactWindow: "300000",
            binaryPath: "/tmp/evil-claude",
            homePath: "~/.claude",
            launchArgs: "--dangerously-skip-permissions",
            customModels: [{ slug: "x", name: "x" }],
          },
        }),
        codex: instance("codex", {
          config: { shadowHomePath: "~/.codex-t3/me", launchArgs: "-c model_provider=openai" },
        }),
      }),
      codexHome,
    );
    const claude = map[ProviderInstanceId.make("claudeAgent")];
    const codex = map[ProviderInstanceId.make("codex")];

    assert.strictEqual(claude?.accentColor, "#ff6600");
    assert.deepStrictEqual(claude?.config, { autoCompactWindow: "300000" });
    assert.notProperty(env(claude), "ANTHROPIC_API_KEY");
    assert.notProperty(codex?.config as object, "shadowHomePath");
    assert.notProperty(codex?.config as object, "launchArgs");
  });
});

describe("codexHomeOf", () => {
  it("uses this Mac's own Codex home, and one inside Tempo's data only when there is none", () => {
    const join = (...segments: Array<string>) => segments.join("/");
    assert.strictEqual(codexHomeOf(codexHome, "/Users/ada/.tempo", join), codexHome);
    assert.strictEqual(
      codexHomeOf(null, "/Users/ada/.tempo", join),
      "/Users/ada/.tempo/provider-homes/codex",
    );
  });
});

describe("sanitizeProviderEnvironment", () => {
  it("drops provider credentials and backend overrides and keeps everything else", () => {
    const sanitized = sanitizeProviderEnvironment({
      PATH: "/usr/bin",
      HOME: "/Users/ada",
      HTTPS_PROXY: "http://proxy",
      ANTHROPIC_API_KEY: "sk-ant",
      ANTHROPIC_BASE_URL: "https://elsewhere",
      ANTHROPIC_AUTH_TOKEN: "token",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock",
      CLAUDE_CONFIG_DIR: "/Users/ada/.claude",
      OPENAI_API_KEY: "sk-openai",
      OPENAI_BASE_URL: "https://elsewhere/v1",
      CODEX_HOME: "/Users/ada/.codex",
      T3CODE_CODEX_LAUNCH_ARGS: "-c model_provider=openai",
      OPENROUTER_API_KEY: "or",
    });

    assert.deepStrictEqual(sanitized, {
      PATH: "/usr/bin",
      HOME: "/Users/ada",
      HTTPS_PROXY: "http://proxy",
    });
  });
});

describe("checkProviderInstanceMutation", () => {
  const current = settingsWith({
    claudeAgent: instance("claudeAgent", { config: { autoCompactWindow: "" } }),
  });
  const upsert = (
    id: string,
    entry: ProviderInstanceConfig,
    operation: "upsert" | "create" = "upsert",
  ): ProviderInstanceMutation => ({
    operation,
    instanceId: ProviderInstanceId.make(id),
    instance: entry,
  });

  it("allows tuning a managed provider", () => {
    assert.isUndefined(
      checkProviderInstanceMutation(
        current,
        upsert("claudeAgent", instance("claudeAgent", { config: { autoCompactWindow: "400000" } })),
      ),
    );
    assert.isUndefined(checkProviderInstanceMutation(current, undefined));
  });

  it("refuses other drivers, removals, and launch edits", () => {
    const refusals: Array<ProviderInstanceMutation> = [
      upsert("cursor", instance("cursor"), "create"),
      upsert("codex_work", instance("codex"), "create"),
      upsert("claudeAgent", instance("codex")),
      { operation: "remove", instanceId: ProviderInstanceId.make("codex") },
      upsert("claudeAgent", instance("claudeAgent", { enabled: false })),
      upsert(
        "claudeAgent",
        instance("claudeAgent", {
          environment: [{ name: "ANTHROPIC_API_KEY", value: "sk-ant", sensitive: true }],
        }),
      ),
      upsert("claudeAgent", instance("claudeAgent", { config: { binaryPath: "/tmp/claude" } })),
      upsert(
        "codex",
        instance("codex", {
          environment: [{ name: "CODEX_HOME", value: "/tmp", sensitive: false }],
        }),
      ),
      upsert("codex", instance("codex", { config: { launchArgs: "-c model_provider=openai" } })),
      upsert("codex", instance("codex", { config: { shadowHomePath: "~/.codex-me" } })),
    ];
    for (const mutation of refusals) {
      const refusal = checkProviderInstanceMutation(current, mutation);
      assert.strictEqual(refusal?._tag, "TempoManagedProviderError", JSON.stringify(mutation));
      assert.include(refusal?.message ?? "", "Tempo decides how Claude and Codex start");
    }
  });

  it("refuses a changed value for a saved variable but not its redacted echo", () => {
    const saved = settingsWith({
      codex: instance("codex", {
        environment: [{ name: "OPENAI_API_KEY", value: "sk-old", sensitive: true }],
      }),
    });
    const withValue = (value: string, valueRedacted?: boolean) =>
      upsert(
        "codex",
        instance("codex", {
          environment: [
            {
              name: "OPENAI_API_KEY",
              value,
              sensitive: true,
              ...(valueRedacted === undefined ? {} : { valueRedacted }),
            },
          ],
        }),
      );

    assert.strictEqual(
      checkProviderInstanceMutation(saved, withValue("sk-new"))?._tag,
      "TempoManagedProviderError",
    );
    assert.isUndefined(checkProviderInstanceMutation(saved, withValue("", true)));
    assert.isUndefined(checkProviderInstanceMutation(saved, withValue("sk-old")));
  });
});

describe("tempoProviderSettingsView", () => {
  const project = ProjectId.make("project-1");
  const selection = (instanceId: string, model: string) => ({
    instanceId: ProviderInstanceId.make(instanceId),
    model,
  });
  const stored: ServerSettings = {
    ...DEFAULT_SERVER_SETTINGS,
    providerInstances: settingsWith({
      codex: instance("codex", {
        enabled: false,
        environment: [{ name: "OPENAI_API_KEY", value: "sk-openai", sensitive: true }],
        config: { homePath: "~/.codex", launchArgs: "-c model_provider=openai" },
      }),
      claudeAgent: instance("claudeAgent", { accentColor: "#ff6600" }),
      cursor: instance("cursor", { enabled: true }),
    }).providerInstances,
    projectSettingsOverrides: {
      [project]: {
        defaultAutoPull: true,
        defaultModelSelection: selection("cursor", "composer-2"),
        textGenerationModelSelection: selection("claudeAgent", "claude-haiku-4-5"),
        providerInstances: { [ProviderInstanceId.make("codex")]: { enabled: false } },
      },
    },
    defaultModelSelection: selection("opencode", "gpt-5"),
    textGenerationModelSelection: selection("cursor", "composer-2"),
    reviewGuideModelSelection: selection("codex", "gpt-5.5"),
    cursorKeychainUsageEnabled: true,
  };
  const view = tempoProviderSettingsView(stored, codexHome);

  it("keeps Claude and Codex enabled everywhere, whatever settings.json says", () => {
    assert.deepStrictEqual(Object.keys(view.providerInstances).sort(), ["claudeAgent", "codex"]);
    for (const id of ["claudeAgent", "codex"]) {
      const instanceId = ProviderInstanceId.make(id);
      assert.isTrue(resolveProjectProviderInstanceEnabled(view, null, instanceId), id);
      assert.isTrue(resolveProjectProviderInstanceEnabled(view, project, instanceId), id);
    }
    assert.isFalse(
      resolveProjectProviderInstanceEnabled(view, project, ProviderInstanceId.make("cursor")),
    );
  });

  it("reads Claude and Codex with the homes they run from and no saved environment", () => {
    const codex = view.providerInstances[ProviderInstanceId.make("codex")];
    const claude = view.providerInstances[ProviderInstanceId.make("claudeAgent")];
    assert.deepStrictEqual(codex?.config, { homePath: codexHome });
    assert.isUndefined(codex?.environment);
    assert.deepStrictEqual(claude?.config, {});
    assert.strictEqual(claude?.accentColor, "#ff6600");
  });

  it("points model selections that name another instance back at Claude or Codex", () => {
    assert.strictEqual(view.textGenerationModelSelection.instanceId, "claudeAgent");
    assert.isNull(view.defaultModelSelection);
    assert.deepStrictEqual(view.reviewGuideModelSelection, stored.reviewGuideModelSelection);
    assert.deepStrictEqual(view.projectSettingsOverrides[project], {
      defaultAutoPull: true,
      textGenerationModelSelection: selection("claudeAgent", "claude-haiku-4-5"),
    });
    assert.isFalse(view.cursorKeychainUsageEnabled);
  });

  it("is stable when applied again", () => {
    assert.deepStrictEqual(tempoProviderSettingsView(view, codexHome), view);
  });
});
