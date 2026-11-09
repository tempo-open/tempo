import {
  DesktopLaptopToolsCancelInput,
  DesktopLaptopToolsConfig,
  DesktopLaptopToolsHandleInput,
  DesktopLaptopToolsRunChangedInput,
  DesktopLaptopToolsState,
  DesktopLaptopToolsStopInput,
  LaptopToolsOutcome,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { makeIpcMethod } from "../../ipc/DesktopIpc.ts";
import * as Channels from "./channels.ts";
import { DesktopLaptopTools } from "./DesktopLaptopTools.ts";

const getState = makeIpcMethod({
  channel: Channels.LAPTOP_TOOLS_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopLaptopToolsState,
  handler: () => Effect.flatMap(Effect.service(DesktopLaptopTools), (tools) => tools.getState),
});

const setConfig = makeIpcMethod({
  channel: Channels.LAPTOP_TOOLS_SET_CONFIG_CHANNEL,
  payload: DesktopLaptopToolsConfig,
  result: DesktopLaptopToolsState,
  handler: (config) =>
    Effect.flatMap(Effect.service(DesktopLaptopTools), (tools) => tools.setConfig(config)),
});

const handleRequest = makeIpcMethod({
  channel: Channels.LAPTOP_TOOLS_HANDLE_REQUEST_CHANNEL,
  payload: DesktopLaptopToolsHandleInput,
  result: LaptopToolsOutcome,
  handler: (input) =>
    Effect.flatMap(Effect.service(DesktopLaptopTools), (tools) => tools.handleRequest(input)),
});

const cancelRequest = makeIpcMethod({
  channel: Channels.LAPTOP_TOOLS_CANCEL_REQUEST_CHANNEL,
  payload: DesktopLaptopToolsCancelInput,
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(Effect.service(DesktopLaptopTools), (tools) => tools.cancelRequest(input)),
});

const stop = makeIpcMethod({
  channel: Channels.LAPTOP_TOOLS_STOP_CHANNEL,
  payload: DesktopLaptopToolsStopInput,
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(Effect.service(DesktopLaptopTools), (tools) => tools.stop(input)),
});

const runChanged = makeIpcMethod({
  channel: Channels.LAPTOP_TOOLS_RUN_CHANGED_CHANNEL,
  payload: DesktopLaptopToolsRunChangedInput,
  result: Schema.Void,
  handler: (input) =>
    Effect.flatMap(Effect.service(DesktopLaptopTools), (tools) => tools.runChanged(input)),
});

/** tempo laptop tool IPC methods, registered by `installDesktopIpcHandlers`. */
export const laptopToolsIpcMethods = [
  getState,
  setConfig,
  handleRequest,
  cancelRequest,
  stop,
  runChanged,
] as const;
