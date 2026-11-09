import { Link } from "@tanstack/react-router";
import { WifiOffIcon } from "lucide-react";
import { useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { useConnectionDiagnosis } from "../components/settings/ConnectionDiagnosisDetails";
import { Button } from "../components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { isLocalEnvironmentDisabled } from "../localEnvironment";
import type { EnvironmentPresentation } from "../state/environments";
import { setNewWorkEnvironment } from "./newWorkEnvironment";

/** The usual reasons a phone or laptop cannot reach the person's Tempo host. */
function hostUnreachableCauses(label: string): string {
  return `Check that ${label} is awake and online, and that this device has internet.`;
}

/**
 * The offline banner's line in a chat: what failed, once an attempt has, then
 * the usual causes when the host is remote.
 */
export function HostUnreachableDescription({
  environment,
  remote,
}: {
  readonly environment: EnvironmentPresentation;
  readonly remote: boolean;
}) {
  const headline = useConnectionDiagnosis(environment).diagnosis?.headline ?? null;
  const causes = remote ? hostUnreachableCauses(environment.label) : null;
  if (headline === null || causes === null) return headline ?? causes;
  return `${headline}. ${causes}`;
}

/**
 * One click back to running agents on this Mac, for a desktop whose local
 * server is off. New work comes back to this Mac too (the default), so the
 * unreachable host does not keep receiving it. Relaunches Tempo; nothing renders
 * elsewhere.
 */
export function TurnOnLocalServerButton({ size = "xs" }: { readonly size?: "xs" | "sm" }) {
  const setEnabled = window.desktopBridge?.setLocalEnvironmentEnabled;
  const [restarting, setRestarting] = useState(false);
  if (!setEnabled || !isLocalEnvironmentDisabled()) return null;
  return (
    <Button
      size={size}
      variant="ghost"
      disabled={restarting}
      title={`Restart ${APP_BASE_NAME} with its own server, and run new work on this Mac again.`}
      onClick={() => {
        setRestarting(true);
        void setNewWorkEnvironment(null)
          .catch(() => undefined)
          .then(() => setEnabled(true))
          .catch(() => setRestarting(false));
      }}
    >
      {restarting ? "Restarting…" : "Turn on this Mac's server"}
    </Button>
  );
}

/**
 * The home screen of a desktop whose local server is off while none of its
 * saved environments answers: names the likely causes and keeps the way back
 * to local agents one click away.
 */
export function HostUnreachableState({ labels }: { readonly labels: ReadonlyArray<string> }) {
  const fallback = `your ${APP_BASE_NAME} host`;
  const label = labels.length === 1 ? (labels[0] ?? fallback) : fallback;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      {isElectron ? <WorkspacePageHeader electron /> : null}
      <Empty className="flex-1">
        <EmptyHeader className="max-w-md">
          <div className="mx-auto mb-5 flex size-11 items-center justify-center rounded-xl border border-border/70 bg-background/70 text-muted-foreground">
            <WifiOffIcon className="size-5" />
          </div>
          <EmptyTitle>Can't reach {label}</EmptyTitle>
          <EmptyDescription>{hostUnreachableCauses(label)}</EmptyDescription>
          <EmptyDescription>
            Your agents keep running there; this device reconnects on its own once it can reach it.
          </EmptyDescription>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="outline" render={<Link to="/settings/connections" />}>
              Open Connections
            </Button>
            <TurnOnLocalServerButton size="sm" />
          </div>
        </EmptyHeader>
      </Empty>
    </SidebarInset>
  );
}
