import { RegistryContext } from "@effect/atom-react";
import {
  AuthOrchestrationOperateScope,
  LAPTOP_TOOLS_REQUEST_KINDS,
  type DesktopLaptopToolGrant,
  type DesktopLaptopToolsState,
  type TempoLaptopPasskeyStatus,
  type EnvironmentId,
  type LaptopPasskeyRequest,
  type LaptopToolsHostRegistration,
} from "@t3tools/contracts";
import { KeyRoundIcon, MonitorSmartphoneIcon, SquareIcon } from "lucide-react";
import { useContext, useEffect, useRef } from "react";

import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { randomUUID } from "~/lib/utils";
import { useThreadShell } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useEnvironmentScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";

import { createLaptopToolsRequestRelay } from "./laptopToolsRequests";
import {
  laptopToolsBridge,
  laptopToolsEnvironment,
  registerLaptopToolsRelay,
  useLaptopToolsState,
} from "./laptopToolsState";

/** One registration per app launch, so a reload replaces the previous one. */
const HOST_ID = randomUUID();

/**
 * Offers this desktop's laptop tools to every connected environment, relays
 * their requests to the main process, and ends grants when their run ends.
 * The desktop registers even with no tool turned on, so other kinds of
 * request (such as passkeys) have a way to this laptop.
 */
export function LaptopToolsCoordinator() {
  const state = useLaptopToolsState();
  if (laptopToolsBridge === null || state === null) return null;
  return <LaptopToolsCoordinatorFor state={state} />;
}

function LaptopToolsCoordinatorFor({ state }: { readonly state: DesktopLaptopToolsState }) {
  const { environments } = useEnvironments();
  // State arrives anew on every call; the registration must only change with
  // what is offered, or each update would reconnect and drop calls in flight.
  const registrationJson = JSON.stringify({
    hostId: HOST_ID,
    hostLabel: state.hostLabel,
    servers: state.servers
      .filter((server) => server.enabled && server.resolvedCommand !== null)
      .map((server) => ({ id: server.id, name: server.name })),
    // Passkeys also reach a Mac that cannot run them yet, so it can tell the person why;
    // the environment then falls back to saved ones. Turned off, or not a Mac: never.
    accepts: LAPTOP_TOOLS_REQUEST_KINDS.filter(
      (kind) =>
        kind !== "passkey" ||
        (state.passkeys !== undefined &&
          state.passkeys.status !== "off" &&
          state.passkeys.status !== "not-mac"),
    ),
  } satisfies LaptopToolsHostRegistration);
  return (
    <>
      {environments
        // Servers without laptop tools (upstream T3, older tempo) would refuse the stream.
        .filter(
          (environment) =>
            environment.connection.phase === "connected" &&
            environment.serverConfig?.environment.capabilities.tempoLaptopTools === true,
        )
        .map((environment) => (
          <EnvironmentLaptopToolsHost
            key={environment.environmentId}
            environmentId={environment.environmentId}
            environmentLabel={environment.label}
            registrationJson={registrationJson}
          />
        ))}
      {state.grants.map((grant) => (
        <GrantRunWatcher key={grant.key} grant={grant} />
      ))}
    </>
  );
}

function EnvironmentLaptopToolsHost(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly registrationJson: string;
}) {
  // Hosting receives agent calls, which needs operate access on that environment.
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  if (!canOperate) return null;
  return <EnvironmentLaptopToolsConnection {...props} />;
}

function EnvironmentLaptopToolsConnection({
  environmentId,
  environmentLabel,
  registrationJson,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly registrationJson: string;
}) {
  const registry = useContext(RegistryContext);
  const respond = useAtomCommand(laptopToolsEnvironment.respond, { reportFailure: false });
  const labelRef = useRef(environmentLabel);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- points the ref the long-lived request relay reads at the environment's current label
  useEffect(() => {
    labelRef.current = environmentLabel;
  }, [environmentLabel]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds this desktop's laptop tools registration and request relay with the environment until unmount
  useEffect(() => {
    const bridge = laptopToolsBridge;
    if (bridge === null) return;
    // Keyed on the string: the compiler memoizes by identity, and every push is a new object.
    const registration = JSON.parse(registrationJson) as LaptopToolsHostRegistration;
    const { relay, dispose } = createLaptopToolsRequestRelay({
      hostId: registration.hostId,
      environmentId,
      environmentLabel: () => labelRef.current,
      bridge,
      respond: (response) => respond({ environmentId, input: response }),
      onPasskeyUnavailable: (notice) => showPasskeyUnavailable(environmentId, notice),
    });
    // Each mount gets its own stream, so a remount never replays old events.
    const relayKey = randomUUID();
    const unregister = registerLaptopToolsRelay(relayKey, relay);
    const unsubscribe = registry.subscribe(
      laptopToolsEnvironment.connect({ environmentId, input: { registration, relayKey } }),
      () => undefined,
      { immediate: true },
    );
    return () => {
      unsubscribe();
      unregister();
      dispose();
    };
  }, [environmentId, registrationJson, registry, respond]);
  return null;
}

/** tempo passkeys: why this Mac did not answer a server tab's passkey request. */
const PASSKEY_UNAVAILABLE_REASONS: Partial<Record<TempoLaptopPasskeyStatus, string>> = {
  "awaiting-entitlement":
    "This build of the desktop app can't use your Mac's passkeys until Apple approves it.",
  failed: "macOS passkeys did not load in this build of the desktop app. Updating it may help.",
  "unsupported-os": "Answering passkeys needs macOS 15 or later.",
};

/**
 * Says why a server tab's sign-in got no passkey sheet on this Mac, and what
 * works instead. One toast per site and environment: a retry updates it.
 */
function showPasskeyUnavailable(
  environmentId: EnvironmentId,
  notice: {
    readonly request: LaptopPasskeyRequest;
    readonly status: TempoLaptopPasskeyStatus;
    readonly environmentLabel: string;
  },
) {
  const reason = PASSKEY_UNAVAILABLE_REASONS[notice.status];
  if (reason === undefined) return;
  const { rpId, requester } = notice.request;
  toastManager.add({
    id: `tempo-passkey-unavailable:${environmentId}:${rpId}`,
    type: "warning",
    title: "This Mac can't answer passkey requests",
    description:
      requester === "agent"
        ? `An agent's sign-in to ${rpId} on ${notice.environmentLabel} was refused. ${reason}`
        : `${rpId} on ${notice.environmentLabel} asked for a passkey. ${reason} Meanwhile, that tab can sign in with passkeys saved in its browser profile, or with a password manager extension.`,
    timeout: 15_000,
  });
}

/**
 * Ends a grant once the run it was given for is over. It acts only once this client has seen that
 * run active, or completed as the thread's latest run (as after a reconnect), so stale state never
 * ends a grant made before the thread state arrived here; idle expiry covers the rest.
 */
function GrantRunWatcher({ grant }: { readonly grant: DesktopLaptopToolGrant }) {
  const shell = useThreadShell({ environmentId: grant.environmentId, threadId: grant.threadId });
  const loaded = shell !== null;
  const activeRunId = shell?.runtime?.activeRunId ?? null;
  const latestRun = shell?.latestRun ?? null;
  const sawRunCompleted = latestRun?.runId === grant.runId && latestRun.completedAt !== null;
  const sawRunRef = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the desktop main process the thread's active run once the granted run is no longer active, so it can end the grant
  useEffect(() => {
    if (!loaded) return;
    if (activeRunId === grant.runId) {
      sawRunRef.current = true;
      return;
    }
    if (!sawRunRef.current && !sawRunCompleted) return;
    void laptopToolsBridge?.runChanged({
      environmentId: grant.environmentId,
      threadId: grant.threadId,
      activeRunId,
    });
  }, [activeRunId, grant.environmentId, grant.runId, grant.threadId, loaded, sawRunCompleted]);
  return null;
}

/**
 * The in-window cue that a thread may use this laptop, in the sidebar footer
 * beside the other status pills so it covers nothing. The menu bar item the
 * desktop shows is the one visible over other apps; both Stop every grant.
 */
export function LaptopToolsSidebarIndicator() {
  const state = useLaptopToolsState();
  const grants = state?.grants ?? [];
  // tempo passkeys: a server tab's sign-in waiting on this Mac's passkey sheet, and who asked.
  const passkey = state?.passkeys?.pending[0];
  const passkeyRow =
    passkey === undefined ? null : (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg bg-info/12 py-1 pr-2 pl-2 text-2xs leading-4 font-medium text-info"
      >
        <KeyRoundIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {passkey.requester === "agent" ? "Agent passkey: " : "Passkey: "}
          {passkey.rpId} for “{passkey.threadTitle || "a thread"}” on {passkey.environmentLabel}
        </span>
      </div>
    );
  if (grants.length === 0) return passkeyRow;
  const busy = grants.some((grant) => grant.inFlight > 0);
  const names = [...new Set(grants.map((grant) => grant.serverName))].join(", ");
  const threads = [...new Set(grants.map((grant) => grant.threadTitle))];
  const summary =
    threads.length === 1
      ? `“${threads[0]}” may use ${names}`
      : `${threads.length} threads may use ${names}`;
  return (
    <>
      {passkeyRow}
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-7 w-full shrink-0 items-center gap-2 rounded-lg bg-warning/12 py-1 pr-1 pl-2 text-2xs leading-4 font-medium text-warning"
      >
        <MonitorSmartphoneIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">
          {busy ? "In use: " : "Laptop: "}
          {summary}
        </span>
        <Button
          size="micro"
          variant="destructive-outline"
          onClick={() => void laptopToolsBridge?.stop({})}
        >
          <SquareIcon aria-hidden />
          Stop
        </Button>
      </div>
    </>
  );
}
