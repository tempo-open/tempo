import type { EnvironmentId } from "@t3tools/contracts";

import { isLimitsFixtureMode, limitsFixture } from "./limitsFixture";

function requested() {
  const mode = new URLSearchParams(window.location.search).get("tempoLimits");
  return isLimitsFixtureMode(mode) ? { mode, at: Date.now() } : null;
}

// The app's own navigation drops the query, so the page's first address decides for the session.
const REQUESTED = import.meta.env.DEV ? requested() : null;

/**
 * Dev only: with `?tempoLimits=sample-a`, or another of limitsFixture.ts's modes such as `out` for every
 * account full, in the page's first address, the home, the sidebar footer and the Usage page show
 * that fixture in place of live limits.
 * Its refill times count down from the load, like live ones.
 */
export function devLimitsFixture(environmentId: EnvironmentId | null) {
  return import.meta.env.DEV && REQUESTED !== null && environmentId !== null
    ? limitsFixture(REQUESTED.at, REQUESTED.mode, environmentId)
    : null;
}
