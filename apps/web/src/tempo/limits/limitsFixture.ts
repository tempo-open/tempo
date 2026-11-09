/**
 * tempo: sample limits of several Claude accounts, for the tests and the dev only preview
 * (devLimitsFixture.ts). A dev server holds no such accounts, so it cannot show these rows
 * otherwise.
 */
import {
  type EnvironmentId,
  ProviderDriverKind,
  type ServerProviderUsageWindow,
  type UsageLimitSourceAccount,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import type { LimitPresentations } from "@t3tools/shared/usageLimits";

const HOUR_MS = 3_600_000;

/** Name, share of the week left, hours until the week resets, hours until the session resets. */
type FixtureAccount = readonly [
  name: string,
  weekLeft: number,
  weekHours: number,
  sessionHours: number | null,
];

const SAMPLE_A: readonly FixtureAccount[] = [
  ["Work", 96, 52, 1.5],
  ["Hobby", 97, 75, 3],
  ["Contract", 100, 140, null],
  ["Main", 100, 160, null],
  ["Backup", 0, 55 / 60, null],
  ["Client", 0, 37, null],
];

// The same accounts at another time, with different accounts full.
const SAMPLE_B: readonly FixtureAccount[] = [
  ["Hobby", 10, 50, 1],
  ["Contract", 100, 120, 2],
  ["Main", 100, 140, 3],
  ["Backup", 100, 160, 4],
  ["Client", 0, 12, null],
  ["Work", 0, 60, null],
];

// Not measured: accounts past the first six, for the home's longer lists.
const MORE: readonly FixtureAccount[] = [
  ["LABS", 0, 4 + 10 / 60, null],
  ["DESIGN", 23, 88, null],
  ["OPS", 71, 102, null],
  ["RESEARCH", 88, 150, null],
];

// Every account full: refill times as the mockup draws them, not measured.
const EVERY_ACCOUNT_FULL: readonly FixtureAccount[] = [
  ["Work", 0, 26, null],
  ["Hobby", 0, 4, null],
  ["Contract", 0, 53, null],
  ["Main", 0, 9, null],
  ["Backup", 0, 55 / 60, null],
  ["Client", 0, 37, null],
];

// Not measured: the widest refill of each unit, for the home's last column.
const WIDEST: readonly FixtureAccount[] = [
  ["Contract", 100, 140, null],
  ["Main", 100, 160, null],
  ["Hobby", 100, 75, null],
  ["Backup", 0, 58 / 60, null],
  ["Client", 0, 23 + 20 / 60, null],
  ["Work", 0, 6 * 24 + 10, null],
];

const FIXTURES = {
  "sample-a": SAMPLE_A,
  "sample-b": SAMPLE_B,
  out: EVERY_ACCOUNT_FULL,
  widest: WIDEST,
  accounts7: [...SAMPLE_B, ...MORE.slice(0, 1)],
  accounts8: [...SAMPLE_B, ...MORE.slice(0, 2)],
  accounts10: [...SAMPLE_B, ...MORE],
} satisfies Record<string, readonly FixtureAccount[]>;

type LimitsFixtureMode = keyof typeof FIXTURES;

export const isLimitsFixtureMode = (mode: string | null): mode is LimitsFixtureMode =>
  mode !== null && Object.hasOwn(FIXTURES, mode);

function windows(
  now: number,
  weekLeft: number,
  weekHours: number,
  sessionHours: number | null,
): ServerProviderUsageWindow[] {
  const at = (hours: number) => new Date(now + hours * HOUR_MS).toISOString();
  return [
    {
      id: "five_hour",
      kind: "session",
      label: "Session",
      usedPercent: sessionHours === null ? 0 : 35,
      ...(sessionHours === null ? {} : { resetsAt: at(sessionHours) }),
      windowDurationMins: 300,
    },
    {
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      usedPercent: 100 - weekLeft,
      resetsAt: at(weekHours),
      windowDurationMins: 7 * 24 * 60,
    },
  ];
}

export function limitsFixture(
  now: number,
  mode: LimitsFixtureMode,
  environmentId: EnvironmentId,
): LimitPresentations {
  const checkedAt = new Date(now).toISOString();
  const claude = FIXTURES[mode].map(
    ([name, weekLeft, weekHours, sessionHours]): UsageLimitSourceAccount => ({
      id: name,
      driver: ProviderDriverKind.make("claudeAgent"),
      plan: "Claude Subscription",
      usageLimits: { checkedAt, windows: windows(now, weekLeft, weekHours, sessionHours) },
    }),
  );
  return new Map([
    [
      environmentId,
      {
        entry: { target: { label: "This Mac" } },
        serverConfig: {
          providers: [],
          usageLimitSources: [
            {
              id: UsageLimitSourceId.make("claude"),
              kind: "cliproxy",
              label: "This Mac",
              checkedAt,
              accounts: claude,
            },
            {
              id: UsageLimitSourceId.make("codex"),
              kind: "cliproxy",
              label: "This Mac",
              checkedAt,
              accounts: [
                {
                  id: "Codex",
                  driver: ProviderDriverKind.make("codex"),
                  plan: "Pro",
                  usageLimits: {
                    checkedAt,
                    windows: windows(now, 99, 98, 4),
                    // Not measured: two banked credits, so the row's details offer Use reset.
                    resetCredits: {
                      availableCount: 2,
                      nextExpiresAt: new Date(now + 72 * HOUR_MS).toISOString(),
                      nextCreditId: "credit-1",
                    },
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  ]);
}
