import { useAtomValue } from "@effect/atom-react";
import { type EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import {
  type ManagedProviderRow,
  type ManagedProviderState,
  managedProviderRows,
} from "@t3tools/client-runtime/tempo/managed-providers";
import { CircleAlertIcon, CircleDashedIcon, KeyRoundIcon } from "lucide-react";
import type { ReactNode } from "react";

import { ProviderInstanceIcon } from "../components/chat/ProviderInstanceIcon";
import { Badge } from "../components/ui/badge";
import { SuccessCheckIcon } from "./look/SuccessCheckIcon";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../state/server";

const STATE_BADGES: Readonly<
  Record<
    ManagedProviderState,
    { label: string; variant: "success" | "warning" | "outline"; icon: ReactNode }
  >
> = {
  checking: { label: "Checking", variant: "outline", icon: <CircleDashedIcon /> },
  ready: { label: "Ready", variant: "success", icon: <SuccessCheckIcon /> },
  signIn: { label: "Sign in", variant: "warning", icon: <KeyRoundIcon /> },
  attention: { label: "Not ready", variant: "warning", icon: <CircleAlertIcon /> },
};

export function ManagedProviderStateBadge({ state }: { readonly state: ManagedProviderState }) {
  const badge = STATE_BADGES[state];
  return (
    <Badge variant={badge.variant} role="status">
      {badge.icon}
      {badge.label}
    </Badge>
  );
}

export function ManagedProviderIcon({ row }: { readonly row: ManagedProviderRow }) {
  return (
    <ProviderInstanceIcon
      driverKind={ProviderDriverKind.make(row.id)}
      displayName={row.name}
      iconClassName="size-5"
    />
  );
}

/** Claude and Codex on one environment, read-only, as rows for Settings → Providers. */
export function useManagedProviderRows(environmentId: EnvironmentId): Array<ManagedProviderRow> {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  return managedProviderRows(providers);
}
