import type { DesktopLaptopToolsBridge, DesktopLaptopToolsState } from "@t3tools/contracts";
import type { IpcRenderer, IpcRendererEvent } from "electron";

import * as Channels from "./channels.ts";

/** `window.desktopBridge.laptopTools`, built in the preload. */
export function createLaptopToolsBridge(ipcRenderer: IpcRenderer): DesktopLaptopToolsBridge {
  return {
    getState: () => ipcRenderer.invoke(Channels.LAPTOP_TOOLS_GET_STATE_CHANNEL),
    setConfig: (config) => ipcRenderer.invoke(Channels.LAPTOP_TOOLS_SET_CONFIG_CHANNEL, config),
    handleRequest: (input) =>
      ipcRenderer.invoke(Channels.LAPTOP_TOOLS_HANDLE_REQUEST_CHANNEL, input),
    cancelRequest: (input) =>
      ipcRenderer.invoke(Channels.LAPTOP_TOOLS_CANCEL_REQUEST_CHANNEL, input),
    stop: (input) => ipcRenderer.invoke(Channels.LAPTOP_TOOLS_STOP_CHANNEL, input),
    runChanged: (input) => ipcRenderer.invoke(Channels.LAPTOP_TOOLS_RUN_CHANGED_CHANNEL, input),
    onState: (listener) => {
      const wrapped = (_event: IpcRendererEvent, state: unknown) => {
        if (typeof state !== "object" || state === null) return;
        listener(state as DesktopLaptopToolsState);
      };
      ipcRenderer.on(Channels.LAPTOP_TOOLS_STATE_CHANNEL, wrapped);
      return () => ipcRenderer.removeListener(Channels.LAPTOP_TOOLS_STATE_CHANNEL, wrapped);
    },
  };
}
