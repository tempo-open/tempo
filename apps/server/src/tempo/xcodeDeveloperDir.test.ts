import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { withXcodeDeveloperDir } from "./xcodeDeveloperDir.ts";

const COMMAND_LINE_TOOLS = "/Library/Developer/CommandLineTools";

/** An installed Xcode (a Developer directory with simctl) and an `xcode-select` link to `target`. */
const machine = (target: string | null) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-xcode-" });
    const xcode = `${root}/Xcode.app/Contents/Developer`;
    yield* fs.makeDirectory(`${xcode}/usr/bin`, { recursive: true });
    yield* fs.writeFileString(`${xcode}/usr/bin/simctl`, "");
    const selectLink = `${root}/xcode_select_link`;
    if (target !== null) yield* fs.symlink(target, selectLink);
    return { selectLink, xcode };
  });

describe("withXcodeDeveloperDir", () => {
  it.effect("points device commands at Xcode when xcode-select chose the Command Line Tools", () =>
    Effect.gen(function* () {
      const paths = yield* machine(COMMAND_LINE_TOOLS);
      const environment = yield* withXcodeDeveloperDir({ PATH: "/usr/bin" }, "darwin", paths);
      expect(environment).toEqual({ PATH: "/usr/bin", DEVELOPER_DIR: paths.xcode });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("overrides a DEVELOPER_DIR that names the Command Line Tools", () =>
    Effect.gen(function* () {
      const paths = yield* machine(null);
      const environment = yield* withXcodeDeveloperDir(
        { DEVELOPER_DIR: COMMAND_LINE_TOOLS },
        "darwin",
        paths,
      );
      expect(environment.DEVELOPER_DIR).toBe(paths.xcode);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves a Mac that uses Xcode, or has none, as it is", () =>
    Effect.gen(function* () {
      const paths = yield* machine(null);
      expect(yield* withXcodeDeveloperDir({}, "darwin", paths)).toEqual({});
      const custom = { DEVELOPER_DIR: "/Applications/Xcode-beta.app/Contents/Developer" };
      expect(yield* withXcodeDeveloperDir(custom, "darwin", paths)).toEqual(custom);
      const noXcode = yield* withXcodeDeveloperDir(
        { DEVELOPER_DIR: COMMAND_LINE_TOOLS },
        "darwin",
        {
          ...paths,
          xcode: `${paths.xcode}/missing`,
        },
      );
      expect(noXcode).toEqual({ DEVELOPER_DIR: COMMAND_LINE_TOOLS });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("changes nothing off macOS", () =>
    Effect.gen(function* () {
      const paths = yield* machine(COMMAND_LINE_TOOLS);
      expect(yield* withXcodeDeveloperDir({ PATH: "/bin" }, "linux", paths)).toEqual({
        PATH: "/bin",
      });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
