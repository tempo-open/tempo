// @effect-diagnostics nodeBuiltinImport:off -- git's index needs lstat's nanosecond times, inode and device, which effect FileSystem does not expose.
/**
 * tempo: writes a git index (version 2, https://git-scm.com/docs/index-format) for files Tempo has just
 * cloned, so git sees the worktree clean without reading every file back to hash it. The entries
 * (mode, object id, path) come from an index git already wrote for identical files; only the stat
 * data is new.
 */
import * as NodeCrypto from "node:crypto";
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";

export type GitObjectFormat = "sha1" | "sha256";

export interface GitIndexEntry {
  /** The mode as a number, e.g. 0o100644. */
  readonly mode: number;
  /** Hex object id. */
  readonly oid: string;
  /** Repository-relative path, as git lists it. */
  readonly path: string;
}

const GITLINK_MODE = 0o160000;
const NANOS_PER_SECOND = 1_000_000_000n;

/**
 * Parses `git ls-files --stage -z` (`<mode> <oid> <stage>\t<path>\0`). Null when
 * an entry is unmerged or the output is not in that shape.
 */
export function parseStagedEntries(output: string): ReadonlyArray<GitIndexEntry> | null {
  const entries: Array<GitIndexEntry> = [];
  for (const record of output.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const [mode, oid, stage] = tab < 0 ? [] : record.slice(0, tab).split(" ");
    if (mode === undefined || oid === undefined || stage !== "0" || !/^[0-7]+$/.test(mode)) {
      return null;
    }
    entries.push({ mode: Number.parseInt(mode, 8), oid, path: record.slice(tab + 1) });
  }
  return entries;
}

const low32 = (value: bigint) => Number(BigInt.asUintN(32, value));

/** Git keeps 32 bits of a file's size, and never lets a non-empty file's size read as 0. */
const indexedSize = (size: bigint) => {
  const truncated = low32(size);
  return truncated === 0 && size !== 0n ? 0x8000_0000 : truncated;
};

/**
 * Encodes entries, already in git's index order, with each file's `lstat`.
 * Gitlinks keep zero stat data: git checks a submodule's HEAD, not its stat.
 */
export function encodeGitIndex(
  entries: ReadonlyArray<{ readonly entry: GitIndexEntry; readonly stats: NodeFS.BigIntStats }>,
  objectFormat: GitObjectFormat,
): Buffer {
  const hashBytes = objectFormat === "sha256" ? 32 : 20;
  // Ten 32-bit stat fields, the object id, then 16 bits of flags.
  const nameOffset = 40 + hashBytes + 2;
  const header = Buffer.alloc(12);
  header.write("DIRC", 0, "latin1");
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts = [header];
  for (const { entry, stats } of entries) {
    const name = Buffer.from(entry.path, "utf8");
    // NUL-padded to a multiple of 8 bytes, always with at least one NUL.
    const record = Buffer.alloc((nameOffset + name.length + 8) & ~7);
    if (entry.mode !== GITLINK_MODE) {
      record.writeUInt32BE(low32(stats.ctimeNs / NANOS_PER_SECOND), 0);
      record.writeUInt32BE(Number(stats.ctimeNs % NANOS_PER_SECOND), 4);
      record.writeUInt32BE(low32(stats.mtimeNs / NANOS_PER_SECOND), 8);
      record.writeUInt32BE(Number(stats.mtimeNs % NANOS_PER_SECOND), 12);
      record.writeUInt32BE(low32(stats.dev), 16);
      record.writeUInt32BE(low32(stats.ino), 20);
      record.writeUInt32BE(low32(stats.uid), 28);
      record.writeUInt32BE(low32(stats.gid), 32);
      record.writeUInt32BE(indexedSize(stats.size), 36);
    }
    record.writeUInt32BE(entry.mode, 24);
    record.write(entry.oid, 40, hashBytes, "hex");
    record.writeUInt16BE(Math.min(name.length, 0xfff), 40 + hashBytes);
    name.copy(record, nameOffset);
    parts.push(record);
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, NodeCrypto.createHash(objectFormat).update(body).digest()]);
}

/** Writes the index through `index.lock` like git does, so a concurrent git command fails instead of racing. */
export async function writeGitIndexFile(indexPath: string, contents: Buffer): Promise<void> {
  const lockPath = `${indexPath}.lock`;
  const handle = await NodeFSP.open(lockPath, "wx", 0o644);
  try {
    await handle.writeFile(contents);
    await handle.close();
    await NodeFSP.rename(lockPath, indexPath);
  } catch (cause) {
    await handle.close().catch(() => undefined);
    await NodeFSP.rm(lockPath, { force: true });
    throw cause;
  }
}
