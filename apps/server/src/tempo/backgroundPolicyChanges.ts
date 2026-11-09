/**
 * tempo: the background policy's change stream, which upstream removed. Tempo's watchers of client
 * visibility (SweepAttention) read it; the policy publishes after its leases change.
 */
import type { BackgroundPolicySnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import {
  type SnapshotSubscription,
  subscribeBeforeSnapshot,
} from "../utils/subscribeBeforeSnapshot.ts";

export type BackgroundPolicySubscribe = Effect.Effect<
  SnapshotSubscription<BackgroundPolicySnapshot>,
  never,
  Scope.Scope
>;

/** Each publish reads the snapshot under the lock, so the last one sent follows the last change. */
export const makeBackgroundPolicyChanges = Effect.fn("tempo.makeBackgroundPolicyChanges")(
  function* (snapshot: Effect.Effect<BackgroundPolicySnapshot>) {
    const changes = yield* PubSub.sliding<BackgroundPolicySnapshot>(1);
    const mutex = yield* Semaphore.make(1);
    const publish = mutex.withPermits(1)(
      snapshot.pipe(
        Effect.flatMap((next) => PubSub.publish(changes, next)),
        Effect.asVoid,
      ),
    );
    const subscribe: BackgroundPolicySubscribe = subscribeBeforeSnapshot(changes, snapshot, mutex);
    return { publish, subscribe };
  },
);
