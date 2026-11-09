// @effect-diagnostics nodeBuiltinImport:off -- incremental SHA-256 over streamed files; Effect Crypto only digests whole buffers.
import * as NodeCrypto from "node:crypto";

import {
  TempoThreadMoveManifest,
  type TempoThreadMoveArchiveFile,
  type TempoThreadMoveId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

/**
 * A move archive is one file: an 8-byte magic, a big-endian uint32 manifest
 * length, the manifest JSON, then each file the manifest lists, back to back
 * in manifest order. The manifest carries every file's size and SHA-256, so a
 * reader can stream entries straight to disk and verify them.
 */
const ARCHIVE_MAGIC = new TextEncoder().encode("TEMPOMOVE01");
const HEADER_BYTES = ARCHIVE_MAGIC.byteLength + 4;
// Messages are text; a manifest this large means a corrupt or hostile archive.
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const SAFE_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

class ThreadMoveArchiveError extends Schema.TaggedError<ThreadMoveArchiveError>()(
  "ThreadMoveArchiveError",
  {
    moveId: Schema.optional(Schema.String),
    reason: Schema.Literals(["io", "malformed", "checksum"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "malformed":
        return "The move archive is malformed.";
      case "checksum":
        return "A file in the move archive does not match its checksum.";
      case "io":
        return "The move archive could not be read or written.";
    }
  }
}

// The JSON codec carries DateTime fields as ISO strings.
const manifestJson = Schema.fromJsonString(Schema.toCodecJson(TempoThreadMoveManifest));
const encodeManifest = Schema.encodeEffect(manifestJson);
const decodeManifest = Schema.decodeUnknownEffect(manifestJson);

export interface ArchiveInputFile {
  readonly name: string;
  readonly path: string;
}

export type ArchiveManifestWithoutFiles = Omit<TempoThreadMoveManifest, "files">;

function isSafeArchiveFileName(name: string): boolean {
  return SAFE_FILE_NAME.test(name);
}

const io = (moveId: TempoThreadMoveId | undefined) => (cause: unknown) =>
  new ThreadMoveArchiveError({ ...(moveId ? { moveId } : {}), reason: "io", cause });

const hashFile = Effect.fn("ThreadMoveArchive.hashFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const hash = NodeCrypto.createHash("sha256");
  let sizeBytes = 0;
  yield* Stream.runForEach(fileSystem.stream(filePath), (chunk) =>
    Effect.sync(() => {
      sizeBytes += chunk.byteLength;
      hash.update(chunk);
    }),
  );
  return { sizeBytes, sha256: hash.digest("hex") };
});

/** Writes `manifest` and `files` to `archivePath` and returns the full manifest. */
export const writeArchive = Effect.fn("ThreadMoveArchive.write")(function* (input: {
  readonly archivePath: string;
  readonly manifest: ArchiveManifestWithoutFiles;
  readonly files: ReadonlyArray<ArchiveInputFile>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const fail = io(input.manifest.moveId);
  const entries: Array<TempoThreadMoveArchiveFile> = [];
  for (const file of input.files) {
    if (!isSafeArchiveFileName(file.name)) {
      return yield* new ThreadMoveArchiveError({
        moveId: input.manifest.moveId,
        reason: "malformed",
      });
    }
    const digest = yield* hashFile(file.path).pipe(Effect.mapError(fail));
    entries.push({ name: file.name, ...digest });
  }
  const manifest: TempoThreadMoveManifest = { ...input.manifest, files: entries };
  const json = new TextEncoder().encode(
    yield* encodeManifest(manifest).pipe(Effect.mapError(fail)),
  );
  const header = new Uint8Array(HEADER_BYTES + json.byteLength);
  header.set(ARCHIVE_MAGIC, 0);
  new DataView(header.buffer).setUint32(ARCHIVE_MAGIC.byteLength, json.byteLength);
  header.set(json, HEADER_BYTES);
  yield* fileSystem.writeFile(input.archivePath, header).pipe(Effect.mapError(fail));
  for (const file of input.files) {
    yield* Stream.run(
      fileSystem.stream(file.path),
      fileSystem.sink(input.archivePath, { flag: "a" }),
    ).pipe(Effect.mapError(fail));
  }
  return manifest;
});

const readBytes = Effect.fn("ThreadMoveArchive.readBytes")(function* (
  path: string,
  offset: number,
  bytesToRead: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const chunks: Array<Uint8Array> = [];
  let length = 0;
  yield* Stream.runForEach(fileSystem.stream(path, { offset, bytesToRead }), (chunk) =>
    Effect.sync(() => {
      chunks.push(chunk);
      length += chunk.byteLength;
    }),
  );
  const bytes = new Uint8Array(length);
  let position = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, position);
    position += chunk.byteLength;
  }
  return bytes;
});

/** Reads only the manifest of an archive. */
export const readArchiveManifest = Effect.fn("ThreadMoveArchive.readManifest")(function* (
  archivePath: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const malformed = (cause?: unknown) =>
    new ThreadMoveArchiveError({ reason: "malformed", ...(cause === undefined ? {} : { cause }) });
  const info = yield* fileSystem.stat(archivePath).pipe(Effect.mapError(io(undefined)));
  const totalBytes = Number(info.size);
  if (totalBytes < HEADER_BYTES) return yield* malformed();
  const header = yield* readBytes(archivePath, 0, HEADER_BYTES).pipe(
    Effect.mapError(io(undefined)),
  );
  if (!ARCHIVE_MAGIC.every((byte, index) => header[index] === byte)) return yield* malformed();
  const manifestBytes = new DataView(header.buffer, header.byteOffset).getUint32(
    ARCHIVE_MAGIC.byteLength,
  );
  if (manifestBytes > MAX_MANIFEST_BYTES || HEADER_BYTES + manifestBytes > totalBytes) {
    return yield* malformed();
  }
  const json = yield* readBytes(archivePath, HEADER_BYTES, manifestBytes).pipe(
    Effect.mapError(io(undefined)),
  );
  const manifest = yield* decodeManifest(new TextDecoder().decode(json)).pipe(
    Effect.mapError(malformed),
  );
  const payloadBytes = manifest.files.reduce((total, file) => total + file.sizeBytes, 0);
  if (
    HEADER_BYTES + manifestBytes + payloadBytes !== totalBytes ||
    manifest.files.some((file) => !isSafeArchiveFileName(file.name)) ||
    new Set(manifest.files.map((file) => file.name)).size !== manifest.files.length
  ) {
    return yield* malformed();
  }
  return { manifest, payloadOffset: HEADER_BYTES + manifestBytes };
});

/**
 * Reads an archive and writes its files into `extractDir`, verifying each
 * checksum. Returns the manifest and each file's extracted path by name.
 */
export const extractArchive = Effect.fn("ThreadMoveArchive.extract")(function* (input: {
  readonly archivePath: string;
  readonly extractDir: string;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { manifest, payloadOffset } = yield* readArchiveManifest(input.archivePath);
  const fail = io(manifest.moveId);
  yield* fileSystem
    .makeDirectory(input.extractDir, { recursive: true })
    .pipe(Effect.mapError(fail));
  const extracted = new Map<string, string>();
  let offset = payloadOffset;
  for (const file of manifest.files) {
    const target = path.join(input.extractDir, file.name);
    const hash = NodeCrypto.createHash("sha256");
    yield* (
      file.sizeBytes === 0
        ? fileSystem.writeFile(target, new Uint8Array())
        : Stream.run(
            fileSystem
              .stream(input.archivePath, { offset, bytesToRead: file.sizeBytes })
              .pipe(Stream.tap((chunk) => Effect.sync(() => hash.update(chunk)))),
            fileSystem.sink(target),
          )
    ).pipe(Effect.mapError(fail));
    if (hash.digest("hex") !== file.sha256) {
      return yield* new ThreadMoveArchiveError({ moveId: manifest.moveId, reason: "checksum" });
    }
    extracted.set(file.name, target);
    offset += file.sizeBytes;
  }
  return { manifest, files: extracted };
});
