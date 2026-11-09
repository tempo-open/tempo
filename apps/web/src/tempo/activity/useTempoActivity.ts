/**
 * tempo: an environment's activity per local day (tempoActivity.ts), for the home Activity widget and the
 * Usage page. It loads when a view that shows it opens, when the person presses refresh and when the
 * server connects again; it never reloads on a timer. A view that opens draws the last answer at once
 * and updates in place when the next one arrives; only the session's first view waits for the server.
 */
import { useAtomValue } from "@effect/atom-react";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import { createEnvironmentRpcQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { request } from "@t3tools/client-runtime/rpc";
import {
  TEMPO_ACTIVITY_WS_METHODS,
  type EnvironmentId,
  type ServerConfig,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

const sessionActivity = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:tempo:activity",
  tag: TEMPO_ACTIVITY_WS_METHODS.read,
  // Kept for the session, with a read in flight, so no view that opens starts empty.
  idleTtlMs: Number.POSITIVE_INFINITY,
  // GitHub's days can still be loading: answer at once with what the server keeps, then again
  // once GitHub has been read.
  execute: (input, emit) =>
    request(TEMPO_ACTIVITY_WS_METHODS.read, input).pipe(
      Effect.filterOrElse(
        (activity) => activity.github !== "refreshing",
        (activity) =>
          emit(activity).pipe(
            Effect.andThen(
              request(TEMPO_ACTIVITY_WS_METHODS.read, { ...input, awaitRefresh: true }),
            ),
            Effect.catch((error) =>
              Effect.logWarning("Could not finish reading GitHub activity.").pipe(
                Effect.annotateLogs({ ...safeErrorLogAttributes(error) }),
                Effect.as({ ...activity, github: "failed" as const }),
              ),
            ),
          ),
      ),
    ),
});

// Built again by each view that opens, which asks again once the kept answer is 30 s old.
const activityQuery = Atom.family((kept: ReturnType<typeof sessionActivity>) =>
  Atom.swr(kept, { staleTime: 30_000 }),
);

const NO_SERVER_CONFIG_ATOM = Atom.make<ServerConfig | null>(null);
// Null until the server's config arrives.
const servesActivity = (config: ServerConfig | null) =>
  config === null ? null : config.environment.capabilities.tempoActivity === true;

/**
 * `activity` is undefined while the environment's server has no activity to give, or before its
 * first answer; `unsupported` says the server is too old to give any.
 */
export function useTempoActivity(environmentId: EnvironmentId | null) {
  const served = useAtomValue(
    environmentId === null
      ? NO_SERVER_CONFIG_ATOM
      : serverEnvironment.configValueAtom(environmentId),
    servesActivity,
  );
  const query = useEnvironmentQuery(
    served === true && environmentId !== null
      ? activityQuery(
          sessionActivity({
            environmentId,
            input: { timeZone: new Intl.DateTimeFormat().resolvedOptions().timeZone },
          }),
        )
      : null,
  );
  return {
    activity: query.data,
    isPending: query.isPending,
    error: query.error,
    refresh: query.refresh,
    unsupported: served === false,
  };
}
