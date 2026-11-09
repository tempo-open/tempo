/**
 * tempo: Settings → Devices: iOS simulators boot with their background services off (simslim).
 * On by default. Only Apple silicon Mac servers that read the setting show it.
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

export function SlimSimulatorsRow({ supported }: { supported: boolean }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["tempoSlimSimulators"]);
  if (!supported) return null;

  return (
    <SettingsRow
      {...searchableSetting("tempo-slim-simulators")}
      description="iOS simulators start with Siri, widgets, iCloud, Health and other background services off, so each uses far less memory. Push, StoreKit, universal links, Spotlight and the photo picker keep working."
      serverScoped
      settingKeys={["tempoSlimSimulators"]}
      mixed={mixed}
      resetAction={
        mixed || settings.tempoSlimSimulators !== DEFAULT_SERVER_SETTINGS.tempoSlimSimulators ? (
          <SettingResetButton
            label="slim simulators"
            onClick={() =>
              updateSettings({ tempoSlimSimulators: DEFAULT_SERVER_SETTINGS.tempoSlimSimulators })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Slim simulators"
          mixed={mixed}
          checked={mixed ? false : settings.tempoSlimSimulators}
          onCheckedChange={(enabled) => updateSettings({ tempoSlimSimulators: enabled })}
        />
      }
    />
  );
}
