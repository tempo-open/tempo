// @effect-diagnostics nodeBuiltinImport:off - Pure parsing and signature checks over bytes; Effect has no RSA/ECDSA verify.
/**
 * Chrome extension identities and CRX3 packages, as pure functions. An extension id is the first
 * 16 bytes of a SHA-256, each nibble written as a letter from a to p. Web Store packages hash their
 * developer public key; unpacked folders without a manifest `key` hash their real path.
 *
 * @module crx
 */
import * as NodeCrypto from "node:crypto";

export type ExtensionSourceRef =
  | { readonly _tag: "webStore"; readonly id: string }
  | { readonly _tag: "unpacked"; readonly folder: string };

const EXTENSION_ID = /^[a-p]{32}$/;
const WEB_STORE_HOSTS = new Set(["chromewebstore.google.com", "chrome.google.com"]);

const isExtensionId = (value: string) => EXTENSION_ID.test(value);

/**
 * Reads what a person typed into "Add extension": a Web Store link
 * (`chromewebstore.google.com/detail/<name>/<id>` or the older
 * `chrome.google.com/webstore/detail/...`), a bare id, or an absolute folder
 * path on the environment. Null for anything else.
 */
export const parseExtensionSource = (input: string): ExtensionSourceRef | null => {
  const value = input.trim();
  if (isExtensionId(value)) return { _tag: "webStore", id: value };
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) {
    return { _tag: "unpacked", folder: value };
  }
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (!WEB_STORE_HOSTS.has(url.hostname.toLowerCase())) return null;
  const segments = url.pathname.split("/").filter((segment) => segment !== "");
  const detail = segments.indexOf("detail");
  if (detail === -1) return null;
  const id = segments.slice(detail + 1).find(isExtensionId);
  return id === undefined ? null : { _tag: "webStore", id };
};

const idFromDigest = (digest: Uint8Array) =>
  Array.from(digest.subarray(0, 16), (byte) =>
    String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)),
  ).join("");

/** The id Chrome gives an extension whose manifest `key` (or CRX developer key) is this SPKI DER. */
export const extensionIdFromPublicKey = (publicKey: Uint8Array) =>
  idFromDigest(NodeCrypto.createHash("sha256").update(publicKey).digest());

/**
 * The id Chrome gives an unpacked extension without a manifest `key`: a hash of
 * its real path's bytes. Windows paths are UTF-16 with only a lower-case drive
 * letter upper-cased (Chromium's `crx_file::id_util::GenerateIdForPath`).
 */
export const extensionIdFromFolder = (realPath: string, platform: NodeJS.Platform) =>
  idFromDigest(
    NodeCrypto.createHash("sha256")
      .update(
        platform === "win32"
          ? Buffer.from(
              realPath.replace(/^[a-z](?=:)/, (drive) => drive.toUpperCase()),
              "utf16le",
            )
          : Buffer.from(realPath, "utf8"),
      )
      .digest(),
  );

/** The Web Store's download for one extension, as the given Chrome version asks for it. */
export const crxDownloadUrl = (id: string, chromeVersion: string) =>
  `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=${encodeURIComponent(
    chromeVersion,
  )}&acceptformat=crx2,crx3&x=${encodeURIComponent(`id=${id}&uc`)}`;

export type CrxParseFailure =
  | "not_crx"
  | "unsupported_version"
  | "malformed_header"
  | "missing_developer_key"
  | "bad_signature";

export interface Crx3 {
  /** The id the package was signed for. */
  readonly extensionId: string;
  /** The developer key, SPKI DER, for the manifest's `key`. */
  readonly publicKey: Uint8Array;
  /** Where the ZIP archive starts. */
  readonly archiveOffset: number;
}

/** CRX headers are small; Chrome itself refuses anything near this. */
const MAX_HEADER_BYTES = 256 * 1024;
const SIGNATURE_CONTEXT = Buffer.from("CRX3 SignedData\x00", "binary");

interface ProtoField {
  readonly field: number;
  readonly bytes: Uint8Array | null;
}

/** Length-delimited fields of one protobuf message; other wire types are skipped. */
const readProtoFields = (message: Uint8Array): ReadonlyArray<ProtoField> | null => {
  const fields: Array<ProtoField> = [];
  let offset = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    for (;;) {
      if (offset >= message.length || shift > 49) return null;
      const byte = message[offset++]!;
      result += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7;
    }
  };
  while (offset < message.length) {
    const key = varint();
    if (key === null) return null;
    const field = Math.floor(key / 8);
    const wireType = key % 8;
    if (wireType === 0) {
      if (varint() === null) return null;
      fields.push({ field, bytes: null });
    } else if (wireType === 1 || wireType === 5) {
      offset += wireType === 1 ? 8 : 4;
      if (offset > message.length) return null;
      fields.push({ field, bytes: null });
    } else if (wireType === 2) {
      const length = varint();
      if (length === null || offset + length > message.length) return null;
      fields.push({ field, bytes: message.subarray(offset, offset + length) });
      offset += length;
    } else {
      return null;
    }
  }
  return fields;
};

const bytesOf = (fields: ReadonlyArray<ProtoField>, field: number) =>
  fields
    .filter((entry) => entry.field === field && entry.bytes !== null)
    .map((entry) => entry.bytes!);

/**
 * Parses a CRX3 package and checks it: the `Cr24` magic, version 3, a sane
 * header, a developer key whose id matches the signed `crx_id`, and that key's
 * signature over the signed header and the archive. Chrome's own update path
 * runs the same checks; the Web Store's extra signature is not required.
 */
export const parseCrx3 = (crx: Uint8Array): Crx3 | CrxParseFailure => {
  if (crx.length < 12) return "not_crx";
  const view = new DataView(crx.buffer, crx.byteOffset, crx.byteLength);
  if (Buffer.from(crx.subarray(0, 4)).toString("binary") !== "Cr24") return "not_crx";
  const version = view.getUint32(4, true);
  if (version !== 3) return "unsupported_version";
  const headerLength = view.getUint32(8, true);
  if (headerLength > MAX_HEADER_BYTES || 12 + headerLength > crx.length) return "malformed_header";
  const header = readProtoFields(crx.subarray(12, 12 + headerLength));
  if (header === null) return "malformed_header";
  const signedHeaderData = bytesOf(header, 10000)[0];
  if (signedHeaderData === undefined) return "malformed_header";
  const signedData = readProtoFields(signedHeaderData);
  const crxId = signedData === null ? undefined : bytesOf(signedData, 1)[0];
  if (crxId === undefined || crxId.length !== 16) return "malformed_header";
  const extensionId = idFromDigest(crxId);
  const proofs = [2, 3].flatMap((field) =>
    bytesOf(header, field).flatMap((proof) => {
      const parsed = readProtoFields(proof);
      const publicKey = parsed === null ? undefined : bytesOf(parsed, 1)[0];
      const signature = parsed === null ? undefined : bytesOf(parsed, 2)[0];
      return publicKey && signature ? [{ publicKey, signature }] : [];
    }),
  );
  const developer = proofs.find(
    (proof) => extensionIdFromPublicKey(proof.publicKey) === extensionId,
  );
  if (!developer) return "missing_developer_key";
  const archiveOffset = 12 + headerLength;
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeaderData.length, 0);
  let verified = false;
  try {
    const key = NodeCrypto.createPublicKey({
      key: Buffer.from(developer.publicKey),
      format: "der",
      type: "spki",
    });
    verified = NodeCrypto.verify(
      "sha256",
      Buffer.concat([SIGNATURE_CONTEXT, length, signedHeaderData, crx.subarray(archiveOffset)]),
      key,
      developer.signature,
    );
  } catch {
    verified = false;
  }
  if (!verified) return "bad_signature";
  return { extensionId, publicKey: developer.publicKey, archiveOffset };
};
