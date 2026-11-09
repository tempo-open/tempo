/**
 * tempo: whether anything could notice what the pull request sweeps find (a visible client, an agent
 * run, auto-settling). While nothing could, the sweeps poll at the slow interval, so an idle laptop
 * on battery stops asking GitHub and git every minute; attention returning brings a waiting sweep
 * forward. A watched pull request keeps the minute, since its watch reads that snapshot.
 */
import type { BackgroundPolicySnapshot, ServerSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import { autoSettlementConfigured } from "../orchestration-v2/ThreadSettlementService.ts";
import * as ServerSettingsService from "../serverSettings.ts";

/** The pull request sync's slow cadence, which closed pull requests already poll at. */
const IDLE_SWEEP_INTERVAL = Duration.minutes(15);

export class SweepAttention extends Context.Service<
  SweepAttention,
  {
    /** True while a client is visible, a run is under way, or auto-settling is on anywhere. */
    readonly attended: Effect.Effect<boolean>;
    /** Signals each time attention may have returned; `attended` tells whether it did. */
    readonly returns: Stream.Stream<void>;
    /**
     * Sleeps `interval`. While unattended it then keeps sleeping until attention returns, at most
     * until the slow interval has passed since the sleep began.
     */
    readonly pause: (interval: Duration.Input) => Effect.Effect<void>;
  }
>()("t3/tempo/SweepAttention") {}

const make = Effect.gen(function* () {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettingsService.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const returned = yield* PubSub.sliding<void>(1);
  let clientVisible = false;
  let autoSettling = false;

  // The first term matches the recovery index's predicate, so SQLite reads only that small index.
  const runUnderWay = sql<{ readonly found: number }>`
    SELECT 1 AS found FROM orchestration_v2_projection_runs
    WHERE status IN ('queued', 'preparing', 'starting', 'running', 'waiting')
      AND status <> 'queued'
    LIMIT 1
  `.pipe(
    Effect.map((rows) => rows.length > 0),
    // Unknown counts as under way, which keeps today's cadence.
    Effect.orElseSucceed(() => true),
    Effect.withTracerEnabled(false),
  );

  const attended = Effect.suspend(() =>
    clientVisible || autoSettling ? Effect.succeed(true) : runUnderWay,
  );
  const signal = PubSub.publish(returned, undefined).pipe(Effect.asVoid);

  const noteClients = (snapshot: BackgroundPolicySnapshot) =>
    Effect.suspend(() => {
      const visible = snapshot.leases.some((lease) => lease.visible);
      const gained = visible && !clientVisible;
      clientVisible = visible;
      return gained ? signal : Effect.void;
    });
  const noteSettings = (current: ServerSettings) =>
    Effect.suspend(() => {
      const configured = autoSettlementConfigured(current);
      const gained = configured && !autoSettling;
      autoSettling = configured;
      return gained ? signal : Effect.void;
    });

  const clients = yield* backgroundPolicy.subscribe;
  yield* noteClients(clients.latest);
  yield* Stream.runForEach(clients.changes, noteClients).pipe(Effect.forkScoped);

  const settingsChanges = yield* settings.subscribeChanges;
  yield* settings.getSettings.pipe(
    Effect.flatMap(noteSettings),
    Effect.catch(() =>
      Effect.sync(() => {
        autoSettling = true;
      }),
    ),
  );
  yield* Stream.runForEach(settingsChanges, noteSettings).pipe(Effect.forkScoped);

  yield* Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
    event.type === "run.updated" &&
    ["preparing", "starting", "running", "waiting"].includes(event.payload.status)
      ? signal
      : Effect.void,
  ).pipe(Effect.ignoreCause({ log: true }), Effect.forkScoped);

  // Subscribed before the check, so attention returning between the two still wakes it.
  const awaitAttention = Effect.scoped(
    Effect.gen(function* () {
      const signals = yield* PubSub.subscribe(returned);
      while (!(yield* attended)) yield* PubSub.take(signals);
    }),
  );

  const pause: SweepAttention["Service"]["pause"] = (interval) =>
    Effect.sleep(interval).pipe(
      Effect.andThen(
        awaitAttention.pipe(
          Effect.timeoutOrElse({
            duration: Math.max(
              0,
              Duration.toMillis(IDLE_SWEEP_INTERVAL) - Duration.toMillis(interval),
            ),
            orElse: () => Effect.void,
          }),
        ),
      ),
    );

  return SweepAttention.of({ attended, returns: Stream.fromPubSub(returned), pause });
});

export const layer = Layer.effect(SweepAttention, make);
