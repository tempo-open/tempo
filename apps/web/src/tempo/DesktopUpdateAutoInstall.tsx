import { useAtomValue } from "@effect/atom-react";
import { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { SettingsRow } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { Switch } from "../components/ui/switch";
import { isDesktopLocalConnectionTarget } from "../connection/desktopLocal";
import { updateClientSettings, useClientSettings } from "../hooks/useSettings";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import { environmentIdsKey } from "../state/environmentAtomList";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import { environmentThreadShells } from "../state/threads";
import { countLocalTurns, localTurnsReport } from "./desktopUpdateAutoInstall.logic";

/**
 * tempo: the renderer half of installing downloaded updates without a click. The desktop app
 * decides (apps/desktop/src/tempo/updateAutoInstall.ts); each window tells it how many agent
 * turns run on the environments it hosts, which it cannot see itself.
 */

const localTurnsAtom = Atom.family((environmentIds: string) =>
  Atom.make((get) =>
    countLocalTurns(
      (environmentIds === "" ? [] : environmentIds.split("\n")).map((id) => {
        const environmentId = EnvironmentId.make(id);
        return {
          live: get(environmentShell.statusAtom(environmentId)) === "live",
          threads: get(environmentThreadShells.environmentThreadsAtom(environmentId)),
        };
      }),
    ),
  ).pipe(Atom.withLabel(`tempo-desktop-update-local-turns:${environmentIds}`)),
);

export function DesktopUpdateAutoInstallReporter() {
  const { isReady, environments } = useEnvironments();
  // Turning the local environment on or off relaunches the app.
  const [localEnvironmentOff] = useState(isLocalEnvironmentDisabled);
  // The environments useUpdateEverything counts as hosted by this app.
  const hostedIds = environments
    .filter(
      ({ entry }) =>
        entry.target._tag === "PrimaryConnectionTarget" ||
        isDesktopLocalConnectionTarget(entry.target),
    )
    .map(({ environmentId }) => environmentId);
  const hostedTurns = useAtomValue(localTurnsAtom(environmentIdsKey(hostedIds)));
  const turns = localTurnsReport({
    environmentsReady: isReady,
    localEnvironmentOff,
    hostedEnvironments: hostedIds.length,
    turns: hostedTurns,
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports the hosted environments' running turns to the desktop app's update auto-install over the bridge
  useEffect(() => {
    void window.desktopBridge?.tempo?.reportLocalTurns?.(turns).catch(() => undefined);
  }, [turns]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- withdraws this window's turn report from the desktop app when the reporter unmounts
  useEffect(
    () => () => {
      void window.desktopBridge?.tempo?.reportLocalTurns?.(null).catch(() => undefined);
    },
    [],
  );
  return null;
}

/** Settings → About, under Version. Each device keeps its own choice. */
export function DesktopAutoInstallSetting() {
  const enabled = useClientSettings((settings) => settings.autoInstallDesktopUpdates);
  return (
    <SettingsRow
      {...searchableSetting("auto-install-updates")}
      description="Installs a downloaded update when you quit, or restarts once you've been away for 10 minutes and no agent is working on this Mac."
      control={
        <Switch
          aria-label="Install updates automatically"
          checked={enabled}
          onCheckedChange={(checked) =>
            void updateClientSettings({ autoInstallDesktopUpdates: checked })
          }
        />
      }
    />
  );
}
