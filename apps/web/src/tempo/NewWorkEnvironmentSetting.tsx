import type { EnvironmentId } from "@t3tools/contracts";

import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { isElectron } from "../env";
import {
  useNewWorkEnvironmentId,
  useNewWorkEnvironmentOptions,
  setNewWorkEnvironment,
} from "./newWorkEnvironment";

/**
 * Settings → Environments → "Run new work on". Per device: one Mac can send
 * new work to another Mac while a third keeps its own choice.
 */
export function NewWorkEnvironmentSetting() {
  const options = useNewWorkEnvironmentOptions();
  const selected = useNewWorkEnvironmentId();
  if (options.length < 2) return null;
  const labelFor = (environmentId: EnvironmentId | null) => {
    const option = options.find((candidate) => candidate.environmentId === environmentId);
    if (!option) return "None";
    // In a browser the primary is the server serving the page, often the host itself.
    return isElectron && option.isPrimary ? `${option.label} (this device)` : option.label;
  };
  return (
    <SettingsSection {...searchableSetting("new-work-environment")}>
      <SettingsRow
        title="Run new work on"
        description="New projects, threads started without a project, and scratch threads start here. Each device keeps its own choice."
        control={
          <Select
            value={selected ?? ""}
            onValueChange={(value) => {
              if (value === null || value === "") return;
              void setNewWorkEnvironment(value as EnvironmentId);
            }}
          >
            <SelectTrigger aria-label="Run new work on" className="w-56" size="sm">
              <SelectValue>{labelFor(selected)}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {options.map((option) => (
                <SelectItem key={option.environmentId} value={option.environmentId}>
                  {labelFor(option.environmentId)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
