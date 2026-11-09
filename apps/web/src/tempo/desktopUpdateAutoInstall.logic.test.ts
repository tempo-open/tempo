import { describe, expect, it } from "vite-plus/test";

import { countLocalTurns, localTurnsReport } from "./desktopUpdateAutoInstall.logic";

const threads = (...statuses: ReadonlyArray<string>) => statuses.map((status) => ({ status }));

describe("countLocalTurns", () => {
  it("counts turns that are starting or running, and not threads waiting on background work", () => {
    expect(
      countLocalTurns([
        { live: true, threads: threads("running", "idle", "waiting", "completed") },
        { live: true, threads: threads("preparing", "queued", "starting", "failed") },
      ]),
    ).toBe(4);
  });

  it("cannot tell while an environment is still loading or reconnecting", () => {
    expect(
      countLocalTurns([
        { live: true, threads: threads("idle") },
        { live: false, threads: [] },
      ]),
    ).toBeNull();
  });
});

describe("localTurnsReport", () => {
  const ready = { environmentsReady: true, localEnvironmentOff: false };

  it("reports the count once the environments this app hosts are known", () => {
    expect(localTurnsReport({ ...ready, hostedEnvironments: 1, turns: 0 })).toBe(0);
    expect(localTurnsReport({ ...ready, hostedEnvironments: 1, turns: 2 })).toBe(2);
    expect(localTurnsReport({ ...ready, hostedEnvironments: 1, turns: null })).toBeNull();
  });

  it("cannot tell before the list loads or before the local environment joins it", () => {
    expect(
      localTurnsReport({ ...ready, environmentsReady: false, hostedEnvironments: 1, turns: 0 }),
    ).toBeNull();
    expect(localTurnsReport({ ...ready, hostedEnvironments: 0, turns: 0 })).toBeNull();
  });

  it("holds nothing back when this app runs no local environment", () => {
    expect(
      localTurnsReport({ ...ready, localEnvironmentOff: true, hostedEnvironments: 0, turns: 0 }),
    ).toBe(0);
  });
});
