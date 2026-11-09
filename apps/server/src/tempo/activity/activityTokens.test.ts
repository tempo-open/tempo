import { UsageDay, type UsageProviderKind, type UsageSourceStatus } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

import * as ServerSettings from "../../serverSettings.ts";
import * as UsageService from "../../usage/UsageService.ts";
import * as ActivityTokens from "./activityTokens.ts";

const ZONE = "America/New_York";

interface Spent {
  readonly day: string;
  readonly provider: UsageProviderKind;
  readonly model: string;
  readonly outputTokens: number;
}

/** A usage scan over `spent`, one bucket per entry, that reports each window it was asked for. */
const fakeUsage = Effect.fn(function* (spent: Array<Spent>) {
  const folder = { status: "ok" as UsageSourceStatus };
  const asked = yield* Queue.unbounded<string>();
  const layer = Layer.mock(UsageService.UsageService)({
    readSummary: ({ timeZone, sinceDay, untilDay }) =>
      Effect.gen(function* () {
        yield* Queue.offer(asked, `${sinceDay}..${untilDay}`);
        const buckets = spent
          .filter(({ day }) => day >= sinceDay && day <= untilDay)
          .toSorted(
            (a, b) =>
              a.day.localeCompare(b.day) ||
              a.provider.localeCompare(b.provider) ||
              a.model.localeCompare(b.model),
          )
          .map(({ day, provider, model, outputTokens }) => ({
            day: UsageDay.make(day),
            provider,
            model,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens,
              reasoningTokens: 0,
            },
            costUsd: 0,
            cacheSavingsUsd: 0,
            costSource: "modelPriced" as const,
            records: 1,
            unpricedRecords: 0,
            sessions: 1,
          }));
        return {
          contractVersion: 1,
          readAt: "2026-11-08T00:00:00.000Z",
          timeZone,
          sinceDay,
          untilDay,
          buckets,
          sources: [
            {
              fingerprint: {
                hostId: "mac",
                provider: "claude" as const,
                resolvedHomePath: "/Users/me/.claude/projects",
                volumeId: "1:2",
              },
              status: folder.status,
              scannedFiles: 1,
              skippedFiles: 0,
              malformedRecords: 0,
              distinctSessions: 1,
              message: null,
            },
          ],
          pricing: { status: "fresh" as const, source: "rates", fetchedAt: null, knownModels: 1 },
          scanDurationMs: 0,
        };
      }),
  });
  const windows = Effect.map(Queue.clear(asked), (taken) => [...taken]);
  return { folder, asked, windows, layer: Layer.merge(layer, ServerSettings.layerTest()) };
});
type FakeUsage = Effect.Success<ReturnType<typeof fakeUsage>>;

const withUsage = <A, E>(
  spent: Array<Spent>,
  test: (
    usage: FakeUsage,
  ) => Effect.Effect<A, E, UsageService.UsageService | ServerSettings.ServerSettingsService>,
) => Effect.flatMap(fakeUsage(spent), (usage) => test(usage).pipe(Effect.provide(usage.layer)));

/** What a read with nothing kept answers, from a fresh service over the same scan. */
const readFresh = (last: string, first: string) =>
  Effect.flatMap(ActivityTokens.make, (fresh) => fresh.read(ZONE, last, Effect.succeed(first)));

describe("ActivityTokens", () => {
  it.effect(
    "asks the usage scan only for the days after those it keeps, and counts as a full read",
    () => {
      const spent: Array<Spent> = [
        { day: "2026-11-01", provider: "claude", model: "claude-opus-5-5", outputTokens: 5 },
        { day: "2026-11-03", provider: "codex", model: "gpt-6.1-sol", outputTokens: 0 },
        { day: "2026-11-05", provider: "claude", model: "claude-opus-5-5", outputTokens: 7 },
        { day: "2026-11-05", provider: "claude", model: "claude-opus-5-5", outputTokens: 2 },
        { day: "2026-11-06", provider: "claude", model: "claude-sonnet-5-5", outputTokens: 3 },
      ];
      return withUsage(spent, (usage) =>
        Effect.gen(function* () {
          const tokens = yield* ActivityTokens.make;
          const first = Effect.succeed("2026-11-01");
          yield* tokens.read(ZONE, "2026-11-06", first);
          spent.push(
            { day: "2026-11-05", provider: "claude", model: "claude-opus-5-5", outputTokens: 1 },
            { day: "2026-11-06", provider: "codex", model: "gpt-6.1-sol", outputTokens: 4 },
          );
          const today = yield* tokens.read(ZONE, "2026-11-06", first);
          const tomorrow = yield* tokens.read(ZONE, "2026-11-07", first);
          assert.deepStrictEqual(yield* usage.windows, [
            "2026-11-01..2026-11-06",
            "2026-11-05..2026-11-06",
            "2026-11-05..2026-11-07",
          ]);

          assert.deepStrictEqual(today, yield* readFresh("2026-11-06", "2026-11-01"));
          assert.deepStrictEqual(tomorrow, yield* readFresh("2026-11-07", "2026-11-01"));
          const { byDay, byModel } = Option.getOrThrow(today);
          assert.deepStrictEqual(Object.fromEntries(byDay), {
            "2026-11-01": 5,
            "2026-11-03": 0,
            "2026-11-05": 10,
            "2026-11-06": 7,
          });
          assert.deepStrictEqual(byModel, [
            { provider: "claude", model: "claude-opus-5-5", outputTokens: 15 },
            { provider: "codex", model: "gpt-6.1-sol", outputTokens: 4 },
            { provider: "claude", model: "claude-sonnet-5-5", outputTokens: 3 },
          ]);
        }),
      );
    },
  );

  it.effect(
    "reads every day again when the settings, a transcript folder or the first day change",
    () => {
      const spent: Array<Spent> = [
        { day: "2026-11-02", provider: "claude", model: "claude-opus-5-5", outputTokens: 9 },
      ];
      return withUsage(spent, (usage) =>
        Effect.gen(function* () {
          const tokens = yield* ActivityTokens.make;
          const settings = yield* ServerSettings.ServerSettingsService;
          const read = (first: string) => tokens.read(ZONE, "2026-11-06", Effect.succeed(first));
          yield* read("2026-11-01");
          yield* read("2026-11-01");
          yield* settings.updateSettings({ usageModelAliases: { "claude-opus-5-5": "opus" } });
          yield* read("2026-11-01");
          usage.folder.status = "partial";
          yield* read("2026-11-01");
          yield* read("2026-10-30");
          assert.deepStrictEqual(yield* usage.windows, [
            "2026-11-01..2026-11-06",
            "2026-11-05..2026-11-06",
            "2026-11-01..2026-11-06",
            "2026-11-05..2026-11-06",
            "2026-11-01..2026-11-06",
            "2026-11-05..2026-11-06",
            "2026-10-30..2026-11-06",
          ]);
        }),
      );
    },
  );

  it.effect("asks for the days after those it keeps before the first thread's day is known", () => {
    return withUsage([], (usage) =>
      Effect.gen(function* () {
        const tokens = yield* ActivityTokens.make;
        yield* tokens.read(ZONE, "2026-11-06", Effect.succeed("2026-11-01"));
        yield* usage.windows;
        const firstDay = yield* Deferred.make<string>();
        const reading = yield* Effect.forkChild(
          tokens.read(ZONE, "2026-11-06", Deferred.await(firstDay)),
        );
        assert.strictEqual(yield* Queue.take(usage.asked), "2026-11-05..2026-11-06");
        yield* Deferred.succeed(firstDay, "2026-11-01");
        assert.isTrue(Option.isSome(yield* Fiber.join(reading)));
        assert.deepStrictEqual(yield* usage.windows, []);
      }),
    );
  });
});
