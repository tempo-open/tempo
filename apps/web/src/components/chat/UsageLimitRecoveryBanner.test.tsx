import { type TempoLook, ProviderInstanceId, RunId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { usageLimitRecoveryBannerItem } from "./UsageLimitRecoveryBanner";

const stoppedAt = new Date(2026, 9, 20, 12, 0);

function bannerItem(
  resetAt: Date,
  timestampFormat: TimestampFormat,
  { look = "classic", provider = "claudeAgent" }: { look?: TempoLook; provider?: string } = {},
) {
  return usageLimitRecoveryBannerItem({
    runId: RunId.make("run-1"),
    providerInstanceId: ProviderInstanceId.make(provider),
    resetAt: resetAt.toISOString(),
    stoppedAt: stoppedAt.toISOString(),
    snoozedUntil: null,
    recovery: null,
    timestampFormat,
    look,
    onChange: async () => {},
  });
}

describe("usageLimitRecoveryBannerItem", () => {
  it.each([
    ["12-hour", "Resets 5:30 PM"],
    ["24-hour", "Resets 17:30"],
  ] as const)("formats a same-day reset with the %s setting", (timestampFormat, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerItem(new Date(2026, 9, 20, 17, 30), timestampFormat).description).toBe(expected);
  });

  it("names the day when the reset is tomorrow", () => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(bannerItem(new Date(2026, 9, 21, 17, 30), "24-hour").description).toBe(
      "Resets tomorrow at 17:30",
    );
  });

  it.each([
    ["claudeAgent", "Every account is limited until 5:30 PM"],
    ["codex", "Codex is limited until 5:30 PM"],
    ["replay", "This thread is limited until 5:30 PM"],
  ])("names what %s threads wait for in the tempo look", (provider, expected) => {
    using _now = vi.spyOn(Date, "now").mockReturnValue(stoppedAt.getTime());
    expect(
      bannerItem(new Date(2026, 9, 20, 17, 30), "12-hour", { look: "tempo", provider }).title,
    ).toBe(expected);
  });
});
