import { useAtomValue } from "@effect/atom-react";
import { collectLimitAccounts, collectLimitPools } from "@t3tools/shared/usageLimits";

import { useNowMinute } from "~/hooks/useNowMinute";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { environmentPresentations } from "~/state/presentation";
import { devLimitsFixture } from "./devLimitsFixture";
import { limitGlance } from "./limitGlance.logic";

/** Claude's and Codex's weeks at a glance, Claude first, for the sidebar footer and the home. */
export function useLimitGlances() {
  const live = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  const environmentId = usePrimaryEnvironmentId();
  // The refill time is a clock, so it moves on minute boundaries; the percentages move only
  // when the server reports new limits.
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00.000Z`);
  const presentations = devLimitsFixture(environmentId) ?? live;
  const glances = collectLimitPools(collectLimitAccounts(presentations), now)
    .flatMap((pool) => limitGlance(pool) ?? [])
    .toSorted((left, right) => Number(left.driver === "codex") - Number(right.driver === "codex"));
  // Until this Mac's server answers, nothing is known about its accounts.
  const loading = environmentId === null || !presentations.get(environmentId)?.serverConfig;
  return { now, glances, loading };
}
