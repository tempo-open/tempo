import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TempoThreadMoveId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  extractArchive,
  readArchiveManifest,
  writeArchive,
  type ArchiveManifestWithoutFiles,
} from "./ThreadMoveArchive.ts";

const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
const manifest: ArchiveManifestWithoutFiles = {
  format: "tempo-thread-move",
  version: 1,
  moveId: TempoThreadMoveId.make("archive-test"),
  createdAt: at,
  source: {
    threadId: ThreadId.make("thread"),
    projectId: ProjectId.make("project"),
    cwd: "/repo",
    workspaceRoot: "/repo",
  },
  repository: { canonicalKey: "github.com/a/b", groupingKey: "github.com/a/b", displayName: "a/b" },
  git: {
    branch: "main",
    headCommit: "f".repeat(40),
    wipCommit: null,
    bundleFile: "repo.bundle",
    bundleRefs: [],
  },
  thread: {
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
    },
    providerDriver: "claudeAgent",
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: at,
    movedFrom: null,
  },
  messages: [{ role: "user", text: "hello", attachments: [], createdAt: at, updatedAt: at }],
  providerRefs: [],
};

const writeFixture = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({
    prefix: "tempo-thread-move-archive-",
  });
  const bundle = path.join(directory, "bundle-input");
  const empty = path.join(directory, "empty-input");
  yield* fileSystem.writeFileString(bundle, "bundle bytes");
  yield* fileSystem.writeFileString(empty, "");
  const archivePath = path.join(directory, "archive.tempomove");
  const written = yield* writeArchive({
    archivePath,
    manifest,
    files: [
      { name: "repo.bundle", path: bundle },
      { name: "attachment-empty", path: empty },
    ],
  });
  return { directory, archivePath, written };
});

describe("ThreadMoveArchive", () => {
  it.effect("round-trips the manifest and every file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, archivePath, written } = yield* writeFixture;
      assert.deepEqual(
        written.files.map((file) => [file.name, file.sizeBytes]),
        [
          ["repo.bundle", 12],
          ["attachment-empty", 0],
        ],
      );
      const extracted = yield* extractArchive({
        archivePath,
        extractDir: path.join(directory, "out"),
      });
      assert.deepEqual(extracted.manifest, written);
      assert.isTrue(DateTime.isDateTime(extracted.manifest.messages[0]?.createdAt));
      assert.equal(
        yield* fileSystem.readFileString(extracted.files.get("repo.bundle")!),
        "bundle bytes",
      );
      assert.equal(yield* fileSystem.readFileString(extracted.files.get("attachment-empty")!), "");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );

  it.effect("rejects a tampered payload, a truncated file, and a foreign file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { directory, archivePath } = yield* writeFixture;
      const bytes = yield* fileSystem.readFile(archivePath);

      const tampered = Uint8Array.from(bytes);
      tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
      yield* fileSystem.writeFile(archivePath, tampered);
      const checksum = yield* extractArchive({
        archivePath,
        extractDir: path.join(directory, "tampered"),
      }).pipe(Effect.flip);
      assert.equal(checksum.reason, "checksum");

      yield* fileSystem.writeFile(archivePath, bytes.subarray(0, bytes.length - 1));
      assert.equal((yield* readArchiveManifest(archivePath).pipe(Effect.flip)).reason, "malformed");

      yield* fileSystem.writeFileString(archivePath, "PK\u0003\u0004 not a move archive");
      assert.equal((yield* readArchiveManifest(archivePath).pipe(Effect.flip)).reason, "malformed");
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
