import { OrchestratorMcpFailure, type TempoProductionWaitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { readThread } from "../../mcp/threadAccess.ts";
import * as ProductionWait from "../productionWait/ProductionWait.ts";
import { TempoProductionWaitToolkit } from "./productionWaitTools.ts";

/** Every message here is written for the agent and says what to do next. */
const toFailure = (error: TempoProductionWaitError) =>
  new OrchestratorMcpFailure({
    code:
      error._tag === "TempoProductionWaitFailedError"
        ? "orchestration_error"
        : error.reason === "notFound"
          ? "thread_not_found"
          : "invalid_request",
    message: error.message,
  });

export const layer = McpToolAccess.toLayer(TempoProductionWaitToolkit, {
  wait_for_production: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { projection } = yield* readThread(input.threadId);
        const productionWait = yield* ProductionWait.ProductionWait;
        const { waitingForProductionSince } = yield* productionWait
          .setWaiting({ threadId: projection.thread.id, waiting: input.waiting ?? true })
          .pipe(Effect.mapError(toFailure));
        return {
          waitingForProductionSince,
          message:
            waitingForProductionSince === null
              ? "The thread no longer waits for production."
              : `The thread waits for production since ${waitingForProductionSince}. End your turn; the next promotion wakes it.`,
        };
      }),
  ),
});
