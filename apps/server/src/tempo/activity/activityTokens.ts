/**
 * tempo: output tokens per local day and model, for the activity read (TempoActivity.ts). Every usage
 * summary walks every transcript, and the days one read after they had ended are kept, so a later
 * read asks the usage scan only for the days since.
 */
import { UsageDay, type TempoActivityModelTokens, type UsageSummary } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../../serverSettings.ts";
import * as UsageService from "../../usage/UsageService.ts";
import { addDays, type Day } from "./activityDays.ts";

/**
 * Token days stay four days inside the usage cache's retention: the scan reads files changed up to
 * 36 hours before its first day, and a file older than the retention would be read on every call.
 */
const TOKEN_DAYS = UsageService.CACHE_RETENTION_DAYS - 4;
/** A day is kept once it ended a whole day before a read, past turns that ran over midnight. */
const FINISHED_AFTER_DAYS = 2;

export interface ActivityTokens {
  /** The window's first day; earlier days have no tokens. */
  readonly sinceDay: Day;
  readonly byDay: ReadonlyMap<Day, number>;
  /** Over every day of the window, largest first. */
  readonly byModel: ReadonlyArray<TempoActivityModelTokens>;
}

/** One zone's days `from` through `through`, as read under these settings and transcript folders. */
interface KeptDays {
  readonly settings: string;
  readonly sources: string;
  readonly from: Day;
  readonly through: Day;
  /** Each day's models in the summary's order, with no entry for a day without tokens. */
  readonly days: ReadonlyMap<Day, ReadonlyArray<TempoActivityModelTokens>>;
}

const latest = (a: Day, b: Day) => (a > b ? a : b);
const encodeKey = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** A transcript folder that appears, moves or reads only in part can change days already kept. */
const sourcesOf = (summary: UsageSummary) =>
  encodeKey(summary.sources.map(({ fingerprint, status }) => [fingerprint, status]));

function modelsByDay(summary: UsageSummary): Map<Day, ReadonlyArray<TempoActivityModelTokens>> {
  const days = new Map<Day, Map<string, TempoActivityModelTokens>>();
  for (const { day, provider, model, totals } of summary.buckets) {
    const models = days.get(day) ?? new Map<string, TempoActivityModelTokens>();
    const key = `${provider} ${model}`;
    const outputTokens = (models.get(key)?.outputTokens ?? 0) + totals.outputTokens;
    days.set(day, models.set(key, { provider, model, outputTokens }));
  }
  return new Map([...days].map(([day, models]) => [day, [...models.values()]]));
}

export const make = Effect.gen(function* () {
  const usage = yield* UsageService.UsageService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const keptByZone = new Map<string, KeptDays>();

  const summary = (timeZone: string, sinceDay: Day, untilDay: Day) =>
    usage.readSummary({
      timeZone,
      sinceDay: UsageDay.make(sinceDay),
      untilDay: UsageDay.make(untilDay),
    });

  /**
   * Each day's tokens from the window's first day through `last`, today in `timeZone`. With days
   * kept, the summary of the days after them runs while `firstDay` resolves.
   */
  const read = Effect.fn("TempoActivity.readTokens")(
    function* <E>(timeZone: string, last: Day, firstDay: Effect.Effect<Day, E>) {
      const windowStart = addDays(last, 1 - TOKEN_DAYS);
      const settings = encodeKey(yield* serverSettings.getSettings);
      const previous = keptByZone.get(timeZone);
      const kept = previous?.settings === settings ? previous : undefined;
      const afterKept = kept === undefined ? null : latest(addDays(kept.through, 1), windowStart);
      const [first, sinceKept] = yield* Effect.all(
        [firstDay, afterKept === null ? Effect.succeed(null) : summary(timeZone, afterKept, last)],
        { concurrency: 2 },
      );
      const sinceDay = latest(windowStart, first);
      const usable =
        kept !== undefined &&
        afterKept !== null &&
        sinceKept !== null &&
        kept.from <= sinceDay &&
        kept.sources === sourcesOf(sinceKept);
      const readFrom = usable ? afterKept : sinceDay;
      const answer = usable ? sinceKept : yield* summary(timeZone, sinceDay, last);

      const days = new Map<Day, ReadonlyArray<TempoActivityModelTokens>>();
      if (usable) {
        for (const [day, models] of kept.days) {
          if (day >= sinceDay && day < readFrom) days.set(day, models);
        }
      }
      for (const [day, models] of modelsByDay(answer)) {
        if (day >= sinceDay) days.set(day, models);
      }

      const finished = addDays(last, -FINISHED_AFTER_DAYS);
      const through =
        finished >= readFrom ? finished : usable ? kept.through : addDays(sinceDay, -1);
      keptByZone.set(timeZone, {
        settings,
        sources: sourcesOf(answer),
        from: sinceDay,
        through,
        days: new Map([...days].filter(([day]) => day <= through)),
      });

      const byDay = new Map<Day, number>();
      const byModel = new Map<string, TempoActivityModelTokens>();
      for (const [day, models] of days) {
        for (const { provider, model, outputTokens } of models) {
          byDay.set(day, (byDay.get(day) ?? 0) + outputTokens);
          const key = `${provider} ${model}`;
          const total = (byModel.get(key)?.outputTokens ?? 0) + outputTokens;
          byModel.set(key, { provider, model, outputTokens: total });
        }
      }
      return {
        sinceDay,
        byDay,
        byModel: [...byModel.values()].toSorted((a, b) => b.outputTokens - a.outputTokens),
      } satisfies ActivityTokens;
    },
    Effect.tapError((error) => Effect.logWarning("could not read output tokens", { error })),
    Effect.option,
  );

  return { read };
});
