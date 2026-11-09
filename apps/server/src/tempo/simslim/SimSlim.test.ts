import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Hex from "effect/encoding/Hex";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as ProcessRunner from "../../processRunner.ts";
import * as SimSlim from "./SimSlim.ts";

const hostIs =
  (platform: NodeJS.Platform, architecture: NodeJS.Architecture) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, platform),
      Effect.provideService(HostProcess.Architecture, architecture),
    );

/** A release archive whose binary answers `version` the way simslim does. */
const releaseArchive = Effect.fn("releaseArchive")(function* (directory: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* Crypto.Crypto;
  const source = path.join(directory, "release");
  yield* fs.makeDirectory(source);
  yield* fs.writeFileString(
    path.join(source, "simslim"),
    `#!/bin/sh\necho "simslim ${SimSlim.SIMSLIM_VERSION}"\n`,
  );
  yield* fs.chmod(path.join(source, "simslim"), 0o755);
  const archive = path.join(directory, "simslim.tar.gz");
  yield* runner.run({ command: "tar", args: ["-czf", archive, "-C", source, "simslim"] });
  const bytes = yield* fs.readFile(archive);
  return { bytes, sha256: Hex.encode(yield* crypto.digest("SHA-256", bytes)) };
});

const serving = (bytes: Uint8Array, downloads: { count: number }) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      downloads.count++;
      return HttpClientResponse.fromWeb(request, new Response(new Uint8Array(bytes)));
    }),
  );

describe("installing simslim", () => {
  it.effect("installs the release once its checksum matches the pin, and only once", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-simslim-install-" });
      const release = yield* releaseArchive(baseDir);
      const downloads = { count: 0 };
      const install = SimSlim.ensureSimSlim(baseDir, {
        url: "https://simslim.test/simslim.tar.gz",
        sha256: release.sha256,
      }).pipe(
        Effect.provideService(HttpClient.HttpClient, serving(release.bytes, downloads)),
        hostIs("darwin", "arm64"),
      );
      const binary = yield* install;
      expect(binary).toBe(`${baseDir}/tools/simslim/${SimSlim.SIMSLIM_VERSION}/simslim`);
      expect(yield* install).toBe(binary);
      expect(downloads.count).toBe(1);
      expect(yield* fs.readDirectory(`${baseDir}/tools/simslim`)).toEqual([
        SimSlim.SIMSLIM_VERSION,
      ]);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer)),
    ),
  );

  it.effect("refuses a download that does not match the pinned checksum", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-simslim-checksum-" });
      const release = yield* releaseArchive(baseDir);
      const error = yield* SimSlim.ensureSimSlim(baseDir).pipe(
        Effect.provideService(HttpClient.HttpClient, serving(release.bytes, { count: 0 })),
        hostIs("darwin", "arm64"),
        Effect.flip,
      );
      expect(error.message).toBe("Installing simslim failed while verifying the download.");
      expect(yield* fs.exists(`${baseDir}/tools/simslim`)).toBe(false);
    }).pipe(
      Effect.scoped,
      Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer)),
    ),
  );

  it.effect("skips machines other than Apple silicon Macs without downloading", () =>
    Effect.gen(function* () {
      const offline = HttpClient.make(() => Effect.die(new Error("Must not download")));
      for (const [platform, architecture] of [
        ["linux", "arm64"],
        ["darwin", "x64"],
      ] as const) {
        const binary = yield* SimSlim.ensureSimSlim("/nonexistent").pipe(
          Effect.provideService(HttpClient.HttpClient, offline),
          hostIs(platform, architecture),
        );
        expect(binary).toBeNull();
      }
    }).pipe(Effect.provide(Layer.provideMerge(ProcessRunner.layer, NodeServices.layer))),
  );
});

describe("simSlimStep", () => {
  const stopped = {
    id: "SIM",
    platform: "ios",
    version: "iOS 26.5",
    booted: false,
    physical: false,
  } as const;
  const on = (...flags: ReadonlyArray<string>) => ({
    action: "on",
    args: ["--boot-timeout", "150s", "on", "SIM", ...flags, "--except", "store,web,search,photos"],
  });
  const off = { action: "off", args: ["--boot-timeout", "150s", "off", "SIM"] };

  it("slims before boot where overrides persist, live elsewhere, and restores only at boot", () => {
    const enabled = { enabled: true, slimmed: false };
    const cases = [
      ["stopped, persistent runtime", stopped, enabled, on()],
      ["stopped, iOS 18.5", { ...stopped, version: "iOS 18.5" }, enabled, on()],
      ["stopped, iOS 18.4", { ...stopped, version: "iOS 18.4" }, enabled, on("--no-reboot")],
      ["stopped, unknown version", { ...stopped, version: "iOS" }, enabled, on("--no-reboot")],
      ["running", { ...stopped, booted: true }, enabled, on("--no-reboot")],
      [
        "running, already slimmed",
        { ...stopped, booted: true },
        { ...enabled, slimmed: true },
        null,
      ],
      [
        "running iOS 18.4, slimmed in an earlier boot",
        { ...stopped, booted: true, version: "iOS 18.4" },
        { ...enabled, slimmed: true },
        on("--no-reboot"),
      ],
      ["Android", { ...stopped, platform: "android" }, enabled, null],
      ["physical", { ...stopped, physical: true }, enabled, null],
      ["off, stopped and slimmed", stopped, { enabled: false, slimmed: true }, off],
      [
        "off, running and slimmed",
        { ...stopped, booted: true },
        { enabled: false, slimmed: true },
        null,
      ],
      ["off, never slimmed", stopped, { enabled: false, slimmed: false }, null],
    ] as const;
    for (const [name, device, options, step] of cases) {
      expect(SimSlim.simSlimStep(device, options), name).toEqual(step);
    }
  });
});

describe("preparing a simulator", () => {
  const stopped = {
    id: "SIM",
    platform: "ios",
    version: "iOS 26.5",
    booted: false,
    physical: false,
  } as const;
  const slimKeys = (simSlim: SimSlim.SimSlim) =>
    simSlim.slimmed.pipe(Effect.map((keys) => [...keys]));

  it.effect("keeps the record across failures and restarts until a restore succeeds", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-simslim-record-" });
      const recordPath = `${dir}/device/tempo-simslim.json`;
      const runs: Array<ReadonlyArray<string>> = [];
      let code = 1;
      const host = {
        hostId: "local",
        helpers: { serveSimAxSettings: null, serveSimCli: null, simslim: "/tools/simslim" },
        run: (command: string, args: ReadonlyArray<string>) =>
          Effect.sync(() => {
            runs.push([command, ...args]);
            return { stdout: "", stderr: "simctl boot timed out", code };
          }),
      };
      const key = SimSlim.slimKey("local", "SIM");

      // A failed `on` may still have written overrides, so it counts as slimmed.
      const simSlim = yield* SimSlim.make(recordPath);
      expect(yield* simSlim.prepare(host, stopped, true)).toBe(true);
      expect(yield* slimKeys(simSlim)).toEqual([key]);

      const restarted = yield* SimSlim.make(recordPath);
      expect(yield* slimKeys(restarted)).toEqual([key]);
      expect(yield* restarted.prepare(host, { ...stopped, booted: true }, false)).toBe(false);
      expect(yield* restarted.prepare(host, stopped, false)).toBe(false);
      expect(yield* slimKeys(restarted)).toEqual([key]);

      code = 0;
      expect(yield* restarted.prepare(host, stopped, false)).toBe(true);
      expect(runs).toEqual([
        [
          "/tools/simslim",
          "--boot-timeout",
          "150s",
          "on",
          "SIM",
          "--except",
          "store,web,search,photos",
        ],
        ["/tools/simslim", "--boot-timeout", "150s", "off", "SIM"],
        ["/tools/simslim", "--boot-timeout", "150s", "off", "SIM"],
      ]);
      expect(yield* slimKeys(yield* SimSlim.make(recordPath))).toEqual([]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never fails, and leaves hosts without simslim alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "tempo-simslim-tolerance-" });
      const simSlim = yield* SimSlim.make(`${dir}/tempo-simslim.json`);
      const helpers = { serveSimAxSettings: null, serveSimCli: null };
      const crashing = {
        hostId: "local",
        helpers: { ...helpers, simslim: "/tools/simslim" },
        run: () => Effect.die(new Error("spawn failed")),
      };
      expect(yield* simSlim.prepare(crashing, stopped, true)).toBe(false);
      const without = {
        hostId: "ssh",
        helpers,
        run: () => Effect.die(new Error("Must not run simslim")),
      };
      expect(yield* simSlim.prepare(without, stopped, true)).toBe(false);
      expect(yield* slimKeys(simSlim)).toEqual([SimSlim.slimKey("local", "SIM")]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
