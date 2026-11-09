import { EnvironmentId } from "@t3tools/contracts";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import { limitsReadAt, limitTable } from "./limitRows";
import { limitsFixture } from "./limitsFixture";

const NOW = Date.parse("2026-11-07T20:01:00.000Z");
const HOUR_MS = 3_600_000;

function claudeTable(everyAccountFull: boolean) {
  const fixture = limitsFixture(
    NOW,
    everyAccountFull ? "out" : "sample-a",
    EnvironmentId.make("env"),
  );
  const pools = collectLimitPools(collectLimitAccounts(fixture), NOW);
  const claude = pools.find((pool) => pool.driver === "claudeAgent")!;
  return { table: limitTable(claude) };
}

const rows = (table: ReturnType<typeof limitTable>) => table.groups.flatMap((group) => group.rows);

describe("limitTable", () => {
  it("pools the week, lists serving accounts first and full ones by their refill", () => {
    const { table } = claudeTable(false);
    expect(table.headline?.remainingPercent).toBe(66);
    expect(
      rows(table).map((row) => [row.account.displayName, row.remainingPercent, row.full]),
    ).toEqual([
      ["Work", 96, false],
      ["Hobby", 97, false],
      ["Contract", 100, false],
      ["Main", 100, false],
      ["Backup", 0, true],
      ["Client", 0, true],
    ]);
    expect(rows(table)[4]?.refillsAt).toBe(NOW + (55 / 60) * HOUR_MS);
    expect(table.nextRefillAt).toBeNull();
  });

  it("names the first refill once every account is full", () => {
    const { table } = claudeTable(true);
    expect(rows(table).map((row) => row.account.displayName)).toEqual([
      "Backup",
      "Hobby",
      "Main",
      "Work",
      "Client",
      "Contract",
    ]);
    expect(table.nextRefillAt).toBe(NOW + (55 / 60) * HOUR_MS);
  });

  it("lists every window of an account for its details", () => {
    const first = rows(claudeTable(false).table)[0]!;
    expect(first.windows.map(({ window }) => window.label)).toEqual(["Session", "Weekly"]);
  });
});

describe("limitsReadAt", () => {
  it("is when the newest of the limits shown was read", () => {
    const fixture = limitsFixture(NOW, "sample-a", EnvironmentId.make("env"));
    const accounts = collectLimitAccounts(fixture);
    expect(limitsReadAt(accounts)).toBe(new Date(NOW).toISOString());
    const older = {
      ...accounts[0]!,
      limits: { ...accounts[0]!.limits, checkedAt: "2026-11-07T19:00:00.000Z" },
    };
    expect(limitsReadAt([older])).toBe("2026-11-07T19:00:00.000Z");
    expect(limitsReadAt([])).toBeNull();
  });
});
