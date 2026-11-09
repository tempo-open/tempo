import { describe, expect, it } from "vite-plus/test";
import type { DesktopUpdateState } from "@t3tools/contracts";

import {
  canCheckForUpdate,
  getDesktopUpdateButtonTooltip,
  getDesktopUpdateIdleTooltip,
  getDesktopUpdateNotice,
  getDesktopUpdateReleaseHistoryUrl,
  getDesktopUpdateReleaseUrl,
  resolveDesktopUpdateButtonAction,
} from "./desktopUpdate.logic";

const baseState: DesktopUpdateState = {
  enabled: true,
  status: "idle",
  channel: "latest",
  currentVersion: "1.0.0",
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
  availableVersion: null,
  downloadedVersion: null,
  releaseNotes: [],
  omittedReleaseCount: 0,
  downloadPercent: null,
  checkedAt: null,
  message: null,
  errorContext: null,
  canRetry: false,
};

describe("desktop update button state", () => {
  it("keeps retry action available after a download error", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "error",
      availableVersion: "1.1.0",
      message: "network timeout",
      errorContext: "download",
      canRetry: true,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
    expect(getDesktopUpdateButtonTooltip(state)).toContain("Click to retry");
  });

  it("prefers a newly available release over a stale downloaded version", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "available",
      availableVersion: "1.2.0",
      downloadedVersion: "1.1.0",
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("download");
  });

  it("hides the install action while checking for a newer release", () => {
    const state: DesktopUpdateState = {
      ...baseState,
      status: "checking",
      availableVersion: "1.1.0",
      downloadedVersion: "1.1.0",
      downloadPercent: 100,
    };
    expect(resolveDesktopUpdateButtonAction(state)).toBe("none");
  });
});

describe("desktop update UI helpers", () => {
  it("links the releases of the repository the build names", () => {
    expect(getDesktopUpdateReleaseHistoryUrl("acme/app")).toBe(
      "https://github.com/acme/app/releases",
    );
    expect(getDesktopUpdateReleaseUrl("1.2.3", "acme/app")).toBe(
      "https://github.com/acme/app/releases/tag/tempo-v1.2.3",
    );
  });

  it.each([undefined, "", "owner/repo/extra", "owner#notes/repo", "owner/repo?tab=notes"])(
    "links no releases when the build names no valid repository: %s",
    (repository) => {
      expect(getDesktopUpdateReleaseHistoryUrl(repository)).toBeNull();
      expect(getDesktopUpdateReleaseUrl("1.2.3", repository)).toBeNull();
    },
  );
});

describe("canCheckForUpdate", () => {
  it("returns true once an update has been downloaded so newer releases can be found", () => {
    expect(
      canCheckForUpdate({
        ...baseState,
        status: "downloaded",
        availableVersion: "1.1.0",
        downloadedVersion: "1.1.0",
      }),
    ).toBe(true);
  });
});

describe("getDesktopUpdateNotice", () => {
  it("says why a quiet state has nothing to offer when the desktop gave a reason", () => {
    const skipped: DesktopUpdateState = {
      ...baseState,
      status: "idle",
      message: "The last check was skipped on a metered network.",
    };
    expect(getDesktopUpdateButtonTooltip(skipped)).toBe(
      "The last check was skipped on a metered network.",
    );
    expect(getDesktopUpdateNotice(skipped)).toBe(
      "The last check was skipped on a metered network.",
    );
    expect(getDesktopUpdateIdleTooltip(skipped)).toEqual({
      title: "Check for updates",
      detail: "The last check was skipped on a metered network.",
    });
    expect(getDesktopUpdateNotice({ ...baseState, status: "idle", message: "  " })).toBeNull();
    // A failure keeps its own wording; the notice is only for quiet states.
    expect(
      getDesktopUpdateNotice({ ...baseState, status: "error", message: "network" }),
    ).toBeNull();
  });

  it("says plainly when this build gets no updates", () => {
    const noFeed: DesktopUpdateState = {
      ...baseState,
      enabled: false,
      status: "disabled",
      message: "This build does not get updates.",
    };
    expect(getDesktopUpdateNotice(noFeed)).toBe("This build does not get updates.");
    expect(getDesktopUpdateButtonTooltip(noFeed)).toBe("This build does not get updates.");
    expect(getDesktopUpdateNotice({ ...noFeed, message: null })).toBeNull();
  });
});
