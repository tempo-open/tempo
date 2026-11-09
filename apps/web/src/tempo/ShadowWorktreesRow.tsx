/**
 * tempo: Settings → Worktrees → Creation: shadow worktrees, on by default. Only
 * environments that can clone (macOS servers) show it.
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

export function ShadowWorktreesRow() {
  const { connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["tempoShadowWorktrees"]);
  if (
    connectedEnvironments.some(
      (environment) =>
        environment.serverConfig?.environment.capabilities.tempoShadowWorktrees !== true,
    )
  )
    return null;

  return (
    <SettingsRow
      {...searchableSetting("tempo-shadow-worktrees")}
      description="New worktrees share unchanged files with one hidden copy of the repository, so a worktree only takes disk space for files that change. Off gives every worktree a full copy."
      serverScoped
      settingKeys={["tempoShadowWorktrees"]}
      mixed={mixed}
      resetAction={
        mixed || settings.tempoShadowWorktrees !== DEFAULT_SERVER_SETTINGS.tempoShadowWorktrees ? (
          <SettingResetButton
            label="shadow worktrees"
            onClick={() =>
              updateSettings({ tempoShadowWorktrees: DEFAULT_SERVER_SETTINGS.tempoShadowWorktrees })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Shadow worktrees"
          mixed={mixed}
          checked={mixed ? false : settings.tempoShadowWorktrees}
          onCheckedChange={(enabled) => updateSettings({ tempoShadowWorktrees: enabled })}
        />
      }
    />
  );
}
