import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

// Do not debounce upstream: its consumer can retain an older snapshot during a save.
export const runCachePersistence = Effect.fn("runCachePersistence")(function* <A, E, R>(
  queue: Queue.Queue<A>,
  persist: (value: A) => Effect.Effect<void, E, R>,
  // tempo: what a write waits for before the next one may start.
  pause: Effect.Effect<void> = Effect.sleep("10 seconds"),
) {
  let next = yield* Queue.take(queue);
  yield* Effect.sleep("500 millis");
  next = Option.getOrElse(yield* Queue.poll(queue), () => next);
  while (true) {
    yield* persist(next);
    yield* pause;
    next = yield* Queue.take(queue);
  }
});
