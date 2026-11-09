import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import { nearProviderCompaction, nearProviderCompactionJson } from "./nearLimitCompaction.ts";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

describe("compaction near the provider's limit", () => {
  it("puts Claude's point 33k below its window, or below Auto-compact after when set", () => {
    // 1M window: Claude compacts at 967,000, so 942,000 is within the 25,000 margin.
    expect(nearProviderCompaction(claude, { usedTokens: 942_000, maxTokens: 1_000_000 })).toBe(
      true,
    );
    expect(nearProviderCompaction(claude, { usedTokens: 941_999, maxTokens: 1_000_000 })).toBe(
      false,
    );
    const configured = { maxTokens: 1_000_000, autoCompactThreshold: 300_000 };
    expect(nearProviderCompaction(claude, { ...configured, usedTokens: 242_000 })).toBe(true);
    expect(nearProviderCompaction(claude, { ...configured, usedTokens: 241_999 })).toBe(false);
    expect(nearProviderCompaction(claude, { usedTokens: 500_000, maxTokens: null })).toBe(false);
  });

  it("puts Codex's point at 90% of the model window it reports as 95%", () => {
    // gpt-5's 272k window is reported as 258,400 and compacts at 244,800.
    expect(nearProviderCompaction(codex, { usedTokens: 219_800, maxTokens: 258_400 })).toBe(true);
    expect(nearProviderCompaction(codex, { usedTokens: 219_799, maxTokens: 258_400 })).toBe(false);
    expect(nearProviderCompaction(codex, { usedTokens: 250_000 })).toBe(false);
  });

  it("skips providers Tempo does not run, even when they report a threshold", () => {
    for (const driver of ["opencode", "pi", "grok", "cursor"]) {
      expect(
        nearProviderCompaction(ProviderDriverKind.make(driver), {
          usedTokens: 199_000,
          maxTokens: 200_000,
          autoCompactThreshold: 150_000,
        }),
      ).toBe(false);
    }
  });

  it("reads a stored usage report and treats anything else as unknown", () => {
    const report = JSON.stringify({
      usedTokens: 230_000,
      maxTokens: 258_400,
      updatedAt: "2026-10-22T12:00:00.000Z",
    });
    expect(nearProviderCompactionJson(codex, report)).toBe(true);
    for (const stored of [null, "not json", JSON.stringify({ maxTokens: 258_400 })]) {
      expect(nearProviderCompactionJson(codex, stored)).toBe(false);
    }
  });
});
