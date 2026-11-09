/**
 * tempo: Settings → Providers, below Compact idle threads: compact a thread as soon as a
 * turn leaves it near its provider's compaction point. On by default. Only servers
 * that read the setting show it.
 */
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";

export function CompactNearLimitRow() {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["tempoCompactNearLimit"]);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.tempoCompactNearLimit !== true,
    )
  )
    return null;

  return (
    <SettingsRow
      {...searchableSetting("tempo-compact-near-limit")}
      description="When a turn leaves a conversation close to the size at which Claude or Codex compacts it, summarize it right away so your next message does not wait for the compaction."
      serverScoped
      settingKeys={["tempoCompactNearLimit"]}
      mixed={mixed}
      resetAction={
        mixed ||
        settings.tempoCompactNearLimit !== DEFAULT_SERVER_SETTINGS.tempoCompactNearLimit ? (
          <SettingResetButton
            label="compact threads near their limit"
            onClick={() =>
              updateSettings({
                tempoCompactNearLimit: DEFAULT_SERVER_SETTINGS.tempoCompactNearLimit,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Compact threads near their limit"
          mixed={mixed}
          checked={mixed ? false : settings.tempoCompactNearLimit}
          onCheckedChange={(enabled) => updateSettings({ tempoCompactNearLimit: enabled })}
        />
      }
    />
  );
}
