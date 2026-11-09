import {
  t3ConnectTroubleshootingUrl,
  type T3ConnectTroubleshootingSection,
} from "@t3tools/contracts";
import type { RelayEnvironmentStatusResponse } from "@t3tools/contracts/relay";
// tempo: Tempo names for upstream's connection diagnosis.
import { TEMPO_APP_BASE_NAME, TEMPO_CLI_NAME } from "@t3tools/shared/tempoBrand";
import * as DateTime from "effect/DateTime";

import type {
  ConnectionAttemptError,
  ConnectionFailureCause,
  ConnectionHop,
  SupervisorConnectionState,
} from "./model.ts";

export type ConnectionHopResult = "ok" | "failed" | "unchecked";

export interface ConnectionDiagnosisHop {
  readonly hop: ConnectionHop;
  readonly label: string;
  readonly result: ConnectionHopResult;
}

export interface ConnectionDiagnosis {
  /** Names the part that failed, e.g. "Tempo on Mac mini is offline" (tempo: never a tunnel). */
  readonly headline: string;
  readonly hops: ReadonlyArray<ConnectionDiagnosisHop>;
  readonly steps: ReadonlyArray<string>;
  readonly facts: ReadonlyArray<readonly [label: string, value: string]>;
  /** The troubleshooting guide section for this failure. Null for direct routes. */
  readonly moreInfoUrl: string | null;
}

export interface ConnectionDiagnosisInput {
  readonly hostLabel: string;
  readonly state: SupervisorConnectionState;
  /** The environment's usual route, used when the failure does not name one. */
  readonly via: "relay" | "direct";
  /** The relay's last health check, which can name a cause before any connect attempt. */
  readonly relayStatus?: Pick<
    RelayEnvironmentStatusResponse,
    "status" | "endpointFailure" | "endpointStatus" | "offlineReason"
  > | null;
  readonly clientVersion?: string | undefined;
  readonly serverVersion?: string | null | undefined;
}

interface Located {
  readonly hop: ConnectionHop;
  readonly cause: ConnectionFailureCause | "offline" | "outdated" | "released" | null;
}

const NOT_ANSWERING: ReadonlySet<ConnectionFailureCause> = new Set([
  "origin_unreachable",
  "invalid_response",
]);

function locate(input: ConnectionDiagnosisInput): Located | null {
  const failure = input.state.lastFailure;
  if (input.state.network === "offline" || input.state.phase === "offline") {
    return { hop: "device", cause: "offline" };
  }
  if (failure?._tag === "ConnectionBlockedError" && failure.serverUpdateRequired) {
    return { hop: "server", cause: "outdated" };
  }
  if (failure?.hop !== undefined) {
    return { hop: failure.hop, cause: failure.failureCause ?? null };
  }
  if (failure !== null) {
    const unreachable =
      failure.reason === "network" ||
      failure.reason === "timeout" ||
      failure.reason === "transport";
    const via = failure.via ?? input.via;
    return { hop: unreachable && via === "relay" ? "tunnel" : "server", cause: null };
  }
  const status = input.relayStatus;
  if (status?.status !== "offline") return null;
  if (status.offlineReason === "tunnel_released") return { hop: "tunnel", cause: "released" };
  const cause = status.endpointFailure ?? null;
  return { hop: cause !== null && NOT_ANSWERING.has(cause) ? "server" : "tunnel", cause };
}

function headline(host: string, located: Located, failure: ConnectionAttemptError | null): string {
  // tempo: Tempo on the host runs its tunnel, which people never set up, so no headline names it.
  // A dead tunnel means Tempo there is not running, or its Mac sleeps or can't get online.
  switch (located.cause) {
    case "offline":
      return "This device is offline";
    case "outdated":
      return `${host} runs an older ${TEMPO_APP_BASE_NAME}`;
    case "clock_skew":
      return "This device's clock is off";
    case "not_linked":
      return `${host} is not linked to your T3 Connect account`;
    case "relay_error":
      return `T3 Connect returned an error`;
    case "tunnel_pending":
      return `T3 Connect is still being set up on ${host}`;
    case "tunnel_not_enabled":
      return `T3 Connect is not turned on for ${host}`;
    case "released":
    case "tunnel_down":
      return `${TEMPO_APP_BASE_NAME} on ${host} is offline`;
    case "origin_unreachable":
      return `${TEMPO_APP_BASE_NAME} on ${host} did not answer`;
    case "invalid_response":
      return `${TEMPO_APP_BASE_NAME} on ${host} sent an unexpected answer`;
    case "dns":
      return `${host}'s T3 Connect address did not resolve`;
    case "tls":
      return `Secure connection to ${host}'s T3 Connect address failed`;
    case "refused":
      return `${host}'s T3 Connect address refused the connection`;
    case "timeout":
      return `${host} did not answer in time`;
    case "unknown":
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return "This device could not prepare the connection";
    case "relay":
      return failure?.reason === "authentication"
        ? `T3 Connect did not accept this device's sign-in`
        : `This device can't reach T3 Connect`;
    case "tunnel":
      // The relay already reached the host when this device fails on its own.
      // tempo: named without the tunnel.
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? `This device can't reach ${host} through T3 Connect`
        : `T3 Connect could not reach ${host}`;
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? `${TEMPO_APP_BASE_NAME} on ${host} did not accept this device`
        : `${TEMPO_APP_BASE_NAME} on ${host} did not answer`;
  }
}

function steps(host: string, located: Located, failure: ConnectionAttemptError | null): string[] {
  // tempo: T3 Connect's switch and status are on Environments, not upstream's Sharing & access.
  const checkHost = `On ${host}, check Settings > Environments or run \`${TEMPO_CLI_NAME} connect status\`.`;
  switch (located.cause) {
    case "offline":
      return [`Connect this device to the internet. ${TEMPO_APP_BASE_NAME} reconnects on its own.`];
    case "outdated":
      return [`Update ${TEMPO_APP_BASE_NAME} on ${host}.`];
    case "clock_skew":
      return [`Turn on automatic date and time on this device and on ${host}, then retry.`];
    case "not_linked":
      return [
        `Check that this device is signed in to the same T3 Connect account as the host.`,
        `On ${host}, open Settings > Environments and turn T3 Connect on.`,
      ];
    case "tunnel_pending":
      return [`Wait a minute. ${TEMPO_APP_BASE_NAME} retries on its own.`, checkHost];
    case "relay_error":
      return [
        `Wait a few minutes. ${TEMPO_APP_BASE_NAME} retries on its own.`,
        "If it keeps failing, copy the diagnostics and report it.",
      ];
    case "tunnel_not_enabled":
      return [`On ${host}, open Settings > Environments and turn T3 Connect on.`];
    // tempo: the relay removed the tunnel after a long time offline; a current Tempo gets a new one.
    case "released":
      return [
        `Start ${TEMPO_APP_BASE_NAME} on ${host} and update it to the latest version.`,
        checkHost,
      ];
    // tempo: this device cannot see a port the host's network blocks; the host's own check names it.
    case "tunnel_down":
      return [
        `Make sure ${host} is awake and ${TEMPO_APP_BASE_NAME} is running on it.`,
        `If ${TEMPO_APP_BASE_NAME} on ${host} was just updated, give it a minute to restart.`,
        checkHost,
      ];
    case "origin_unreachable":
    case "invalid_response":
      return [`Open or restart ${TEMPO_APP_BASE_NAME} on ${host}.`, checkHost];
    // The relay saw these on its way to the host, so the fix is on the host.
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return [`Make sure ${host} is awake and online.`, checkHost];
    case null:
      break;
  }
  switch (located.hop) {
    case "device":
      return [
        `Restart ${TEMPO_APP_BASE_NAME} on this device.`,
        `If it keeps failing, remove ${host} from this device and add it again.`,
      ];
    case "relay":
      return failure?.reason === "authentication"
        ? [`Sign out of T3 Connect and sign in again.`]
        : [
            "Check this device's internet connection.",
            `A VPN, firewall, or ad blocker on this device can block T3 Connect.`,
          ];
    case "tunnel":
      return failure?.reason === "network" ||
        failure?.reason === "transport" ||
        failure?.reason === "timeout"
        ? [
            // tempo: named without the tunnel.
            `A VPN, firewall, or DNS filter on this device can block T3 Connect.`,
            "Try another network, or add a direct route such as a Tailscale address.",
          ]
        : [`Make sure ${host} is awake and online.`, checkHost];
    case "server":
      return [
        `Make sure ${TEMPO_APP_BASE_NAME} is running on ${host}.`,
        "Retry. If it keeps failing, copy the diagnostics.",
      ];
  }
}

function helpSection(
  located: Located,
  failure: ConnectionAttemptError | null,
): T3ConnectTroubleshootingSection {
  switch (located.cause) {
    case "offline":
      return "this-device-cant-reach-t3-connect";
    case "outdated":
      return "the-host-runs-an-older-t3-code";
    case "clock_skew":
      return "the-clock-is-off";
    case "not_linked":
    case "tunnel_not_enabled":
      return "sign-in-account-or-link-problems";
    case "relay_error":
      return "t3-connect-returned-an-error";
    case "released":
    case "tunnel_down":
    case "tunnel_pending":
      return "the-hosts-tunnel-is-offline";
    case "origin_unreachable":
    case "invalid_response":
      return "the-tunnel-works-but-t3-code-does-not-answer";
    case "dns":
    case "tls":
    case "refused":
    case "timeout":
    case "unknown":
      return "the-t3-connect-address-does-not-resolve-or-answer";
    case null:
      break;
  }
  const onThisDevice =
    failure?.reason === "network" ||
    failure?.reason === "transport" ||
    failure?.reason === "timeout";
  switch (located.hop) {
    case "device":
      return "this-device-cant-reach-t3-connect";
    case "relay":
      return failure?.reason === "authentication"
        ? "sign-in-account-or-link-problems"
        : "this-device-cant-reach-t3-connect";
    case "tunnel":
      return onThisDevice ? "this-device-cant-reach-t3-connect" : "the-hosts-tunnel-is-offline";
    case "server":
      return failure?.reason === "authentication" || failure?.reason === "permission"
        ? "sign-in-account-or-link-problems"
        : "the-tunnel-works-but-t3-code-does-not-answer";
  }
}

const HOP_ORDER = {
  // tempo: Tempo on the host runs its tunnel, so T3 Connect routes show no tunnel row.
  relay: ["device", "relay", "server"],
  direct: ["device", "server"],
} as const;

function hopLabel(hop: ConnectionHop, host: string): string {
  switch (hop) {
    case "device":
      return "This device";
    case "relay":
      return "T3 Connect";
    case "tunnel":
      return `${host} tunnel`;
    case "server":
      return `${TEMPO_APP_BASE_NAME} on ${host}`;
  }
}

/**
 * Turns a connection state into what failed, in order, and what to try. Returns
 * null when nothing has failed. Web and mobile render this same model.
 */
export function presentConnectionDiagnosis(
  input: ConnectionDiagnosisInput,
): ConnectionDiagnosis | null {
  const located = locate(input);
  if (located === null) return null;
  const host = input.hostLabel;
  const failure = input.state.lastFailure;
  const relayPath =
    located.hop === "relay" ||
    located.hop === "tunnel" ||
    (failure === null && input.relayStatus?.status === "offline") ||
    (failure?.via ?? input.via) === "relay";
  const order: ReadonlyArray<ConnectionHop> = HOP_ORDER[relayPath ? "relay" : "direct"];
  // tempo: a tunnel this device can't reach fails at T3 Connect; one the relay can't, at the host.
  const thisDeviceFailed =
    located.cause === null &&
    (failure?.reason === "network" ||
      failure?.reason === "transport" ||
      failure?.reason === "timeout");
  const failedIndex = order.indexOf(
    located.hop !== "tunnel" ? located.hop : thisDeviceFailed ? "relay" : "server",
  );
  const hops = order.map((hop, index): ConnectionDiagnosisHop => ({
    hop,
    label: hopLabel(hop, host),
    result: index < failedIndex ? "ok" : index === failedIndex ? "failed" : "unchecked",
  }));

  // The relay health check only explains the state when no attempt has failed yet.
  const httpStatus = failure !== null ? failure.httpStatus : input.relayStatus?.endpointStatus;
  const facts: Array<readonly [string, string]> = [];
  const add = (label: string, value: string | number | null | undefined) => {
    if (value !== null && value !== undefined && value !== "") facts.push([label, String(value)]);
  };
  add("Cause", located.cause ?? failure?.reason);
  add("HTTP status", httpStatus);
  add("Attempts", input.state.attempt > 0 ? input.state.attempt : null);
  add(
    "Next retry",
    input.state.retryAt === null
      ? null
      : DateTime.formatIso(DateTime.makeUnsafe(input.state.retryAt)),
  );
  add("Route", relayPath ? "T3 Connect" : "Direct");
  add("App version", input.clientVersion);
  add("Host version", input.serverVersion);
  add("Error", failure?.detail);
  add("Trace ID", failure?.traceId);

  return {
    headline: headline(host, located, failure),
    hops,
    steps: steps(host, located, failure),
    facts,
    moreInfoUrl: relayPath ? t3ConnectTroubleshootingUrl(helpSection(located, failure)) : null,
  };
}

const HOP_MARK = { ok: "ok", failed: "FAILED", unchecked: "not checked" } as const;

/** One plain-text block for bug reports. */
export function connectionDiagnosisText(hostLabel: string, diagnosis: ConnectionDiagnosis): string {
  return [
    `${TEMPO_APP_BASE_NAME} connection to ${hostLabel}: ${diagnosis.headline}`,
    "",
    ...diagnosis.hops.map((hop) => `${hop.label}: ${HOP_MARK[hop.result]}`),
    "",
    ...diagnosis.facts.map(([label, value]) => `${label}: ${value}`),
    ...(diagnosis.moreInfoUrl ? ["", `More info: ${diagnosis.moreInfoUrl}`] : []),
  ].join("\n");
}
