import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  ClaudeSettings,
  TEMPO_CLAUDE_WORKFLOW_SETTINGS_ORDER,
  TempoClaudeWorkflowSettingsFields,
  type EnvironmentId,
  makeProviderSettingsSchema,
  ProviderInstanceId,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { ProviderSettingsForm } from "../components/settings/ProviderSettingsForm";
import { CompactIdleThreadsRow } from "../components/settings/SettingsPanels";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { ProviderUpdatesAction } from "../components/ProviderUpdatesAction";
import { UsageProviderSettings } from "../components/settings/UsageProviderSettings";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import {
  useEnvironmentSettings,
  usePersistEnvironmentProviderInstanceMutation,
  useUpdateEnvironmentSettings,
} from "../hooks/useSettings";
import { useEnvironment } from "../state/environments";
import { useEnvironmentScope } from "../state/session";
import { CompactNearLimitRow } from "./CompactNearLimitRow";
import {
  ManagedProviderIcon,
  ManagedProviderStateBadge,
  useManagedProviderRows,
} from "./ManagedProviderRows";

const CLAUDE_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

/** The Claude options the provider policy lets people tune; everything else is managed. */
const CLAUDE_OPTIONS_FORM = {
  settingsSchema: makeProviderSettingsSchema(
    {
      autoCompactWindow: ClaudeSettings.fields.autoCompactWindow,
      ...TempoClaudeWorkflowSettingsFields,
    },
    { order: ["autoCompactWindow", ...TEMPO_CLAUDE_WORKFLOW_SETTINGS_ORDER] },
  ),
};

/**
 * Settings → Providers on tempo: Claude and Codex, each on its own sign-in on this Mac. Update notices
 * point here: a CLI updates with Update all, or by itself unless turned off here. Claude's options
 * (workflows, auto-compact) and usage sources stay editable; Cursor's usage reader is not offered.
 */
export function TempoProvidersSettings({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
}) {
  const rows = useManagedProviderRows(environmentId);
  const settings = useEnvironmentSettings(environmentId);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Providers" headerAction={<ProviderUpdatesAction />}>
        {rows.map((row) => (
          <SettingsRow
            key={row.id}
            title={
              <span className="inline-flex items-center gap-2">
                <ManagedProviderIcon row={row} />
                {row.name}
              </span>
            }
            description={row.detail}
            control={<ManagedProviderStateBadge state={row.state} />}
          />
        ))}
        <AutoUpdateProvidersRow environmentId={environmentId} />
        {/* Idle compaction lives with the providers, as upstream's Providers page has it. */}
        <CompactIdleThreadsRow />
        <CompactNearLimitRow />
      </SettingsSection>
      <ClaudeOptionsSection environmentId={environmentId} />
      <UsageProviderSettings
        key={environmentId}
        environmentId={environmentId}
        environmentLabel={environmentLabel}
        sources={settings.usageLimitSources}
        readOnly={!canWriteSettings}
      />
    </SettingsPageContainer>
  );
}

/** Older servers decode the setting away, so it shows only where the server updates providers. */
function AutoUpdateProvidersRow({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const supported =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities
      .tempoAutoUpdateProviders === true;
  const enabled = useEnvironmentSettings(
    environmentId,
    (settings) => settings.tempoAutoUpdateProviders,
  );
  const canManageProviders = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  if (!supported) return null;
  return (
    <SettingsRow
      title="Update automatically"
      description="Install new Claude and Codex versions on this environment once no chat is using them. Off leaves updates to you."
      control={
        <Switch
          aria-label="Update providers automatically"
          checked={enabled}
          disabled={!canManageProviders}
          onCheckedChange={(checked) => updateSettings({ tempoAutoUpdateProviders: checked })}
        />
      }
    />
  );
}

/** Claude's tunable options, written back onto the managed instance the server reported. */
function ClaudeOptionsSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const claude = useEnvironmentSettings(
    environmentId,
    (settings) => settings.providerInstances[CLAUDE_INSTANCE_ID],
  );
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const persistProviderInstance = usePersistEnvironmentProviderInstanceMutation(environmentId);
  const [saving, setSaving] = useState(false);
  if (claude === undefined) return null;

  const save = async (config: Record<string, unknown> | undefined) => {
    setSaving(true);
    // The launch keys (such as the managed home) go back as they were read, or the policy refuses.
    const result = await persistProviderInstance({
      operation: "upsert",
      instanceId: CLAUDE_INSTANCE_ID,
      instance: { ...claude, config: config ?? {} },
    }).finally(() => setSaving(false));
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not update Claude",
        description: error instanceof Error ? error.message : "The settings update failed.",
      });
    }
  };

  return (
    <SettingsSection title="Claude">
      {/* Locked while saving, so an edit made mid-request is not overwritten by the saved value. */}
      <fieldset disabled={saving || !canWriteSettings} className="contents">
        <ProviderSettingsForm
          definition={CLAUDE_OPTIONS_FORM}
          value={claude.config ?? {}}
          idPrefix={`tempo-claude-options-${environmentId}`}
          variant="settings"
          onChange={(next) => void save(next)}
        />
      </fieldset>
    </SettingsSection>
  );
}
