import { ProviderDriverKind, type ServerProviderUsageWindow } from "@t3tools/contracts";
import { collectLimitPools, type LimitAccount } from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

import {
  accountsInLines,
  formatRefill,
  formatRefillGlance,
  limitGlance,
  type LimitGlanceAccount,
} from "./limitGlance.logic";

const NOW = Date.parse("2026-11-07T20:00:00.000Z");

function weekly(usedPercent: number, resetsAt?: string): ServerProviderUsageWindow {
  return {
    id: "seven_day",
    kind: "weekly",
    label: "Weekly",
    usedPercent,
    windowDurationMins: 7 * 24 * 60,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function account(
  key: string,
  driver: string,
  windows: readonly ServerProviderUsageWindow[],
): LimitAccount {
  return {
    key,
    driver: ProviderDriverKind.make(driver),
    displayName: key,
    email: undefined,
    plan: undefined,
    accentColor: undefined,
    environments: [],
    sourceLabel: null,
    redeem: null,
    limits: { checkedAt: "2026-11-07T19:59:00.000Z", windows },
  };
}

const glances = (accounts: readonly LimitAccount[]) =>
  collectLimitPools(accounts, NOW)
    .map(limitGlance)
    .map((glance) =>
      glance === null
        ? null
        : { ...glance, accounts: glance.accounts.map((account) => account.remainingPercent) },
    );

describe("limitGlance", () => {
  it("pools the week across every account, the full ones last with their refills", () => {
    const [claude] = collectLimitPools(
      [
        account("Client", "claudeAgent", [weekly(100, "2026-11-09T09:00:00.000Z")]),
        account("Work", "claudeAgent", [weekly(4, "2026-11-10T00:00:00.000Z")]),
        account("Backup", "claudeAgent", [weekly(100, "2026-11-07T20:55:00.000Z")]),
        account("Hobby", "claudeAgent", [weekly(3, "2026-11-11T00:00:00.000Z")]),
        account("Contract", "claudeAgent", [weekly(0)]),
        account("Main", "claudeAgent", [weekly(0)]),
      ],
      NOW,
    ).map(limitGlance);
    expect(claude).toMatchObject({ driver: "claudeAgent", remainingPercent: 66, refillsAt: null });
    expect(
      claude?.accounts.map(({ name, remainingPercent, refillsAt }) => [
        name,
        remainingPercent,
        refillsAt,
      ]),
    ).toEqual([
      ["Work", 96, null],
      ["Hobby", 97, null],
      ["Contract", 100, null],
      ["Main", 100, null],
      ["Backup", 0, Date.parse("2026-11-07T20:55:00.000Z")],
      ["Client", 0, Date.parse("2026-11-09T09:00:00.000Z")],
    ]);
  });

  it("gives the first refill once every account is full", () => {
    const [claude] = glances([
      account("Work", "claudeAgent", [weekly(100, "2026-11-08T22:00:00.000Z")]),
      account("Backup", "claudeAgent", [weekly(100, "2026-11-07T20:55:00.000Z")]),
    ]);
    expect(claude).toMatchObject({
      remainingPercent: 0,
      accounts: [0, 0],
      refillsAt: Date.parse("2026-11-07T20:55:00.000Z"),
    });
  });

  it("pools the week, and holds an account whose session is spent until it serves again", () => {
    const session: ServerProviderUsageWindow = {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: 100,
      resetsAt: "2026-11-07T21:00:00.000Z",
    };
    const [claude] = glances([
      account("Work", "claudeAgent", [session, weekly(20)]),
      account("Main", "claudeAgent", [weekly(40)]),
    ]);
    expect(claude).toMatchObject({ remainingPercent: 70, accounts: [60, 0], refillsAt: null });
    expect(
      collectLimitPools([account("Work", "claudeAgent", [session, weekly(20)])], NOW).map(
        limitGlance,
      ),
    ).toMatchObject([
      {
        remainingPercent: 80,
        accounts: [{ remainingPercent: 0, refillsAt: Date.parse("2026-11-07T21:00:00.000Z") }],
        refillsAt: Date.parse("2026-11-07T21:00:00.000Z"),
      },
    ]);
  });

  it("keeps the order across owners: serving accounts first, then the soonest back", () => {
    const owned = (key: string, owner: "mine" | "shared", used: number, resetsAt?: string) => ({
      ...account(key, "claudeAgent", [weekly(used, resetsAt)]),
      owner,
    });
    const [claude] = collectLimitPools(
      [
        owned("MINE_FULL_2D", "mine", 100, "2026-11-09T20:00:00.000Z"),
        owned("MINE_OK", "mine", 10),
        owned("SHARED_OK", "shared", 20),
        owned("SHARED_FULL_55M", "shared", 100, "2026-11-07T20:55:00.000Z"),
      ],
      NOW,
    ).map(limitGlance);
    expect(claude?.accounts.map((glanced) => glanced.name)).toEqual([
      "MINE_OK",
      "SHARED_OK",
      "SHARED_FULL_55M",
      "MINE_FULL_2D",
    ]);
  });

  it("shows Claude and Codex only", () => {
    expect(
      glances([
        account("me", "codex", [{ ...weekly(1), id: "secondary" }]),
        account("me", "cursor", [weekly(50)]),
      ]),
    ).toEqual([{ driver: "codex", remainingPercent: 99, accounts: [99], refillsAt: null }, null]);
  });
});

describe("formatRefill", () => {
  it("drops a zero last part", () => {
    expect(
      [55, 4 * 60, 4 * 60 + 30, 26 * 60, 48 * 60].map((minutes) => formatRefill(minutes * 60_000)),
    ).toEqual(["55m", "4h", "4h 30m", "1d 2h", "2d"]);
  });
});

describe("formatRefillGlance", () => {
  it("gives the time in one unit: minutes as the countdown shows them, hours and days to the nearest one", () => {
    const minutes = (hours: number, rest = 0) => (hours * 60 + rest) * 60_000;
    expect(
      [
        minutes(0, 52),
        minutes(0, 59.6),
        minutes(12, 29),
        minutes(12, 52),
        minutes(23, 29),
        minutes(23, 31),
        minutes(2 * 24 + 9),
        minutes(2 * 24 + 13),
        minutes(6 * 24 + 10),
      ].map(formatRefillGlance),
    ).toEqual(["52m", "59m", "12h", "13h", "23h", "1d", "2d", "3d", "6d"]);
  });
});

describe("accountsInLines", () => {
  const glanced = (name: string, remainingPercent: number, refillsInHours?: number) =>
    ({
      key: name,
      name,
      remainingPercent,
      refillsAt: refillsInHours === undefined ? null : NOW + refillsInHours * 3_600_000,
    }) satisfies LimitGlanceAccount;
  // In the card's order: serving accounts first, then the full ones, soonest back first.
  const ten = [
    glanced("Hobby", 6),
    glanced("Contract", 100),
    glanced("Main", 99),
    glanced("Backup", 100),
    glanced("DESIGN", 23),
    glanced("OPS", 71),
    glanced("RESEARCH", 88),
    glanced("LABS", 0, 4),
    glanced("Client", 0, 13),
    glanced("Work", 0, 57),
  ];
  const names = ({ shown, more }: ReturnType<typeof accountsInLines>) => [
    shown.map((account) => account.name),
    more,
  ];

  it("shows every account that fits", () => {
    expect(names(accountsInLines(ten.slice(2), 8))).toEqual([
      ["Main", "Backup", "DESIGN", "OPS", "RESEARCH", "LABS", "Client", "Work"],
      0,
    ]);
  });

  it("past the lines, keeps the least left and the soonest back in the card's order", () => {
    expect(names(accountsInLines(ten, 8))).toEqual([
      ["Hobby", "DESIGN", "OPS", "RESEARCH", "LABS", "Client", "Work"],
      3,
    ]);
    expect(names(accountsInLines(ten.slice(1), 8))).toEqual([
      ["Main", "DESIGN", "OPS", "RESEARCH", "LABS", "Client", "Work"],
      2,
    ]);
    const full = [glanced("OPS", 50), glanced("B", 0, 2), glanced("C", 0, 5), glanced("A", 0, 10)];
    expect(names(accountsInLines(full, 3))).toEqual([["B", "C"], 2]);
  });
});
