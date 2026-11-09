import {
  type TempoApprovalTool,
  NodeId,
  ProviderInstanceId,
  RunId,
  type RuntimeMode,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

/**
 * What the user does when a service write approval card appears. `late`
 * presses Allow once just as the wait times out, before the card closes.
 */
export type UserAnswer = "approve" | "deny" | "ignore" | "late";

/**
 * The caller's live thread with one running turn, and a user who answers every
 * approval card the same way. `cards` holds the tool each card names,
 * `requests` each request as last recorded and `closes` every attempt to close
 * a card; the orchestrator's own tests cover how a recorded approval becomes a card.
 */
export const makeApprovalWorld = (input: {
  readonly answer: UserAnswer;
  readonly providerInstanceId?: string;
  readonly runtimeMode?: RuntimeMode;
}) => {
  const run = {
    id: RunId.make("run:services"),
    ordinal: 1,
    providerInstanceId: ProviderInstanceId.make(input.providerInstanceId ?? "codex"),
    rootNodeId: NodeId.make("node:services-root"),
    status: "running",
  } as OrchestrationV2Run;

  const requests = new Map<string, OrchestrationV2RuntimeRequest>();
  const cards = new Map<string, TempoApprovalTool>();
  const closes: Array<string> = [];
  const answered = (request: OrchestrationV2RuntimeRequest): OrchestrationV2RuntimeRequest =>
    request.status !== "pending" || input.answer === "ignore" || input.answer === "late"
      ? request
      : {
          ...request,
          status: "resolved",
          resolvedAt: request.createdAt,
          decision: input.answer === "approve" ? "accept" : "decline",
        };

  const layer = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (threadId) =>
      Effect.succeed(
        liveThreadShell(threadId, { runtimeMode: input.runtimeMode ?? "auto-accept-edits" }),
      ),
    getThreadRecords: () =>
      Effect.succeed({
        runs: [run],
        runtimeRequests: [...requests.values()].map(answered),
      } as never),
    dispatch: (command) =>
      Effect.sync(() => {
        if (command.type !== "service_approval.record") throw new Error(command.type);
        const now = DateTime.makeUnsafe(0);
        const existing = requests.get(command.requestId);
        if (command.status === "pending") {
          cards.set(command.requestId, command.tool);
          requests.set(command.requestId, {
            id: command.requestId,
            nodeId: NodeId.make(`node:${command.requestId}`),
            providerTurnId: null,
            nativeRequestRef: null,
            kind: "permission",
            status: "pending",
            responseCapability: { type: "message" },
            createdAt: now,
            resolvedAt: null,
          });
        } else {
          closes.push(command.requestId);
          // Closing an answered card changes nothing; a late Allow lands first.
          if (existing !== undefined && answered(existing).status === "pending") {
            requests.set(
              command.requestId,
              input.answer === "late"
                ? { ...existing, status: "resolved", resolvedAt: now, decision: "accept" }
                : { ...existing, status: "cancelled", resolvedAt: now },
            );
          }
        }
        return { sequence: 0, storedEvents: [] };
      }),
  });
  return { layer, cards, requests, closes };
};
