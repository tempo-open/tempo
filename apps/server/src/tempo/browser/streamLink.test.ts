import { expect, it } from "@effect/vitest";

import { STREAM_LEVELS, StreamLink } from "./streamLink.ts";

/** A frame of `bytes` at `level` over a link of `mbps` and `rttMs`, sent at `at`. */
const deliver = (
  link: StreamLink,
  input: { at: number; bytes: number; mbps: number; rttMs: number; level?: number },
) => {
  const transferMs = (input.bytes * 8) / (input.mbps * 1000);
  link.record({
    bytes: input.bytes,
    level: input.level ?? link.level,
    sentAt: input.at,
    ackedAt: input.at + input.rttMs + transferMs,
    transferMs,
  });
};

/** What a dense page's frame weighs at each level: 356 KB at the sharpest. */
const frameBytes = (level: number) => Math.round(356_000 * STREAM_LEVELS[level]!.bytes);

it("keeps the stream a viewer always had when its acks carry no timing", () => {
  const link = new StreamLink();
  link.record({ bytes: 356_000, level: 0, sentAt: 0, ackedAt: 900, transferMs: undefined });
  expect(link.measured).toBe(false);
  expect(link.level).toBe(0);
  expect(link.window).toBe(1);
  expect(link.frameIntervalMs).toBe(33);
});

it("sends full-scale frames on a LAN, one at a time and up to 60 a second", () => {
  const link = new StreamLink();
  for (let frame = 0; frame < 10; frame++)
    deliver(link, { at: frame * 20, bytes: frameBytes(0), mbps: 500, rttMs: 2 });
  expect(link.level).toBe(0);
  expect(link.window).toBe(1);
  expect(link.frameIntervalMs).toBe(16);
});

it("shrinks frames on a tunnel until one arrives within the budget, and keeps the link busy", () => {
  const link = new StreamLink();
  deliver(link, { at: 0, bytes: frameBytes(0), mbps: 40, rttMs: 40 });
  // 356 KB takes 71 ms at 40 Mbps; the first level that fits 33 ms is half scale.
  expect(link.level).toBe(3);
  const transferMs = (frameBytes(3) * 8) / 40_000;
  expect(link.frameIntervalMs).toBeCloseTo(transferMs, 0);
  // Three frames cover a 40 ms round trip of 19 ms transfers.
  expect(link.window).toBe(3);
});

it("keeps a fast link sharp when a busy viewer reports some frames late", () => {
  const link = new StreamLink();
  for (let frame = 0; frame < 30; frame++) {
    const transferMs = frame % 3 === 2 ? 60 : 8; // every third frame waits behind other work
    link.record({
      bytes: frameBytes(0),
      level: 0,
      sentAt: frame * 50,
      ackedAt: frame * 50 + 2 + transferMs,
      transferMs,
    });
  }
  expect(link.level).toBe(0);
});

it("goes no lower than the smallest level on a link too slow for any", () => {
  const link = new StreamLink();
  for (let frame = 0; frame < 4; frame++)
    deliver(link, { at: frame * 600, bytes: frameBytes(link.level), mbps: 5, rttMs: 80 });
  expect(link.level).toBe(STREAM_LEVELS.length - 1);
});

it("moves to sharper frames only after the dwell and with room to spare", () => {
  const link = new StreamLink();
  deliver(link, { at: 0, bytes: frameBytes(0), mbps: 40, rttMs: 40 });
  expect(link.level).toBe(3);
  // The link speeds up at once, but the level holds until the dwell passes.
  deliver(link, { at: 100, bytes: frameBytes(3), mbps: 400, rttMs: 40 });
  expect(link.level).toBe(3);
  for (let frame = 0; frame < 10; frame++)
    deliver(link, { at: 600 + frame * 30, bytes: frameBytes(link.level), mbps: 400, rttMs: 40 });
  expect(link.level).toBe(0);
});

it("counts a full-scale still toward the page's frame size, not the live level's", () => {
  const link = new StreamLink();
  deliver(link, { at: 0, bytes: frameBytes(0), mbps: 40, rttMs: 40 });
  expect(link.level).toBe(3);
  // A sharp still after the page settles is as heavy as a level 0 frame, which is
  // what the estimate for level 3 already assumes, so the level holds.
  deliver(link, { at: 700, bytes: frameBytes(0), mbps: 40, rttMs: 40, level: 0 });
  expect(link.level).toBe(3);
});
