import { describe, expect, it } from "vite-plus/test";

import {
  cliArchiveTarCommand,
  cliReleaseDownloadBaseUrl,
  cliReleaseIndexPageUrl,
  newestCliReleaseVersion,
  parseChecksums,
} from "./cliRelease.ts";

describe("cliRelease", () => {
  it("resolves download URLs under the tagged release of a mirror", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3", "https://mirror.example/t3/")).toBe(
      "https://mirror.example/t3/tempo-v1.2.3",
    );
  });

  it("has no release feed without a mirror, since this build names no release repository", () => {
    expect(cliReleaseDownloadBaseUrl("1.2.3")).toBeNull();
    expect(cliReleaseDownloadBaseUrl("1.2.3", "  ")).toBeNull();
    expect(cliReleaseIndexPageUrl(1)).toBeNull();
  });

  it("parses sha256sum output including binary-mode markers", () => {
    const checksums = parseChecksums(
      [
        `${"a".repeat(64)}  t3-1.2.3-linux-x64.tar.gz`,
        `${"B".repeat(64)} *t3-1.2.3-win32-x64.zip`,
        "not a checksum line",
        "",
      ].join("\n"),
    );
    expect(checksums.get("t3-1.2.3-linux-x64.tar.gz")).toBe("a".repeat(64));
    expect(checksums.get("t3-1.2.3-win32-x64.zip")).toBe("b".repeat(64));
    expect(checksums.size).toBe(2);
  });

  it("extracts with the System32 bsdtar on Windows and plain tar elsewhere", () => {
    expect(cliArchiveTarCommand("linux", {})).toBe("tar");
    expect(cliArchiveTarCommand("win32", { SystemRoot: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\tar.exe",
    );
    expect(cliArchiveTarCommand("win32", {})).toBe("C:\\Windows\\System32\\tar.exe");
  });

  it("picks the newest non-draft release on the requested channel", () => {
    const releases = [
      { tag_name: "tempo-v1.2.4-preview.20260912.9", draft: true },
      { tag_name: "tempo-v1.2.4-preview.20260912.8" },
      { tag_name: "tempo-v1.2.4-nightly.20260912.7" },
      { tag_name: "desktop-preview" },
      // Other apps' releases in the same repository.
      { tag_name: "v1.3.0" },
      { tag_name: "release/ios/5.8.1-8" },
      { tag_name: "tempo-v1.2.3" },
      { tag_name: "tempo-v1.2.3-nightly.20260911.2" },
    ];
    expect(newestCliReleaseVersion(releases, "preview")).toBe("1.2.4-preview.20260912.8");
    expect(newestCliReleaseVersion(releases, "nightly")).toBe("1.2.4-nightly.20260912.7");
    expect(newestCliReleaseVersion(releases, "stable")).toBe("1.2.3");
    expect(newestCliReleaseVersion([{ tag_name: "tempo-v1.2.3" }], "preview")).toBeUndefined();
  });
});
