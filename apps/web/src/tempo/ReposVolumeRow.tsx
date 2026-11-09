/**
 * tempo: Settings → Worktrees → Creation: the repos volume, a separate APFS volume at
 * ~/repos. Each selected environment that can have one (a Mac host) gets its own
 * row: set it up while it is missing, or keep new worktrees on it once it is mounted.
 */
import { useAtomValue } from "@effect/atom-react";
import { isAtomCommandInterrupted } from "@t3tools/client-runtime/state/runtime";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { lazy, Suspense, useState } from "react";

import { SettingsRow } from "../components/settings/settingsLayout";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { searchableSetting } from "../components/settings/settingsSearch";
import { settingsScopeEnvironmentLabel } from "../components/settings/settingsScopeAxis";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import { toastManager } from "../components/ui/toast";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useEnvironmentScope } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { reposVolumePrepare, reposVolumeStatus } from "./reposVolumeState";

// The terminal only loads when someone sets a volume up.
const ReposVolumeSetupDialog = lazy(() => import("./ReposVolumeSetupDialog"));

type SettingsEnvironment = ReturnType<typeof useSettingsScope>["connectedEnvironments"][number];

const UNMOUNTED_DESCRIPTION =
  "A separate APFS volume at ~/repos. Spotlight doesn't index it and FSEvents keeps no log of it, so installs and builds in worktrees there make less background work. It isn't covered by FileVault and shares the disk's free space. Setup runs in a terminal and asks for the Mac's password.";

export function ReposVolumeRow() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.tempoReposVolume === true,
  );
  return supported.map((environment, index) => (
    <ReposVolumeEnvironmentRow
      key={environment.environmentId}
      environment={environment}
      label={
        connectedEnvironments.length > 1
          ? settingsScopeEnvironmentLabel(environment, connectedEnvironments)
          : null
      }
      // Search anchors must be unique, so only the first row carries one.
      anchored={index === 0}
    />
  ));
}

function ReposVolumeEnvironmentRow({
  environment,
  label,
  anchored,
}: {
  readonly environment: SettingsEnvironment;
  readonly label: string | null;
  readonly anchored: boolean;
}) {
  const { environmentId } = environment;
  const status = useEnvironmentQuery(reposVolumeStatus({ environmentId, input: {} }));
  const canSetUp = useAtomValue(reposVolumePrepare.permissionAtom(environmentId));
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "repos volume worktrees",
    reportFailure: false,
  });
  const [settingUp, setSettingUp] = useState(false);
  const volume = status.data;
  const worktreesOnVolume =
    volume !== null &&
    environment.serverConfig?.settings.worktreesDirectory === volume.worktreesPath;
  const search = searchableSetting("tempo-repos-volume");

  // Off goes back to the default location; worktrees already created stay where they are.
  const setWorktreesOnVolume = async (enabled: boolean) => {
    if (volume === null) return;
    const result = await updateSettings({
      environmentId,
      input: { patch: { worktreesDirectory: enabled ? volume.worktreesPath : "" } },
    });
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not change where new worktrees go on ${environment.label}`,
      });
    }
  };

  return (
    <>
      <SettingsRow
        {...(anchored ? { id: search.id } : {})}
        title={label === null ? search.title : `${search.title} · ${label}`}
        description={
          volume?.mounted
            ? "Mounted at ~/repos. Existing worktrees stay where they are."
            : `${UNMOUNTED_DESCRIPTION}${
                volume !== null && !canSetUp
                  ? " This connection can't open a terminal on this machine, which setup needs."
                  : ""
              }`
        }
        status={
          status.error ??
          // Rerunning setup mounts a volume it created before, such as after a failed mount.
          (volume !== null && !volume.mounted && worktreesOnVolume
            ? "New worktrees still go to ~/repos/.worktrees, but nothing is mounted at ~/repos."
            : undefined)
        }
        control={
          volume === null ? null : volume.mounted ? (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Create new worktrees here</span>
              <Switch
                aria-label="Create new worktrees here"
                checked={worktreesOnVolume}
                disabled={!canWriteSettings}
                onCheckedChange={(enabled) => void setWorktreesOnVolume(enabled)}
              />
            </div>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={!canSetUp || settingUp}
              onClick={() => setSettingUp(true)}
            >
              Set up…
            </Button>
          )
        }
      />
      {settingUp && environment.serverConfig !== null ? (
        <Suspense fallback={null}>
          <ReposVolumeSetupDialog
            environmentId={environmentId}
            environmentLabel={environment.label}
            keybindings={environment.serverConfig.keybindings}
            onClose={() => setSettingUp(false)}
            onClosed={status.refresh}
          />
        </Suspense>
      ) : null}
    </>
  );
}
