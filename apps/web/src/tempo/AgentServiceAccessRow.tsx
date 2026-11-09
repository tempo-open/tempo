import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";

import { APP_BASE_NAME } from "../branding";

import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingResetButton, SettingsRow } from "../components/settings/settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "../components/settings/useScopedSettings";
import { Switch } from "../components/ui/switch";

/**
 * tempo: whether agents get the service tools. Sits beside Agent
 * browser access in Settings > Browser and scopes the same way: the
 * environment default, or one project's override.
 */
export function AgentServiceAccessRow() {
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["enableAgentServiceAccess"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["enableAgentServiceAccess"]}
      mixed={mixed}
      id={searchableSetting("agent-service-access").id}
      title="Agent service access"
      description={
        isProjectScope
          ? `Allow agents in this project to call services (OpenRouter, Cloudflare, and others) through ${APP_BASE_NAME}, which adds the keys for them. Agents get these tools once a service connection is saved in Settings → Integrations. Applies when the agent session next starts.`
          : `Allow agents to call services (OpenRouter, Cloudflare, and others) through ${APP_BASE_NAME}, which adds the keys for them. Agents get these tools once a service connection is saved in Settings → Integrations. Writes ask you first unless Ask before service writes is off there. Projects can override it.`
      }
      resetAction={
        settings.enableAgentServiceAccess !== DEFAULT_SERVER_SETTINGS.enableAgentServiceAccess ? (
          <SettingResetButton
            label="default service access"
            onClick={() =>
              updateSettings({
                enableAgentServiceAccess: DEFAULT_SERVER_SETTINGS.enableAgentServiceAccess,
              })
            }
          />
        ) : null
      }
      control={
        <Switch
          aria-label="Agent service access"
          mixed={mixed}
          checked={mixed ? false : settings.enableAgentServiceAccess}
          onCheckedChange={(enabled) => updateSettings({ enableAgentServiceAccess: enabled })}
        />
      }
    />
  );
}
