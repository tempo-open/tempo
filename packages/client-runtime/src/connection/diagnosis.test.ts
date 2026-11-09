import {
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointFailure,
  RelayEnvironmentEndpointUnavailableError,
  type RelayProtectedError,
} from "@t3tools/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import { presentConnectionDiagnosis } from "./diagnosis.ts";
import { mapManagedRelayError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  type ConnectionAttemptError,
  type SupervisorConnectionState,
} from "./model.ts";
import { ManagedRelayRequestFailedError } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthFetchError } from "../rpc/http.ts";

const backoff = (lastFailure: ConnectionAttemptError): SupervisorConnectionState => ({
  ...AVAILABLE_CONNECTION_STATE,
  desired: true,
  network: "online",
  phase: "backoff",
  attempt: 3,
  lastFailure,
  retryAt: Date.UTC(2026, 9, 19, 12, 0, 30),
});

const fromRelay = (relayError: RelayProtectedError) =>
  mapManagedRelayError(
    new ManagedRelayRequestFailedError({
      action: "connect relay environment",
      cause: relayError,
      relayError,
    }),
  );

const unavailable = (endpointFailure: RelayEnvironmentEndpointFailure) =>
  fromRelay(
    new RelayEnvironmentEndpointUnavailableError({
      code: "environment_endpoint_unavailable",
      reason: "endpoint_request_failed",
      endpointFailure,
      endpointStatus: endpointFailure === "tunnel_down" ? 530 : 502,
      traceId: "trace-1",
    }),
  );

const diagnose = (state: SupervisorConnectionState, via: "relay" | "direct" = "relay") =>
  presentConnectionDiagnosis({ hostLabel: "Mac mini", state, via });

const results = (state: SupervisorConnectionState, via?: "relay" | "direct") =>
  diagnose(state, via)?.hops.map((hop) => `${hop.hop}:${hop.result}`);

describe("presentConnectionDiagnosis", () => {
  // tempo: Tempo on the host runs its tunnel, so the host itself fails, never a tunnel row.
  it("names Tempo on the host as offline when its tunnel is down", () => {
    const diagnosis = diagnose(backoff(unavailable("tunnel_down")));
    expect(diagnosis?.headline).toBe("Tempo on Mac mini is offline");
    expect(results(backoff(unavailable("tunnel_down")))).toEqual([
      "device:ok",
      "relay:ok",
      "server:failed",
    ]);
    expect(diagnosis?.steps).toContain(
      "If Tempo on Mac mini was just updated, give it a minute to restart.",
    );
    // This device cannot know that the host's network blocks the tunnel's port.
    expect(diagnosis?.steps.join(" ")).not.toMatch(/7844|VPN/);
  });

  // tempo: no headline, row, or step names the host's tunnel.
  it("never names the host's tunnel", () => {
    const released = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", offlineReason: "tunnel_released" },
    });
    expect(released?.headline).toBe("Tempo on Mac mini is offline");
    const diagnoses = [
      released,
      ...RelayEnvironmentEndpointFailure.literals.map((cause) =>
        diagnose(backoff(unavailable(cause))),
      ),
      ...(["managed_endpoint_allocation_not_ready", "endpoint_provider_not_managed"] as const).map(
        (reason) =>
          diagnose(
            backoff(
              fromRelay(
                new RelayEnvironmentConnectNotAuthorizedError({
                  code: "environment_connect_not_authorized",
                  reason,
                  traceId: "trace-1",
                }),
              ),
            ),
          ),
      ),
      diagnose(
        backoff(
          mapRemoteEnvironmentError(
            new RemoteEnvironmentAuthFetchError({ message: "Failed", cause: new TypeError() }),
            "relay",
          ),
        ),
      ),
    ];
    for (const diagnosis of diagnoses) {
      expect(diagnosis).not.toBeNull();
      const shown = [
        diagnosis?.headline,
        ...(diagnosis?.hops ?? []).map((hop) => hop.label),
        ...(diagnosis?.steps ?? []),
      ];
      expect(shown.join(" ")).not.toMatch(/tunnel/i);
    }
  });

  it("tells T3 Connect reaching the host apart from Tempo not answering", () => {
    expect(diagnose(backoff(unavailable("origin_unreachable")))?.headline).toBe(
      "Tempo on Mac mini did not answer",
    );
    expect(results(backoff(unavailable("origin_unreachable")), "direct")).toEqual([
      "device:ok",
      "relay:ok",
      "server:failed",
    ]);
  });

  it("blames this device when it cannot reach a host the relay already reached", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
      "relay",
    );
    // A learned LAN route makes the environment's usual route direct; the failure still names the relay.
    const diagnosis = diagnose(backoff(failure), "direct");
    expect(diagnosis?.headline).toBe("This device can't reach Mac mini through T3 Connect");
    expect(results(backoff(failure), "direct")).toEqual([
      "device:ok",
      "relay:failed",
      "server:unchecked",
    ]);
    expect(diagnosis?.steps.join(" ")).not.toContain("On Mac mini");
  });

  it("stops at T3 Connect when this device cannot reach the relay", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        transportFailed: true,
        cause: new TypeError("Failed to fetch"),
      }),
    );
    expect(diagnose(backoff(failure))?.headline).toBe("This device can't reach T3 Connect");
    expect(results(backoff(failure))).toEqual(["device:ok", "relay:failed", "server:unchecked"]);
  });

  it("does not blame this device's network when T3 Connect answered with an error", () => {
    const failure = mapManagedRelayError(
      new ManagedRelayRequestFailedError({
        action: "connect relay environment",
        cause: new Error("Bad Gateway"),
        status: 502,
      }),
    );
    const diagnosis = diagnose(backoff(failure));
    expect(diagnosis?.headline).toBe("T3 Connect returned an error");
    expect(diagnosis?.steps.join(" ")).not.toContain("this device");
  });

  it("reports this device as offline before any other hop", () => {
    const state = { ...backoff(unavailable("tunnel_down")), network: "offline" as const };
    expect(diagnose(state)?.headline).toBe("This device is offline");
    expect(results(state)?.[0]).toBe("device:failed");
  });

  it("uses the relay health check before any connect attempt fails", () => {
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "relay",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.headline).toBe("Tempo on Mac mini is offline");
    const origin = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: AVAILABLE_CONNECTION_STATE,
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "origin_unreachable" },
    });
    expect(origin?.hops.map((hop) => hop.hop)).toEqual(["device", "relay", "server"]);
  });

  it("keeps the relay health status out of a failure that has its own cause", () => {
    const failure = mapRemoteEnvironmentError(
      new RemoteEnvironmentAuthFetchError({ message: "Failed to fetch", cause: new TypeError() }),
    );
    const diagnosis = presentConnectionDiagnosis({
      hostLabel: "Mac mini",
      state: backoff(failure),
      via: "direct",
      relayStatus: { status: "offline", endpointFailure: "tunnel_down", endpointStatus: 530 },
    });
    expect(diagnosis?.facts.map(([label]) => label)).not.toContain("HTTP status");
  });
});
