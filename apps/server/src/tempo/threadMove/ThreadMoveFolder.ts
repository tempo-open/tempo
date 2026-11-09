// @effect-diagnostics nodeBuiltinImport:off -- the walk needs Dirent types (links, sockets, devices); effect FileSystem's stat follows links.
import * as NodeFSP from "node:fs/promises";

import { TempoThreadMoveTooLargeError, type TempoThreadMoveFolderEntry } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

/**
 * tempo: a thread with no Git remote moves as a copy of its folder: every file,
 * folder and link under it, `.git` included. What cannot be copied safely
 * stays behind: sockets, FIFOs, devices, unreadable files, and links that
 * leave the folder, such as a linked worktree's `.git` file.
 */

/** Keeps the manifest, which lists every entry, well under what the archive reader accepts. */
export const MAX_FOLDER_ENTRIES = 100_000;

class ThreadMoveFolderError extends Schema.TaggedError<ThreadMoveFolderError>()(
  "ThreadMoveFolderError",
  {
    reason: Schema.Literals(["io", "unsafe"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.reason === "unsafe"
      ? "The moved folder has an entry that would land outside it."
      : "The moved folder could not be read or written.";
  }
}

const io = (cause: unknown) => new ThreadMoveFolderError({ reason: "io", cause });

/** A name both ends can write: `/` separates entries, and `\` would on Windows. */
function isPlainSegment(segment: string): boolean {
  return (
    segment !== "" &&
    segment !== "." &&
    segment !== ".." &&
    !segment.includes("\\") &&
    !segment.includes("\0")
  );
}

/**
 * Whether a link at `linkPath` with `target` stays in the folder however the
 * links it passes resolve: it climbs only first, never above the folder, then
 * descends without climbing again.
 */
function isInsideLinkTarget(linkPath: string, target: string): boolean {
  if (target === ".") return true;
  const segments = target.split("/");
  let climbs = 0;
  while (segments[climbs] === "..") climbs += 1;
  return climbs <= linkPath.split("/").length - 1 && segments.slice(climbs).every(isPlainSegment);
}

/**
 * Whether unpacking `entries` writes only inside the folder: plain relative
 * paths, each once, every parent a directory listed before it (so nothing
 * lands below a link), files that the archive holds, and links that stay in.
 */
function entriesStayInside(
  entries: ReadonlyArray<TempoThreadMoveFolderEntry>,
  files: ReadonlyMap<string, string>,
): boolean {
  const directories = new Set([""]);
  const paths = new Set<string>();
  const usedFiles = new Set<string>();
  for (const entry of entries) {
    if (!entry.path.split("/").every(isPlainSegment) || paths.has(entry.path)) return false;
    paths.add(entry.path);
    const slash = entry.path.lastIndexOf("/");
    if (!directories.has(slash === -1 ? "" : entry.path.slice(0, slash))) return false;
    if (entry.type === "directory") {
      directories.add(entry.path);
    } else if (entry.type === "file") {
      if (!files.has(entry.file) || usedFiles.has(entry.file)) return false;
      usedFiles.add(entry.file);
    } else if (!isInsideLinkTarget(entry.path, entry.target)) {
      return false;
    }
  }
  return true;
}

/** What `captureMoveFolder` found: the archive files hold the bytes of the `file` entries. */
export interface CapturedMoveFolder {
  readonly entries: ReadonlyArray<TempoThreadMoveFolderEntry>;
  readonly files: ReadonlyArray<{ readonly name: string; readonly path: string }>;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Lists the folder at `root` for a move, parents before children. A folder
 * that is gone yields no entries. Fails with `TempoThreadMoveTooLargeError` as
 * soon as it passes `maxBytes` or `MAX_FOLDER_ENTRIES`.
 */
export const captureMoveFolder = Effect.fn("ThreadMoveFolder.capture")(function* (input: {
  readonly root: string;
  readonly maxBytes: number;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries: Array<TempoThreadMoveFolderEntry> = [];
  const files: Array<{ readonly name: string; readonly path: string }> = [];
  const skipped: Array<string> = [];
  const found: CapturedMoveFolder = { entries, files, skipped };
  let sizeBytes = 0;
  const tooLarge = () =>
    new TempoThreadMoveTooLargeError({
      sizeBytes,
      maxBytes: input.maxBytes,
      maxFolderEntries: MAX_FOLDER_ENTRIES,
    });

  // An absolute link names a real path, so links are judged against the folder's real path.
  const root = yield* fileSystem.realPath(input.root).pipe(
    Effect.map((real): string | null => real),
    Effect.catchIf(
      (error) => error.reason._tag === "NotFound",
      () => Effect.succeed(null),
    ),
    Effect.mapError(io),
  );
  if (root === null) return found;

  /** `target` as seen from the link at `linkPath`, when it resolves inside the folder. */
  const insideTarget = (linkPath: string, target: string): string | null => {
    const linkDirectory = path.dirname(path.join(root, linkPath));
    const resolved = path.resolve(linkDirectory, target);
    const fromRoot = path.relative(root, resolved);
    if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      return null;
    }
    const relative = path.relative(linkDirectory, resolved).split(path.sep).join("/");
    return relative === "" ? "." : relative;
  };

  // A `.git` file links a worktree or submodule to its repository. Git writes
  // a relative link for a submodule, which still works once both are copied;
  // a linked worktree's absolute one would point at a repository elsewhere.
  const gitLinkStaysInside = (absolute: string, linkPath: string) =>
    fileSystem.readFileString(absolute).pipe(
      Effect.map((text) => {
        const gitdir = /^gitdir: (.+)$/m.exec(text)?.[1]?.trim();
        return (
          gitdir !== undefined &&
          !path.isAbsolute(gitdir) &&
          insideTarget(linkPath, gitdir) !== null
        );
      }),
      Effect.orElseSucceed(() => false),
    );

  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const absoluteDirectory = path.join(root, ...directory.split("/"));
    const children = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(absoluteDirectory, { withFileTypes: true }),
      catch: io,
    }).pipe(
      // An unreadable folder below the root travels empty.
      Effect.catch((error) =>
        directory === ""
          ? Effect.fail(error)
          : Effect.sync(() => {
              skipped.push(directory);
              return [];
            }),
      ),
    );
    for (const child of children.toSorted((left, right) => (left.name < right.name ? -1 : 1))) {
      const relative = directory === "" ? child.name : `${directory}/${child.name}`;
      const absolute = path.join(absoluteDirectory, child.name);
      // The manifest lists what stays behind too.
      if (entries.length + skipped.length >= MAX_FOLDER_ENTRIES) return yield* tooLarge();
      if (!isPlainSegment(child.name)) {
        skipped.push(relative);
      } else if (child.isDirectory()) {
        entries.push({ type: "directory", path: relative });
        pending.push(relative);
      } else if (child.isSymbolicLink()) {
        const target = yield* fileSystem.readLink(absolute).pipe(Effect.mapError(io));
        const inside = insideTarget(relative, target);
        if (inside === null) skipped.push(relative);
        else entries.push({ type: "symlink", path: relative, target: inside });
      } else if (
        child.isFile() &&
        (yield* fileSystem.access(absolute, { readable: true }).pipe(Effect.isSuccess)) &&
        (child.name !== ".git" || (yield* gitLinkStaysInside(absolute, relative)))
      ) {
        const info = yield* fileSystem.stat(absolute).pipe(Effect.mapError(io));
        sizeBytes += Number(info.size);
        if (sizeBytes > input.maxBytes) return yield* tooLarge();
        const name = `folder-${files.length}`;
        files.push({ name, path: absolute });
        entries.push({ type: "file", path: relative, file: name, mode: info.mode & 0o777 });
      } else {
        skipped.push(relative);
      }
    }
  }
  return found;
});

/**
 * Unpacks a moved folder's `entries` into `folder`, which must be new and empty. `files` maps each
 * archive file name to where it was extracted; those files are moved into place. Refuses the whole
 * folder, writing nothing, when an entry would land outside it. Links are made last, so nothing is
 * ever written through one.
 */
export const restoreMoveFolder = Effect.fn("ThreadMoveFolder.restore")(function* (input: {
  readonly folder: string;
  readonly entries: ReadonlyArray<TempoThreadMoveFolderEntry>;
  readonly files: ReadonlyMap<string, string>;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  if (!entriesStayInside(input.entries, input.files)) {
    return yield* new ThreadMoveFolderError({ reason: "unsafe" });
  }
  const target = (entryPath: string) => path.join(input.folder, ...entryPath.split("/"));
  for (const entry of input.entries) {
    if (entry.type !== "directory") continue;
    yield* fileSystem
      .makeDirectory(target(entry.path), { recursive: true })
      .pipe(Effect.mapError(io));
  }
  for (const entry of input.entries) {
    if (entry.type !== "file") continue;
    const from = input.files.get(entry.file);
    if (from === undefined) continue;
    const to = target(entry.path);
    yield* fileSystem.rename(from, to).pipe(
      // Across volumes a rename cannot move the file, so it is copied.
      Effect.catch(() => fileSystem.copyFile(from, to)),
      Effect.andThen(fileSystem.chmod(to, entry.mode & 0o777)),
      Effect.mapError(io),
    );
  }
  for (const entry of input.entries) {
    if (entry.type !== "symlink") continue;
    yield* fileSystem.symlink(entry.target, target(entry.path)).pipe(Effect.mapError(io));
  }
});
