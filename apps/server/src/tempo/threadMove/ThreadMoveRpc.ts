import {
  TEMPO_THREAD_MOVE_WS_METHODS,
  type TempoThreadMoveAbortInput,
  type TempoThreadMoveCreateImportUploadInput,
  type TempoThreadMoveFinalizeInput,
  type TempoThreadMoveImportInput,
  type TempoThreadMovePrepareInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ThreadMoveService from "./ThreadMoveService.ts";

/** WebSocket handlers for the thread move RPCs; each calls one service method. */
export const handlers = Effect.gen(function* () {
  const moves = yield* ThreadMoveService.ThreadMoveService;
  return {
    [TEMPO_THREAD_MOVE_WS_METHODS.prepare]: (input: TempoThreadMovePrepareInput) =>
      moves.prepareMove(input),
    [TEMPO_THREAD_MOVE_WS_METHODS.createImportUpload]: (
      input: TempoThreadMoveCreateImportUploadInput,
    ) => moves.createImportUpload(input),
    [TEMPO_THREAD_MOVE_WS_METHODS.import]: (input: TempoThreadMoveImportInput) =>
      moves.importMove(input),
    [TEMPO_THREAD_MOVE_WS_METHODS.finalize]: (input: TempoThreadMoveFinalizeInput) =>
      moves.finalizeMove(input),
    [TEMPO_THREAD_MOVE_WS_METHODS.abort]: (input: TempoThreadMoveAbortInput) =>
      moves.abortMove(input),
  } as const;
});
