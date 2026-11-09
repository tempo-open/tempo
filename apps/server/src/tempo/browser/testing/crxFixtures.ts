// @effect-diagnostics nodeBuiltinImport:off - Test fixtures build signed packages and ZIPs from raw bytes.
import * as Schema from "effect/Schema";
import * as NodeCrypto from "node:crypto";
import * as NodeZlib from "node:zlib";

import { extensionIdFromPublicKey } from "../crx.ts";

export interface ZipFixtureEntry {
  readonly name: string;
  readonly data?: string | Uint8Array;
  /** Unix mode, file type included; defaults to a regular file or folder. */
  readonly mode?: number;
}

/** A stored ZIP whose entries carry Unix modes, like the Web Store's. */
export const makeZip = (entries: ReadonlyArray<ZipFixtureEntry>) => {
  const records: Array<Buffer> = [];
  const directory: Array<Buffer> = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.data ?? "");
    const mode = entry.mode ?? (entry.name.endsWith("/") ? 0o040755 : 0o100644);
    const crc = NodeZlib.crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE((mode << 16) >>> 0, 38);
    central.writeUInt32LE(offset, 42);
    records.push(local, name, data);
    directory.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...records, centralDirectory, end]);
};

const varint = (value: number) => {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80);
    rest = Math.floor(rest / 0x80);
  }
  bytes.push(rest);
  return Buffer.from(bytes);
};

const field = (number: number, bytes: Uint8Array) =>
  Buffer.concat([varint(number * 8 + 2), varint(bytes.length), Buffer.from(bytes)]);

export interface CrxFixtureOptions {
  /** Signs with this key; a fresh RSA key otherwise. */
  readonly privateKey?: NodeCrypto.KeyObject;
  /** Overrides the signed id (16 bytes), to forge a package for another extension. */
  readonly crxId?: Uint8Array;
  /** Changes the archive after signing. */
  readonly tamper?: (archive: Buffer) => Buffer;
  readonly version?: number;
}

/** A CRX3 package signed like the Web Store's developer proof. */
export const makeCrx3 = (archive: Buffer, options: CrxFixtureOptions = {}) => {
  const privateKey =
    options.privateKey ?? NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const publicKey = NodeCrypto.createPublicKey(privateKey).export({ format: "der", type: "spki" });
  const crxId =
    options.crxId ?? NodeCrypto.createHash("sha256").update(publicKey).digest().subarray(0, 16);
  const signedHeaderData = field(1, crxId);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length, 0);
  const signature = NodeCrypto.sign(
    "sha256",
    Buffer.concat([
      Buffer.from("CRX3 SignedData\x00", "binary"),
      length,
      signedHeaderData,
      archive,
    ]),
    privateKey,
  );
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, publicKey), field(2, signature)])),
    field(10000, signedHeaderData),
  ]);
  const prefix = Buffer.alloc(12);
  prefix.write("Cr24", 0, "binary");
  prefix.writeUInt32LE(options.version ?? 3, 4);
  prefix.writeUInt32LE(header.length, 8);
  return {
    crx: Buffer.concat([prefix, header, options.tamper ? options.tamper(archive) : archive]),
    publicKey,
    extensionId: extensionIdFromPublicKey(publicKey),
  };
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A manifest file's text. */
export const manifestJson = (manifest: Record<string, unknown>) => encodeJson(manifest);
