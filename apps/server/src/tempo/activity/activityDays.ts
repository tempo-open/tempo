/**
 * tempo: the pure part of the activity read (tempoActivity.ts): local days, agent turns and their union.
 * Tempo records its own turns. A Claude Code session imported into Tempo kept only its text
 * messages, so its turns are rebuilt from their times.
 */
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** A calendar day, `YYYY-MM-DD`. */
export type Day = string;

export interface Interval {
  readonly startMs: number;
  readonly endMs: number;
}

/** The days of one IANA time zone, with their midnights. */
export interface LocalCalendar {
  readonly dayOf: (ms: number) => Day;
  /** The epoch milliseconds of the day's first moment, which is midnight where DST allows. */
  readonly startOf: (day: Day) => number;
}

export function localCalendar(timeZone: string): Option.Option<LocalCalendar> {
  return Option.map(DateTime.zoneMakeNamed(timeZone), (zone) => ({
    dayOf: (ms) => DateTime.formatIsoDate(DateTime.makeZonedUnsafe(ms, { timeZone: zone })),
    startOf: (day) =>
      DateTime.toEpochMillis(
        DateTime.makeZonedUnsafe(`${day}T00:00:00Z`, { timeZone: zone, adjustForTimeZone: true }),
      ),
  }));
}

export function addDays(day: Day, days: number): Day {
  return DateTime.formatIsoDate(DateTime.add(DateTime.makeUnsafe(`${day}T00:00:00Z`), { days }));
}

/** Every day from `first` through `last`. */
export function daysThrough(first: Day, last: Day): Array<Day> {
  const days: Array<Day> = [];
  for (let day = first; day <= last; day = addDays(day, 1)) days.push(day);
  return days;
}

/** The time covered by at least one interval, as disjoint intervals in order. */
function unionIntervals(intervals: Iterable<Interval>): Array<Interval> {
  const sorted = [...intervals]
    .filter((interval) => interval.endMs > interval.startMs)
    .toSorted((a, b) => a.startMs - b.startMs);
  const union: Array<Interval> = [];
  for (const interval of sorted) {
    const last = union.at(-1);
    if (last !== undefined && interval.startMs <= last.endMs) {
      union[union.length - 1] = {
        startMs: last.startMs,
        endMs: Math.max(last.endMs, interval.endMs),
      };
    } else {
      union.push(interval);
    }
  }
  return union;
}

/** How much of each local day the intervals cover; overlapping intervals count once per moment. */
export function coveredMsByDay(
  intervals: Iterable<Interval>,
  calendar: LocalCalendar,
): Map<Day, number> {
  const covered = new Map<Day, number>();
  for (const { startMs, endMs } of unionIntervals(intervals)) {
    for (let day = calendar.dayOf(startMs); ; day = addDays(day, 1)) {
      const dayEndMs = calendar.startOf(addDays(day, 1));
      const ms = Math.min(endMs, dayEndMs) - Math.max(startMs, calendar.startOf(day));
      if (ms > 0) covered.set(day, (covered.get(day) ?? 0) + ms);
      if (dayEndMs >= endMs) break;
    }
  }
  return covered;
}

/** A turn Tempo ran (a `root_turn` node), in a top level or an agent thread. */
export interface RecordedTurn {
  readonly startedAtMs: number;
  readonly completedAtMs: number | null;
  readonly running: boolean;
}

/** Running turns last until now; a turn that ended without an end time is left out. */
function recordedTurnInterval(turn: RecordedTurn, nowMs: number): Interval | null {
  if (turn.startedAtMs > nowMs) return null;
  const endMs = turn.completedAtMs ?? (turn.running ? nowMs : null);
  return endMs === null ? null : { startMs: turn.startedAtMs, endMs: Math.min(endMs, nowMs) };
}

/** A text message of an imported Claude Code session, in import order. */
export interface ImportedMessage {
  readonly ordinal: number;
  readonly role: "user" | "assistant";
  readonly atMs: number;
  /** The message's first characters, enough to recognize the markers below. */
  readonly head: string;
}

/** Tempo imports a session's first prompt and its last 199 text messages (AgentSessionScanner). */
const IMPORTED_MESSAGE_LIMIT = 200;
/** An imported session's silence longer than this ends its turn. */
const IMPORTED_TURN_GAP_MS = 60 * 60 * 1000;
const INTERRUPTED = "[Request interrupted by user";
/** Claude Code writes this when a session reopens; it is not work. */
const REOPENED = "No response requested.";

/**
 * One imported session's turns: from a prompt to the last reply before the next prompt, an
 * interruption, or a silence over `gapMs`, after which a reply starts a turn. A session at the
 * import limit lost the messages after its first prompt, so its turns start at the next kept one.
 */
export function importedTurns(
  messages: ReadonlyArray<ImportedMessage>,
  gapMs: number = IMPORTED_TURN_GAP_MS,
): Array<Interval> {
  let kept = messages.toSorted((a, b) => a.ordinal - b.ordinal);
  if (kept.length >= IMPORTED_MESSAGE_LIMIT) {
    kept = kept.slice(1);
    const nextPrompt = kept.findIndex((message) => message.role === "user");
    kept = nextPrompt === -1 ? [] : kept.slice(nextPrompt);
  }
  const turns: Array<Interval> = [];
  let open: { startMs: number; endMs: number } | null = null;
  const close = () => {
    if (open !== null && open.endMs > open.startMs) turns.push({ ...open });
    open = null;
  };
  for (const message of kept.toSorted((a, b) => a.atMs - b.atMs || a.ordinal - b.ordinal)) {
    const { atMs } = message;
    if (message.role === "assistant") {
      if (message.head.startsWith(REOPENED)) continue;
      if (open !== null && atMs - open.endMs > gapMs) close();
      if (open === null) open = { startMs: atMs, endMs: atMs };
      else open.endMs = Math.max(open.endMs, atMs);
    } else if (message.head.startsWith(INTERRUPTED)) {
      if (open !== null && atMs - open.endMs <= gapMs) open.endMs = Math.max(open.endMs, atMs);
      close();
    } else {
      close();
      open = { startMs: atMs, endMs: atMs };
    }
  }
  close();
  return turns;
}

export interface LocalActivityRows {
  /** Threads not deleted; `agent` marks a child thread an agent started. */
  readonly threads: ReadonlyArray<{ readonly createdAtMs: number; readonly agent: boolean }>;
  readonly recordedTurns: ReadonlyArray<RecordedTurn>;
  /** Imported sessions' text messages, by thread. */
  readonly importedSessions: ReadonlyArray<ReadonlyArray<ImportedMessage>>;
}

export interface LocalActivityDay {
  readonly day: Day;
  readonly threads: number;
  readonly agents: number | null;
  readonly workedMs: number;
}

/**
 * Threads, agents and worked time per local day, from the first thread's day through today.
 * Agents count from the day of Tempo's first recorded turn, when it began recording child threads.
 */
export function localActivityDays(
  rows: LocalActivityRows,
  calendar: LocalCalendar,
  nowMs: number,
): Array<LocalActivityDay> {
  const threads = new Map<Day, number>();
  const agents = new Map<Day, number>();
  let firstThreadMs = nowMs;
  for (const { createdAtMs, agent } of rows.threads) {
    if (createdAtMs > nowMs) continue;
    const counts = agent ? agents : threads;
    const day = calendar.dayOf(createdAtMs);
    counts.set(day, (counts.get(day) ?? 0) + 1);
    if (!agent) firstThreadMs = Math.min(firstThreadMs, createdAtMs);
  }
  const recorded: Array<Interval> = [];
  let firstRecordedMs: number | null = null;
  for (const turn of rows.recordedTurns) {
    if (turn.startedAtMs > nowMs) continue;
    firstRecordedMs = Math.min(firstRecordedMs ?? turn.startedAtMs, turn.startedAtMs);
    const interval = recordedTurnInterval(turn, nowMs);
    if (interval !== null) recorded.push(interval);
  }
  const agentsSince = firstRecordedMs === null ? null : calendar.dayOf(firstRecordedMs);
  const imported = rows.importedSessions.flatMap((messages) =>
    importedTurns(messages).flatMap(({ startMs, endMs }) =>
      startMs > nowMs ? [] : [{ startMs, endMs: Math.min(endMs, nowMs) }],
    ),
  );
  const worked = coveredMsByDay([...recorded, ...imported], calendar);
  return daysThrough(calendar.dayOf(firstThreadMs), calendar.dayOf(nowMs)).map((day) => ({
    day,
    threads: threads.get(day) ?? 0,
    agents: agentsSince !== null && day >= agentsSince ? (agents.get(day) ?? 0) : null,
    workedMs: worked.get(day) ?? 0,
  }));
}
