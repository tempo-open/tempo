import { subscribe } from "@t3tools/client-runtime/rpc";
import {
  createEnvironmentRpcCommand,
  createEnvironmentSubscriptionAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import {
  LAPTOP_TOOLS_WS_METHODS,
  type DesktopLaptopToolsState,
  type LaptopToolsHostRegistration,
  type LaptopToolsStreamEvent,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";

import { relayLaptopToolsEvents } from "./laptopToolsRequests";

/** `window.desktopBridge.laptopTools`; null outside desktop builds that host laptop tools. */
export const laptopToolsBridge =
  typeof window === "undefined" ? null : (window.desktopBridge?.laptopTools ?? null);

/** The relay of each mounted registration, by the key its subscription carries. */
const relays = new Map<string, (event: LaptopToolsStreamEvent) => void>();

/** Routes a registration's events to `relay` until the returned function is called. */
export function registerLaptopToolsRelay(
  relayKey: string,
  relay: (event: LaptopToolsStreamEvent) => void,
): () => void {
  relays.set(relayKey, relay);
  return () => {
    if (relays.get(relayKey) === relay) relays.delete(relayKey);
  };
}

export const laptopToolsEnvironment = {
  /**
   * This desktop's registration with one environment; requests arrive on it.
   * Every event goes to the relay registered under `relayKey`, so each mount
   * gets its own stream and nothing is read as a latest value.
   */
  connect: createEnvironmentSubscriptionAtomFamily(connectionAtomRuntime, {
    label: "tempo:laptop-tools:connect",
    sensitiveInput: true,
    subscribe: (input: {
      readonly registration: LaptopToolsHostRegistration;
      readonly relayKey: string;
    }) =>
      relayLaptopToolsEvents(
        subscribe(LAPTOP_TOOLS_WS_METHODS.connect, input.registration),
        (event) => relays.get(input.relayKey)?.(event),
      ),
    // Unmounting must unregister the laptop right away.
    idleTtlMs: 0,
  }),
  respond: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "tempo:laptop-tools:respond",
    tag: LAPTOP_TOOLS_WS_METHODS.respond,
  }),
};

/** The desktop's laptop tool state, kept current from the main process. */
export function useLaptopToolsState(): DesktopLaptopToolsState | null {
  const [state, setState] = useState<DesktopLaptopToolsState | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the desktop main process's laptop tool state over the bridge while mounted
  useEffect(() => {
    if (laptopToolsBridge === null) return;
    let active = true;
    const unsubscribe = laptopToolsBridge.onState((next) => {
      if (active) setState(next);
    });
    void laptopToolsBridge.getState().then((initial) => {
      if (active) setState((current) => current ?? initial);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, []);
  return state;
}
