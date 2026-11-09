/**
 * tempo: your own picture for the home in the tempo look, kept as one file in Tempo's userdata
 * folder. Client settings hold only the choice, because that file is rewritten whole on every
 * change. The web prepares the picture (WebP, at most 1600 px on a side) before it arrives here.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopIpc from "../ipc/DesktopIpc.ts";
import * as TempoChannels from "./channels.ts";

const PICTURE_FILE = "home-picture.webp";
const MAX_PICTURE_BYTES = 16 * 1024 * 1024;

/** The saved picture, or null when none is. */
export const readPicture = Effect.fn("desktop.tempo.homePicture.read")(
  function* (file: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    return yield* fileSystem.readFile(file);
  },
  Effect.orElseSucceed(() => null),
);

/** Replaces the saved picture in one step, so a reader never sees half a file; false when it could not. */
export const writePicture = Effect.fn("desktop.tempo.homePicture.write")(
  function* (file: string, bytes: Uint8Array) {
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_PICTURE_BYTES) return false;
    const fileSystem = yield* FileSystem.FileSystem;
    const partial = `${file}.partial`;
    yield* fileSystem.writeFile(partial, bytes);
    yield* fileSystem.rename(partial, file);
    return true;
  },
  Effect.orElseSucceed(() => false),
);

export const removePicture = Effect.fn("desktop.tempo.homePicture.remove")(function* (
  file: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.remove(file, { force: true }).pipe(Effect.ignore);
});

const pictureFile = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  return environment.path.join(environment.stateDir, PICTURE_FILE);
});

export const readHomePicture = DesktopIpc.makeIpcMethod({
  channel: TempoChannels.TEMPO_READ_HOME_PICTURE_CHANNEL,
  payload: Schema.Void,
  result: Schema.NullOr(Schema.Uint8Array),
  handler: Effect.fn("desktop.ipc.tempo.readHomePicture")(function* () {
    return yield* readPicture(yield* pictureFile);
  }),
});

export const saveHomePicture = DesktopIpc.makeIpcMethod({
  channel: TempoChannels.TEMPO_SAVE_HOME_PICTURE_CHANNEL,
  payload: Schema.Uint8Array,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.tempo.saveHomePicture")(function* (bytes) {
    return yield* writePicture(yield* pictureFile, bytes);
  }),
});

export const removeHomePicture = DesktopIpc.makeIpcMethod({
  channel: TempoChannels.TEMPO_REMOVE_HOME_PICTURE_CHANNEL,
  payload: Schema.Void,
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.tempo.removeHomePicture")(function* () {
    yield* removePicture(yield* pictureFile);
  }),
});
