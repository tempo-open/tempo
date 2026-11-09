// @effect-diagnostics nodeBuiltinImport:off - the pin is the plain sha256 of the upstream file.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as NodeCrypto from "node:crypto";

import * as ServerConfig from "../../config.ts";
import * as ReposVolume from "./ReposVolume.ts";
import { REPOS_VOLUME_SCRIPT } from "./reposVolumeScript.ts";

const HOME = "/Users/person";

const failure = (tag: "NotFound" | "PermissionDenied", method: string, path: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method,
    pathOrDescriptor: path,
    description: `Test ${tag} failure.`,
  });

const withReposVolume = <A, E, R>(
  use: (reposVolume: ReposVolume.ReposVolume["Service"]) => Effect.Effect<A, E, R>,
  fileSystemOverrides: Partial<FileSystem.FileSystem> = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const reposVolume = yield* ReposVolume.make.pipe(
      Effect.provideService(FileSystem.FileSystem, { ...fileSystem, ...fileSystemOverrides }),
    );
    return yield* use(reposVolume);
  }).pipe(
    Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-repos-volume-" })),
    Effect.provideService(HostProcess.HomeDirectory, HOME),
  );

/** Each path's device; a path left out does not exist. */
const statusOf = (devices: Readonly<Record<string, bigint>>, links: ReadonlyArray<string> = []) =>
  withReposVolume((reposVolume) => reposVolume.status, {
    readLink: (path) =>
      links.includes(path)
        ? Effect.succeed("/Volumes/Elsewhere")
        : Effect.fail(failure("NotFound", "readLink", path)),
    stat: (path) => {
      const dev = devices[path];
      return dev === undefined
        ? Effect.fail(failure("NotFound", "stat", path))
        : Effect.succeed({ type: "Directory", dev } as FileSystem.File.Info);
    },
  });

it("embeds the upstream setup script byte for byte", () => {
  const digest = NodeCrypto.createHash("sha256").update(REPOS_VOLUME_SCRIPT, "utf8").digest("hex");
  expect(digest).toBe("13a352c7a2311617c791fd6ac055e9ce88514e1ef9673b3980c8abf269290110");
});

it.layer(NodeServices.layer)("ReposVolume", (it) => {
  describe("status", () => {
    it.effect("reports ~/repos mounted only when it is on another device than home", () =>
      Effect.gen(function* () {
        const paths = {
          path: `${HOME}/repos`,
          worktreesPath: `${HOME}/repos/.worktrees`,
        };
        expect(yield* statusOf({ [HOME]: 1n, [`${HOME}/repos`]: 2n })).toEqual({
          ...paths,
          mounted: true,
        });
        // A plain folder, or no folder at all, before setup.
        expect(yield* statusOf({ [HOME]: 1n, [`${HOME}/repos`]: 1n })).toEqual({
          ...paths,
          mounted: false,
        });
        expect(yield* statusOf({ [HOME]: 1n })).toEqual({ ...paths, mounted: false });
      }),
    );

    it.effect("does not count a link to another volume as mounted", () =>
      Effect.gen(function* () {
        const status = yield* statusOf({ [HOME]: 1n, [`${HOME}/repos`]: 2n }, [`${HOME}/repos`]);
        expect(status.mounted).toBe(false);
      }),
    );

    it.effect("fails rather than guessing when home cannot be read", () =>
      Effect.gen(function* () {
        const error = yield* withReposVolume((reposVolume) => reposVolume.status, {
          readLink: (path) => Effect.fail(failure("NotFound", "readLink", path)),
          stat: (path) =>
            path === HOME
              ? Effect.fail(failure("PermissionDenied", "stat", path))
              : Effect.succeed({ type: "Directory", dev: 2n } as FileSystem.File.Info),
        }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "TempoReposVolumeError", operation: "status" });
      }),
    );
  });

  describe("prepare", () => {
    it.effect("writes exactly the setup script, readable only by this user", () =>
      withReposVolume((reposVolume) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const directory = path.join(stateDir, "repos-volume");

          const prepared = yield* reposVolume.prepare;

          expect(prepared).toEqual({
            scriptPath: path.join(directory, "repos-volume.sh"),
            cwd: HOME,
          });
          expect(yield* fileSystem.readFileString(prepared.scriptPath)).toBe(REPOS_VOLUME_SCRIPT);
          expect((yield* fileSystem.stat(prepared.scriptPath)).mode & 0o777).toBe(0o700);
          expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700);
          expect(yield* fileSystem.readDirectory(directory)).toEqual(["repos-volume.sh"]);
        }),
      ),
    );

    it.effect("replaces an earlier copy whole and tightens a loosened folder", () =>
      withReposVolume((reposVolume) =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const { stateDir } = yield* ServerConfig.ServerConfig;
          const directory = path.join(stateDir, "repos-volume");
          const scriptPath = path.join(directory, "repos-volume.sh");
          yield* fileSystem.makeDirectory(directory, { recursive: true });
          yield* fileSystem.chmod(directory, 0o755);
          yield* fileSystem.writeFileString(scriptPath, "echo stale\n", { mode: 0o644 });

          yield* reposVolume.prepare;

          expect(yield* fileSystem.readFileString(scriptPath)).toBe(REPOS_VOLUME_SCRIPT);
          expect((yield* fileSystem.stat(scriptPath)).mode & 0o777).toBe(0o700);
          expect((yield* fileSystem.stat(directory)).mode & 0o777).toBe(0o700);
          expect(yield* fileSystem.readDirectory(directory)).toEqual(["repos-volume.sh"]);
        }),
      ),
    );
  });
});
