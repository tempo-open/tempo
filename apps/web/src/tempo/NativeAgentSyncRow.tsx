/**
 * tempo: Settings → Threads → New projects: keep this machine's own Codex and
 * Claude Code threads, and their scheduled tasks, in Tempo. On by default.
 */
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";

export function NativeAgentSyncRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["tempoNativeAgentSync"]);

  return (
    <SettingsRow
      {...searchableSetting("tempo-native-agent-sync")}
      description="Brings the threads you start in Codex or Claude Code on this machine into their projects here, and keeps them current. Archived and deleted threads stay out. Their scheduled tasks arrive paused."
      serverScoped
      settingKeys={["tempoNativeAgentSync"]}
      mixed={mixed}
      resetAction={
        mixed || settings.tempoNativeAgentSync !== DEFAULT_SERVER_SETTINGS.tempoNativeAgentSync ? (
          <SettingResetButton
            label="Codex and Claude Code sync"
            onClick={() =>
              updateSettings({ tempoNativeAgentSync: DEFAULT_SERVER_SETTINGS.tempoNativeAgentSync })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Sync Codex and Claude Code threads"
          mixed={mixed}
          checked={mixed ? false : settings.tempoNativeAgentSync}
          onCheckedChange={(enabled) => updateSettings({ tempoNativeAgentSync: enabled })}
        />
      }
    />
  );
}
