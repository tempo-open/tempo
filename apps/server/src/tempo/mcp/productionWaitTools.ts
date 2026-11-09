/**
 * tempo: the agent's way in and out of Waiting for Production. It calls the same
 * `ProductionWait.setWaiting` as the RPC and every client menu.
 */
import { IsoDateTime, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ProductionWait from "../productionWait/ProductionWait.ts";
import {
  PRODUCTION_PROMOTED_MESSAGE,
  resolveProductionPromotionTarget,
} from "../productionWait/productionWaitDecision.ts";

const WaitForProductionTool = Tool.make("wait_for_production", {
  description: `Park a thread until staging is promoted to production, then carry on. Use it when your work is merged to staging and the rest can only happen once it is live in production, such as checking it on production or a follow-up that needs the release; then end your turn. It works only where the server's TEMPO_PRODUCTION_REPOSITORY names the GitHub repository to watch; otherwise it refuses. ${TEMPO_APP_BASE_NAME} checks every two minutes for a promotion: a successful deployment to that repository's production environment by its deploy workflow (TEMPO_PRODUCTION_WORKFLOW, by default .github/workflows/deploy.yml). After the first one that starts after this call, it wakes the thread with "${PRODUCTION_PROMOTED_MESSAGE}", queued behind a running turn. A promotion may not include your change yet, so once woken, check that it is live and wait again if it is not. Meanwhile the thread sits under Waiting for Production in the user's sidebar. Omit threadId for this thread; waiting:false stops waiting. Calling it again while waiting keeps the original start. Messages do not end the wait; settling or archiving the thread does. A subagent cannot wait: its parent thread owns the work.`,
  parameters: Schema.Struct({
    threadId: Schema.optional(
      ThreadId.annotate({ description: "Thread to change. Omit for this thread." }),
    ),
    waiting: Schema.optional(
      Schema.Boolean.annotate({ description: "False stops waiting. Defaults to true." }),
    ),
  }),
  success: Schema.Struct({
    /** When the thread started waiting; null when it does not wait. */
    waitingForProductionSince: Schema.NullOr(IsoDateTime),
    message: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProductionWait.ProductionWait,
  ],
})
  .annotate(Tool.Title, "Wait for production")
  // Tempo: it refuses every call until TEMPO_PRODUCTION_REPOSITORY names a repository to watch.
  .annotate(McpSchema.EnabledWhen, () => resolveProductionPromotionTarget(process.env) !== null)
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const TempoProductionWaitToolkit = Toolkit.make(WaitForProductionTool);
