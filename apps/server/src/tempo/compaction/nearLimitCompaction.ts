/**
 * tempo: compact before the provider does. Claude Code and Codex compact when the context reaches a
 * limit, checked before each model request, so a turn ending near it makes the next message wait
 * through a compaction mid-answer. orchestration-v2/IdleCompaction.ts runs that compaction as soon
 * as such a turn completes, while nobody waits on the thread.
 */
import type { ProviderDriverKind } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/**
 * How close to its provider's compaction point a turn must leave a thread: about one
 * turn of growth. The median turn adds about 8k
 * tokens on Claude and 14k to 21k on Codex, and all 340 automatic compactions started
 * partway into a turn, none before its first request.
 */
const NEAR_LIMIT_MARGIN_TOKENS = 25_000;

/**
 * Claude Code compacts at its auto-compact window (the Auto-compact after setting,
 * else the model's context window) less 20k tokens kept for the summary and a 13k
 * buffer: automatic compactions on a 1M window start between about
 * 966,984 and 970,272 tokens.
 */
const CLAUDE_COMPACTION_RESERVE_TOKENS = 33_000;

const ContextUsage = Schema.Struct({
  usedTokens: Schema.Number,
  maxTokens: Schema.optional(Schema.NullOr(Schema.Number)),
  autoCompactThreshold: Schema.optional(Schema.Number),
});
type ContextUsage = typeof ContextUsage.Type;
const decodeContextUsageJson = Schema.decodeUnknownOption(Schema.fromJsonString(ContextUsage));

function providerCompactionPoint(driver: ProviderDriverKind, usage: ContextUsage): number | null {
  const window = usage.maxTokens ?? null;
  if (driver === "claudeAgent") {
    // The adapter reports the setting only while it is below the model's window.
    const compactionWindow = usage.autoCompactThreshold ?? window;
    return compactionWindow === null ? null : compactionWindow - CLAUDE_COMPACTION_RESERVE_TOKENS;
  }
  // Codex reports 95% of the model's window and compacts at 90% of it, or earlier when
  // the model's metadata sets a lower limit, which Codex does not report (codex-rs ModelInfo).
  if (driver === "codex") return window === null ? null : Math.floor((window * 90) / 95);
  // Tempo runs only Claude and Codex, and no other adapter reports where it compacts.
  return null;
}

/** Whether the thread's next turn would likely reach the point where its provider compacts. */
export function nearProviderCompaction(
  driver: ProviderDriverKind,
  usage: ContextUsage | null | undefined,
): boolean {
  if (usage == null) return false;
  const point = providerCompactionPoint(driver, usage);
  return point !== null && usage.usedTokens >= point - NEAR_LIMIT_MARGIN_TOKENS;
}

/** The same check for a usage report read from the database as JSON. */
export function nearProviderCompactionJson(
  driver: ProviderDriverKind,
  usageJson: string | null,
): boolean {
  return (
    usageJson !== null &&
    nearProviderCompaction(driver, Option.getOrUndefined(decodeContextUsageJson(usageJson)))
  );
}
