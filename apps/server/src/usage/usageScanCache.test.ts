import { describe, expect, it } from "@effect/vitest";

import {
  decodeScanCache,
  foldScanCache,
  makeScanCacheWriter,
  type CachedFile,
  type ScanCache,
} from "./usageScanCache.ts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

import { TEST_FORMAT_MAP } from "./usageTestFormats.ts";
import { initialCodexScanState, parseCodexLine } from "../provider/Drivers/codexUsage.ts";

function record(overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: 1_786_000_000_000,
    model: "claude-fable-5",
    sessionId: "session-a",
    totals: {
      uncachedInputTokens: 2,
      cachedInputTokens: 1000,
      cacheCreationTokens: 10,
      outputTokens: 50,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: "msg_1:",
    ...overrides,
  };
}

function position(overrides: Partial<CachedFile["position"]> = {}): CachedFile["position"] {
  return {
    resumeOffset: 120,
    guardLength: 64,
    guardHash: 0xdeadbeef,
    state: null,
    ...overrides,
  };
}

function cacheWith(entries: readonly [string, number, readonly UsageRecord[]][]): ScanCache {
  const cache: ScanCache = new Map();
  for (const [path, mtimeMs, records] of entries) {
    cache.set(path, {
      size: records.length * 10,
      mtimeMs,
      provider: "claude",
      records,
      tailRecords: [],
      malformedRecords: 0,
      position: position(),
    });
  }
  return cache;
}

describe("scan cache round trip", () => {
  it("restores cached history unchanged except for Claude local placeholders", () => {
    const original = cacheWith([
      [
        "/a.jsonl",
        100,
        [record(), record({ dedupeKey: "msg_2:", model: "claude-opus-5-5", speed: "fast" })],
      ],
      [
        "/b.jsonl",
        200,
        [
          record({
            sessionId: "session-b",
            reportedCostUsd: 1.5,
            totals: {
              uncachedInputTokens: 0,
              cachedInputTokens: 0,
              cacheCreationTokens: 0,
              outputTokens: 0,
              reasoningTokens: 0,
            },
          }),
        ],
      ],
    ]);
    original.set("/grok.jsonl", {
      size: 40,
      malformedRecords: 2,
      mtimeMs: 300,
      provider: "grok",
      records: [
        record({ provider: "grok", model: "grok-4.5-build", dedupeKey: "s:p:grok-4.5-build" }),
        record({ provider: "grok", model: "<synthetic>", dedupeKey: "s:p:<synthetic>" }),
      ],
      tailRecords: [record({ provider: "grok", model: "<synthetic>", dedupeKey: null })],
      position: position({ resumeOffset: 30, guardLength: 30, guardHash: 123 }),
    });
    const state = initialCodexScanState();
    for (const line of [
      { type: "session_meta", payload: { id: "session-c", model_provider: "openai" } },
      { type: "turn_context", payload: { model: "gpt-6-astra", turn_id: "native-turn" } },
      {
        type: "event_msg",
        timestamp: "2026-08-01T10:00:00Z",
        payload: {
          type: "token_count",
          info: { last_token_usage: { input_tokens: 1, output_tokens: 2 } },
        },
      },
    ])
      parseCodexLine(JSON.stringify(line), state);
    const pending = {
      ...record({
        provider: "codex",
        model: "gpt-6-astra",
        sessionId: "session-c",
        dedupeKey: null,
      }),
      unresolvedServiceTierTurnId: "native-turn",
    };
    const pendingTail = { ...pending, unresolvedServiceTierTurnId: "native-tail" };
    original.set("/codex.jsonl", {
      size: 80,
      malformedRecords: 3,
      mtimeMs: 400,
      provider: "codex",
      records: [
        record({
          provider: "codex",
          model: "gpt-6-astra",
          rateModel: "gpt-6",
          dedupeKey: null,
          speed: "ultrafast",
        }),
        pending,
      ],
      tailRecords: [pendingTail],
      position: position({ state }),
    });

    original.set("/a.jsonl", {
      ...original.get("/a.jsonl")!,
      tailRecords: [record({ dedupeKey: "msg_tail:" })],
    });
    const claude = original.get("/a.jsonl")!;
    const cached = new Map(original);
    cached.set("/a.jsonl", {
      ...claude,
      records: [...claude.records, record({ model: "<synthetic>" })],
      tailRecords: [
        ...claude.tailRecords,
        record({ model: "<synthetic>", dedupeKey: "msg_tail:" }),
      ],
    });
    const restored = decodeScanCache(
      JSON.parse(makeScanCacheWriter()(cached, {})),
      TEST_FORMAT_MAP,
    );

    expect(restored.size).toBe(4);
    expect(restored).toEqual(original);
  });

  it.each([5, 6, 7, 8])(
    "retains v%s history and compatible positions but invalidates obsolete state",
    (version) => {
      const original = cacheWith([["/gone.jsonl", 100, [record({ speed: "fast" })]]]);
      original.set("/gone-codex.jsonl", {
        ...original.get("/gone.jsonl")!,
        provider: "codex",
        malformedRecords: 1,
        records: [record({ provider: "codex", speed: "fast", dedupeKey: null })],
        position: position({
          state: {
            ...(version >= 6 ? initialCodexScanState() : {}),
            model: "gpt-6-astra",
            speed: "fast",
            sessionId: "session-a",
            lastUsageSignature: null,
            sawSessionMeta: true,
            suppressingForkCopies: false,
            forkCopyAnchorMs: 0,
          },
        }),
      });
      original.set("/gone-pi.jsonl", {
        ...original.get("/gone.jsonl")!,
        size: 256,
        provider: "pi",
        records: [record({ provider: "pi", model: "anthropic/claude-fable-5" })],
        malformedRecords: 3,
        position: position({ state: { sessionId: "session-a" } }),
      });
      const cleanCodex = {
        ...original.get("/gone-codex.jsonl")!,
        malformedRecords: 0,
      };
      original.set("/clean-codex.jsonl", cleanCodex);
      const encoded = JSON.parse(makeScanCacheWriter()(original, {}));
      const entry = encoded.files["/gone.jsonl"]!;
      const legacy = {
        ...encoded,
        version,
        files: {
          ...encoded.files,
          "/gone.jsonl": {
            s: entry.s,
            m: entry.m,
            p: entry.p,
            r: entry.r,
            t: entry.t,
            o: entry.o,
            gl: entry.gl,
            gh: entry.gh,
            cs: entry.cs,
          },
        },
      };

      const restored = decodeScanCache(JSON.parse(JSON.stringify(legacy)), TEST_FORMAT_MAP);
      expect(restored.get("/gone.jsonl")).toEqual(original.get("/gone.jsonl"));
      expect(restored.get("/gone-codex.jsonl")).toEqual({
        ...original.get("/gone-codex.jsonl"),
        size: -1,
        position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
      });
      expect(restored.get("/clean-codex.jsonl")).toEqual(
        version >= 8
          ? cleanCodex
          : {
              ...cleanCodex,
              size: -1,
              position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
            },
      );
      expect(restored.get("/gone-pi.jsonl")).toEqual(
        version >= 6
          ? original.get("/gone-pi.jsonl")
          : {
              ...original.get("/gone-pi.jsonl"),
              size: -1,
              position: { resumeOffset: 0, guardLength: 0, guardHash: 0, state: null },
            },
      );
    },
  );

  it("rewrites only changed entries and still restores the whole cache", () => {
    const write = makeScanCacheWriter();
    const cache = cacheWith([
      ["/a.jsonl", 100, [record()]],
      ["/b.jsonl", 200, [record({ sessionId: "session-b" })]],
    ]);
    cache.set("/b.jsonl", { ...cache.get("/b.jsonl")!, malformedRecords: 2 });
    const sources = { "claude\u0000/projects": { dir: "/projects", volumeId: "1:2" } };
    expect(decodeScanCache(JSON.parse(write(cache, { sources })), TEST_FORMAT_MAP)).toEqual(cache);

    cache.set("/b.jsonl", {
      ...cache.get("/b.jsonl")!,
      size: 30,
      malformedRecords: 4,
      records: [record({ sessionId: "session-c", model: "claude-opus-5-5", dedupeKey: "msg_3:" })],
    });
    const document = JSON.parse(write(cache, { sources }));
    expect(decodeScanCache(document, TEST_FORMAT_MAP)).toEqual(cache);
    expect(document.sources).toEqual(sources);
  });

  it("keeps only the size, mtime and position of the oldest files in a saved copy that would pass its length cap", () => {
    const cache = cacheWith([
      ["/a.jsonl", 300, [record()]],
      ["/b.jsonl", 100, [record({ dedupeKey: "msg_2:" })]],
      ["/c.jsonl", 200, [record({ dedupeKey: "msg_3:" })]],
    ]);
    const full = makeScanCacheWriter()(cache, {});
    const expected = makeScanCacheWriter()(
      new Map(cache).set("/b.jsonl", { ...cache.get("/b.jsonl")!, records: [] }),
      {},
    );

    expect(makeScanCacheWriter(full.length)(cache, {})).toBe(full);
    expect(makeScanCacheWriter(full.length - 1)(cache, {})).toBe(expected);
    expect(makeScanCacheWriter(expected.length)(cache, {})).toBe(expected);
  });

  it("treats a corrupt or foreign document as an empty cache", () => {
    expect(decodeScanCache(null, TEST_FORMAT_MAP).size).toBe(0);
    expect(decodeScanCache("nonsense", TEST_FORMAT_MAP).size).toBe(0);
    expect(
      decodeScanCache({ version: 999, models: [], sessions: [], files: {} }, TEST_FORMAT_MAP).size,
    ).toBe(0);
  });

  it("skips malformed file entries but keeps good ones", () => {
    const encoded = JSON.parse(
      makeScanCacheWriter()(cacheWith([["/good.jsonl", 100, [record()]]]), {}),
    );
    const withJunk = {
      ...encoded,
      files: { ...encoded.files, "/bad.jsonl": { s: "nope", m: 1, p: "claude", r: [] } },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(withJunk)), TEST_FORMAT_MAP);
    expect([...restored.keys()]).toEqual(["/good.jsonl"]);
  });

  it("drops the whole entry when any row is corrupt, forcing a cold re-parse", () => {
    const encoded = JSON.parse(
      makeScanCacheWriter()(
        cacheWith([["/a.jsonl", 100, [record(), record({ dedupeKey: "msg_2:" })]]]),
        {},
      ),
    );
    const rows = encoded.files["/a.jsonl"]!.r;
    const poisoned = {
      ...encoded,
      files: {
        "/a.jsonl": {
          ...encoded.files["/a.jsonl"]!,
          r: [rows[0]!, [...rows[1]!.slice(0, 3), "not-a-number", ...rows[1]!.slice(4)]],
        },
      },
    };

    const restored = decodeScanCache(JSON.parse(JSON.stringify(poisoned)), TEST_FORMAT_MAP);
    expect(restored.has("/a.jsonl")).toBe(false);
  });
});

describe("folding old files", () => {
  const QUARTER_HOUR_MS = 15 * 60 * 1000;
  const slot = Math.floor(record().timestampMs / QUARTER_HOUR_MS) * QUARTER_HOUR_MS;
  const totals = (outputTokens: number) => ({
    uncachedInputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens,
    reasoningTokens: 0,
  });

  it("keeps one record per quarter hour, session, model and speed, and drops copies held elsewhere", () => {
    const at = (minutes: number) => slot + minutes * 60_000;
    const cache = cacheWith([
      [
        "/old.jsonl",
        100,
        [
          record({ timestampMs: at(1), totals: totals(10) }),
          record({ timestampMs: at(14), dedupeKey: "msg_2:", totals: totals(20) }),
          record({ timestampMs: at(15), dedupeKey: "msg_3:", totals: totals(40) }),
          record({ timestampMs: at(2), dedupeKey: "msg_4:", speed: "fast", totals: totals(50) }),
          record({ timestampMs: at(2), dedupeKey: "msg_6:", sessionId: "b", totals: totals(60) }),
          record({ timestampMs: at(2), dedupeKey: "msg_7:", model: "opus", totals: totals(70) }),
          record({ timestampMs: at(3), dedupeKey: "msg_5:", reportedCostUsd: 0.25 }),
          record({ timestampMs: at(4), dedupeKey: "msg_held:" }),
        ],
      ],
      ["/new.jsonl", 5000, [record({ timestampMs: at(4), dedupeKey: "msg_held:" })]],
    ]);
    const codexEvent = (minutes: number, outputTokens: number) =>
      record({
        provider: "codex",
        model: "gpt-6-astra",
        sessionId: "session-c",
        timestampMs: at(minutes),
        totals: totals(outputTokens),
        dedupeKey: null,
      });
    for (const [path, records] of [
      ["/codex.jsonl", [codexEvent(1, 5), codexEvent(1, 5)]],
      ["/codex-fork.jsonl", [codexEvent(1, 5), codexEvent(2, 7)]],
    ] as const) {
      cache.set(path, { ...cache.get("/old.jsonl")!, provider: "codex", records });
    }
    const newer = cache.get("/new.jsonl");

    expect(foldScanCache(cache, 1000, new Set(["codex"]))).toBe(3);

    const folded = (outputTokens: number, overrides: Partial<UsageRecord> = {}) =>
      record({ timestampMs: slot, totals: totals(outputTokens), dedupeKey: null, ...overrides });
    expect(cache.get("/old.jsonl")).toMatchObject({
      folded: true,
      records: [
        folded(30),
        folded(40, { timestampMs: slot + QUARTER_HOUR_MS }),
        folded(50, { speed: "fast" }),
        folded(60, { sessionId: "b" }),
        folded(70, { model: "opus" }),
        record({ timestampMs: at(3), dedupeKey: "msg_5:", reportedCostUsd: 0.25 }),
      ],
    });
    expect(cache.get("/new.jsonl")).toBe(newer);
    const codexFolded = (outputTokens: number) =>
      folded(outputTokens, { provider: "codex", model: "gpt-6-astra", sessionId: "session-c" });
    expect(cache.get("/codex.jsonl")?.records).toEqual([codexFolded(10)]);
    expect(cache.get("/codex-fork.jsonl")?.records).toEqual([codexFolded(7)]);

    expect(foldScanCache(cache, 1000, new Set(["codex"]))).toBe(0);
    expect(decodeScanCache(JSON.parse(makeScanCacheWriter()(cache, {})), TEST_FORMAT_MAP)).toEqual(
      cache,
    );
  });

  it("never counts twice the copies of a file that a capped save left out", () => {
    const onDisk = cacheWith([
      [
        "/a.jsonl",
        100,
        [
          record({ dedupeKey: "x", totals: totals(10) }),
          record({ dedupeKey: "y", totals: totals(5) }),
        ],
      ],
      ["/b.jsonl", 200, [record({ dedupeKey: "x", totals: totals(10) })]],
      ["/c.jsonl", 5000, [record({ dedupeKey: "z", totals: totals(1) })]],
    ]);
    const outputTokens = (cache: ScanCache) => {
      const seen = new Set<string>();
      let sum = 0;
      for (const { records } of cache.values()) {
        for (const { dedupeKey, totals } of records) {
          if (dedupeKey !== null && seen.has(dedupeKey)) continue;
          if (dedupeKey !== null) seen.add(dedupeKey);
          sum += totals.outputTokens;
        }
      }
      return sum;
    };
    // A scan reuses a saved entry whose size, mtime and provider match the file and reads the rest.
    const scanAgain = (saved: ScanCache): ScanCache =>
      new Map(
        [...onDisk].map(([path, file]) => {
          const entry = saved.get(path);
          const unchanged =
            entry?.size === file.size &&
            entry.mtimeMs === file.mtimeMs &&
            entry.provider === file.provider;
          return [path, unchanged ? entry : file];
        }),
      );
    const folded: ScanCache = new Map(onDisk);
    foldScanCache(folded, 150, new Set());
    foldScanCache(folded, 1000, new Set());
    expect(outputTokens(folded)).toBe(16);
    const cap = makeScanCacheWriter()(
      new Map(folded).set("/a.jsonl", { ...folded.get("/a.jsonl")!, records: [] }),
      {},
    ).length;
    const saveCappedAndScan = (cache: ScanCache) => {
      const saved = makeScanCacheWriter(cap)(cache, {});
      const scanned = scanAgain(decodeScanCache(JSON.parse(saved), TEST_FORMAT_MAP));
      foldScanCache(scanned, 1000, new Set());
      return scanned;
    };

    const once = saveCappedAndScan(folded);
    expect(outputTokens(once)).toBe(11);
    expect(outputTokens(saveCappedAndScan(once))).toBe(11);
  });
});
