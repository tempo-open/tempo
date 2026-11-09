/**
 * tempo: a thread's outline (tempoThreadOutline.ts), so the web minimap can mark messages that are not
 * loaded yet. The client reads it once per thread view; live turns reach it through the timeline.
 */
import {
  TempoThreadOutlineError,
  type TempoThreadOutline,
  type TempoThreadOutlineInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";

export class ThreadOutline extends Context.Service<
  ThreadOutline,
  {
    readonly get: (
      input: TempoThreadOutlineInput,
    ) => Effect.Effect<TempoThreadOutline, TempoThreadOutlineError>;
  }
>()("t3/tempo/threadOutline/ThreadOutline") {}

export const layer = Layer.effect(
  ThreadOutline,
  Effect.gen(function* () {
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return ThreadOutline.of({
      get: Effect.fn("ThreadOutline.get")(
        function* (input: TempoThreadOutlineInput) {
          // A migrated V1 thread's messages are only in the projection once hydrated.
          yield* threads.ensureLegacyTranscript(input.threadId);
          return { entries: yield* projections.getThreadOutline(input.threadId) };
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new TempoThreadOutlineError({ threadId: input.threadId, cause }),
            ),
          ),
      ),
    });
  }),
);
