/** tempo: Settings → Labs → Legacy: the design Tempo had before the tempo look. */
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import { Switch } from "~/components/ui/switch";

export function ClassicLookRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("tempo-classic-look")}
      description={`Use the design ${TEMPO_APP_BASE_NAME} had before November 2026.`}
      control={
        <Switch
          checked={settings.tempoLook === "classic"}
          onCheckedChange={(checked) =>
            updateSettings({ tempoLook: checked ? "classic" : "tempo" })
          }
          aria-label="Classic look"
        />
      }
    />
  );
}
