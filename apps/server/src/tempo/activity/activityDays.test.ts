import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

import {
  coveredMsByDay,
  importedTurns,
  localActivityDays,
  localCalendar,
  type ImportedMessage,
} from "./activityDays.ts";

const HOUR = 60 * 60 * 1000;
const newYork = Option.getOrThrow(localCalendar("America/New_York"));
const at = (iso: string) => Date.parse(iso);

const message = (
  ordinal: number,
  role: ImportedMessage["role"],
  iso: string,
  head = "text",
): ImportedMessage => ({ ordinal, role, atMs: at(iso), head });

describe("coveredMsByDay", () => {
  it("splits time at local midnights, whatever length DST gives the day", () => {
    const covered = coveredMsByDay(
      [
        // Daylight time ended at 2:00 on Nov 1 2026, so that day is 25 hours long.
        { startMs: at("2026-10-31T23:00:00-04:00"), endMs: at("2026-11-02T01:00:00-05:00") },
        // It began at 2:00 on Mar 8 2026, a 23 hour day.
        { startMs: at("2026-03-08T00:00:00-05:00"), endMs: at("2026-03-09T00:00:00-04:00") },
      ],
      newYork,
    );
    assert.deepEqual(Object.fromEntries(covered), {
      "2026-03-08": 23 * HOUR,
      "2026-10-31": 1 * HOUR,
      "2026-11-01": 25 * HOUR,
      "2026-11-02": 1 * HOUR,
    });
  });

  it("counts time once while turns overlap", () => {
    const covered = coveredMsByDay(
      [
        { startMs: at("2026-11-03T09:00:00-05:00"), endMs: at("2026-11-03T11:00:00-05:00") },
        { startMs: at("2026-11-03T10:00:00-05:00"), endMs: at("2026-11-03T12:00:00-05:00") },
        { startMs: at("2026-11-03T12:00:00-05:00"), endMs: at("2026-11-03T12:30:00-05:00") },
        { startMs: at("2026-11-03T15:00:00-05:00"), endMs: at("2026-11-03T15:15:00-05:00") },
      ],
      newYork,
    );
    assert.deepEqual(Object.fromEntries(covered), { "2026-11-03": 3.75 * HOUR });
  });
});

describe("importedTurns", () => {
  it("ends a turn at a silence over an hour or an interruption, and skips reopen replies", () => {
    const turns = importedTurns([
      message(1, "user", "2026-11-03T09:00:00Z"),
      message(2, "assistant", "2026-11-03T09:20:00Z"),
      message(3, "assistant", "2026-11-03T10:19:00Z"),
      // 61 minutes of silence: the reply after it starts a turn of its own.
      message(4, "assistant", "2026-11-03T11:20:00Z"),
      message(5, "assistant", "2026-11-03T11:40:00Z"),
      message(6, "user", "2026-11-03T12:00:00Z"),
      message(7, "assistant", "2026-11-03T12:10:00Z"),
      message(8, "user", "2026-11-03T12:15:00Z", "[Request interrupted by user]"),
      message(9, "assistant", "2026-11-03T14:00:00Z", "No response requested."),
      message(10, "user", "2026-11-03T15:00:00Z"),
      message(11, "assistant", "2026-11-03T15:30:00Z"),
    ]);
    assert.deepEqual(
      turns.map(({ startMs, endMs }) => [
        DateTime.formatIso(DateTime.makeUnsafe(startMs)),
        (endMs - startMs) / 60_000,
      ]),
      [
        ["2026-11-03T09:00:00.000Z", 79],
        ["2026-11-03T11:20:00.000Z", 20],
        ["2026-11-03T12:00:00.000Z", 15],
        ["2026-11-03T15:00:00.000Z", 30],
      ],
    );
  });

  it("leaves out a session's first prompt and its replies when the import kept only the end", () => {
    const messages = [
      message(0, "user", "2026-11-01T08:00:00Z"),
      message(1, "assistant", "2026-11-03T09:05:00Z"),
      message(2, "assistant", "2026-11-03T09:30:00Z"),
      ...Array.from({ length: 198 }, (_, index) =>
        message(
          index + 3,
          index % 2 === 0 ? "user" : "assistant",
          DateTime.formatIso(DateTime.makeUnsafe(at("2026-11-03T10:00:00Z") + index * 60_000)),
        ),
      ),
    ];
    const turns = importedTurns(messages);
    assert.equal(turns[0]?.startMs, at("2026-11-03T10:00:00Z"));
    assert.equal(turns.length, 99);
  });
});

describe("localActivityDays", () => {
  it("counts agents only from the day Tempo recorded its first turn", () => {
    const days = localActivityDays(
      {
        threads: [
          { createdAtMs: at("2026-10-30T12:00:00-04:00"), agent: false },
          { createdAtMs: at("2026-11-01T21:00:00-05:00"), agent: false },
          { createdAtMs: at("2026-11-01T21:10:00-05:00"), agent: true },
        ],
        recordedTurns: [
          {
            startedAtMs: at("2026-11-01T21:00:00-05:00"),
            completedAtMs: null,
            running: true,
          },
        ],
        importedSessions: [],
      },
      newYork,
      at("2026-11-02T01:00:00-05:00"),
    );
    assert.deepEqual(days, [
      { day: "2026-10-30", threads: 1, agents: null, workedMs: 0 },
      { day: "2026-10-31", threads: 0, agents: null, workedMs: 0 },
      { day: "2026-11-01", threads: 1, agents: 1, workedMs: 3 * HOUR },
      { day: "2026-11-02", threads: 0, agents: 0, workedMs: 1 * HOUR },
    ]);
  });
});
