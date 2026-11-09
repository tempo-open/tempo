/** tempo: the window's look, so the web's boot script paints it before the saved settings arrive. */
import { TempoLook } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import * as TempoChannels from "./channels.ts";

export const getLook = DesktopIpc.makeSyncIpcMethod({
  channel: TempoChannels.TEMPO_GET_LOOK_CHANNEL,
  result: TempoLook,
  handler: Effect.fn("desktop.tempo.look.get")(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    return yield* desktopWindow.look;
  }),
});
