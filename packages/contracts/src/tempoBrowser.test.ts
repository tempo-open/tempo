import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import { TempoBrowserProfileState } from "./tempoBrowser.ts";

const decodeProfile = Schema.decodeUnknownSync(TempoBrowserProfileState);

describe("TempoBrowserProfileState", () => {
  it("reads a profile from a host that does not report its extension browser", () => {
    const profile = decodeProfile({
      profileId: "work",
      extensions: [],
      passkeys: {
        settings: { savePasskeys: true, agentsMayUse: false, provider: "saved" },
        saved: [],
        availableProviders: ["saved"],
      },
    });
    expect(profile.extensionBrowser).toBe("notInstalled");
  });
});
