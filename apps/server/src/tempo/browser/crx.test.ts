// @effect-diagnostics nodeBuiltinImport:off - Recomputes Chrome's path hash independently.
import { describe, expect, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import {
  crxDownloadUrl,
  extensionIdFromFolder,
  extensionIdFromPublicKey,
  parseCrx3,
  parseExtensionSource,
} from "./crx.ts";
import { makeCrx3, makeZip } from "./testing/crxFixtures.ts";

const ONE_PASSWORD = "aeblfdkhhhdcdjpifhhbdiojplfjncoa";

describe("parseExtensionSource", () => {
  it("reads ids and both Web Store link shapes", () => {
    expect(parseExtensionSource(` ${ONE_PASSWORD} `)).toEqual({
      _tag: "webStore",
      id: ONE_PASSWORD,
    });
    expect(
      parseExtensionSource(
        `https://chromewebstore.google.com/detail/1password-%E2%80%93-password-mana/${ONE_PASSWORD}?hl=en`,
      ),
    ).toEqual({ _tag: "webStore", id: ONE_PASSWORD });
    expect(parseExtensionSource(`chromewebstore.google.com/detail/${ONE_PASSWORD}`)).toEqual({
      _tag: "webStore",
      id: ONE_PASSWORD,
    });
    expect(
      parseExtensionSource(`https://chrome.google.com/webstore/detail/bitwarden/${ONE_PASSWORD}`),
    ).toEqual({ _tag: "webStore", id: ONE_PASSWORD });
  });

  it("treats absolute paths as unpacked folders on the environment", () => {
    expect(parseExtensionSource("/Users/me/dev/my-extension")).toEqual({
      _tag: "unpacked",
      folder: "/Users/me/dev/my-extension",
    });
    expect(parseExtensionSource("C:\\ext\\mine")).toEqual({
      _tag: "unpacked",
      folder: "C:\\ext\\mine",
    });
  });

  it("rejects other sites, other schemes, and malformed ids", () => {
    expect(parseExtensionSource(`https://evil.example/detail/x/${ONE_PASSWORD}`)).toBeNull();
    expect(parseExtensionSource(`file:///detail/${ONE_PASSWORD}`)).toBeNull();
    expect(
      parseExtensionSource("https://chromewebstore.google.com/category/extensions"),
    ).toBeNull();
    expect(parseExtensionSource("aeblfdkhhhdcdjpifhhbdiojplfjnco")).toBeNull();
    expect(parseExtensionSource("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz")).toBeNull();
    expect(parseExtensionSource("relative/folder")).toBeNull();
  });
});

describe("extension ids", () => {
  it("matches the id Chrome gave an unpacked folder", () => {
    // Chrome's rule (the path's SHA-256, first 32 hex digits spelled a to p) gives this id; the same rule
    // reproduced the id Chrome for Testing gave a loaded folder.
    expect(extensionIdFromFolder("/private/tmp/tempo-browser-exp/ext", "darwin")).toBe(
      "ndcaogepooohikohcmpiklpdieeoaden",
    );
  });

  it("hashes a Windows path as Chrome does: only the drive letter changes case", () => {
    const id = extensionIdFromFolder("C:\\Users\\Kim\\Ext", "win32");
    expect(extensionIdFromFolder("c:\\Users\\Kim\\Ext", "win32")).toBe(id);
    expect(extensionIdFromFolder("C:\\users\\kim\\ext", "win32")).not.toBe(id);
    expect(id).toBe(
      NodeCrypto.createHash("sha256")
        .update(Buffer.from("C:\\Users\\Kim\\Ext", "utf16le"))
        .digest()
        .subarray(0, 16)
        .reduce((text, byte) => text + String.fromCharCode(97 + (byte >> 4), 97 + (byte & 15)), ""),
    );
  });

  it("asks the Web Store for the pinned Chrome's package", () => {
    expect(crxDownloadUrl(ONE_PASSWORD, "154.0.8037.92")).toBe(
      `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=154.0.8037.92&acceptformat=crx2,crx3&x=id%3D${ONE_PASSWORD}%26uc`,
    );
  });
});

describe("parseCrx3", () => {
  const archive = makeZip([{ name: "manifest.json", data: "{}" }]);

  it("accepts a package signed by the key its id names", () => {
    const { crx, publicKey, extensionId } = makeCrx3(archive);
    const parsed = parseCrx3(crx);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.extensionId).toBe(extensionId);
    expect(Buffer.from(parsed.publicKey).equals(publicKey)).toBe(true);
    expect(parsed.archiveOffset).toBe(crx.length - archive.length);
    expect(extensionIdFromPublicKey(publicKey)).toBe(extensionId);
  });

  it("rejects an archive changed after signing", () => {
    const { crx } = makeCrx3(archive, {
      tamper: (bytes) => Buffer.concat([bytes, Buffer.from("x")]),
    });
    expect(parseCrx3(crx)).toBe("bad_signature");
  });

  it("rejects a package claiming another extension's id", () => {
    const { crx } = makeCrx3(archive, { crxId: new Uint8Array(16).fill(7) });
    expect(parseCrx3(crx)).toBe("missing_developer_key");
  });

  it("rejects other formats and broken headers", () => {
    expect(parseCrx3(archive)).toBe("not_crx");
    expect(parseCrx3(makeCrx3(archive, { version: 2 }).crx)).toBe("unsupported_version");
    const { crx } = makeCrx3(archive);
    const truncated = Buffer.from(crx.subarray(0, 40));
    expect(parseCrx3(truncated)).toBe("malformed_header");
    const oversized = Buffer.from(crx);
    oversized.writeUInt32LE(0x7fffffff, 8);
    expect(parseCrx3(oversized)).toBe("malformed_header");
  });
});
