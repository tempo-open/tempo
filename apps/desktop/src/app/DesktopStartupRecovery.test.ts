import type { DesktopUpdateState } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createInitialDesktopUpdateState } from "../updates/updateMachine.ts";
import { resolveStartupRecoveryOffer } from "./DesktopStartupRecovery.ts";

const RELEASES = "https://github.com/acme/tempo/releases";

const updateState = (patch: Partial<DesktopUpdateState>): DesktopUpdateState => ({
  ...createInitialDesktopUpdateState(
    "0.1.3",
    { hostArch: "arm64", appArch: "arm64", runningUnderArm64Translation: false },
    "latest",
  ),
  enabled: true,
  ...patch,
});

describe("resolveStartupRecoveryOffer", () => {
  it("offers a newer version before going back", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
        RELEASES,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("offers a retained download after a later check fails", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "error", errorContext: "check", downloadedVersion: "0.1.4" }),
        null,
        RELEASES,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });

  it("waits for the update check before offering to go back", () => {
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "checking" }), "0.1.2", RELEASES),
    ).toEqual({ _tag: "Checking" });
  });

  it("offers the last version that started when no update exists", () => {
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), "0.1.2", RELEASES),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2", url: `${RELEASES}/tag/tempo-v0.1.2` });
  });

  it("does not offer an update that already failed to apply here", () => {
    expect(
      resolveStartupRecoveryOffer(
        updateState({
          status: "downloaded",
          downloadedVersion: "0.1.4",
          notAppliedVersion: "0.1.4",
        }),
        "0.1.2",
        RELEASES,
      ),
    ).toEqual({ _tag: "Reinstall", version: "0.1.2", url: `${RELEASES}/tag/tempo-v0.1.2` });
  });

  it("falls back to the releases page when this version never started", () => {
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.3", RELEASES),
    ).toEqual({ _tag: "Releases", url: RELEASES });
    expect(
      resolveStartupRecoveryOffer(updateState({ status: "up-to-date" }), null, RELEASES),
    ).toEqual({ _tag: "Releases", url: RELEASES });
  });

  it("offers no release page when the build has no release repository", () => {
    expect(resolveStartupRecoveryOffer(updateState({ status: "disabled" }), "0.1.2", null)).toEqual(
      { _tag: "NoReleases" },
    );
    expect(
      resolveStartupRecoveryOffer(
        updateState({ status: "available", availableVersion: "0.1.4" }),
        "0.1.2",
        null,
      ),
    ).toEqual({ _tag: "Update", version: "0.1.4" });
  });
});
