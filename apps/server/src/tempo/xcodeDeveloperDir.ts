/**
 * tempo: iOS simulators need full Xcode's simctl. When the active developer directory is the Command
 * Line Tools (a DEVELOPER_DIR pointing there, or `xcode-select -s`), every simulator command fails
 * even with Xcode installed. Device commands then
 * use the installed Xcode. Only the device host's children get it, so git and builds are unchanged.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";

export const withXcodeDeveloperDir = Effect.fn("tempo.withXcodeDeveloperDir")(function* (
  environment: NodeJS.ProcessEnv,
  hostPlatform: NodeJS.Platform,
  paths: { readonly selectLink: string; readonly xcode: string } = {
    // Where `xcode-select -s` records its choice; reading it starts no process.
    selectLink: "/var/db/xcode_select_link",
    xcode: "/Applications/Xcode.app/Contents/Developer",
  },
) {
  if (hostPlatform !== "darwin") return environment;
  const fs = yield* FileSystem.FileSystem;
  const active =
    environment.DEVELOPER_DIR ??
    (yield* fs.readLink(paths.selectLink).pipe(Effect.orElseSucceed(() => "")));
  if (!active.startsWith(COMMAND_LINE_TOOLS)) return environment;
  const hasSimctl = yield* fs
    .exists(`${paths.xcode}/usr/bin/simctl`)
    .pipe(Effect.orElseSucceed(() => false));
  return hasSimctl ? { ...environment, DEVELOPER_DIR: paths.xcode } : environment;
});
