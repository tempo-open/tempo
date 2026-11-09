/**
 * tempo: a company service write waits for an Allow once / Deny card on the caller's run. No agent can
 * answer it, and ending the run closes it. `askBeforeServiceWrites` off skips it. Tempo: full access
 * skips it for Cloudflare and OpenRouter, except mail. Other connections can reach people, so they ask.
 */
import {
  CommandId,
  type TempoApprovalTool,
  type TempoServiceKind,
  TEMPO_APPROVAL_TOOL_INPUT_LIMIT,
  TEMPO_SERVICE_APPROVAL_REQUEST_ID_PREFIX,
  type OrchestrationV2RuntimeRequest,
  OrchestratorMcpFailure,
  RuntimeRequestId,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { maskSecretFields } from "../../../tempo/serviceRequestPolicy.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const SERVICE_APPROVAL_TIMEOUT_MS = 10 * 60 * 1_000;
const POLL_INTERVAL_MS = 500;
const TEXT_LIMIT = 500;

export interface ServiceWrite {
  /** The MCP tool, such as `openrouter_key_delete`. */
  readonly tool: string;
  /** The connection as the agent named it, or its kind when it did not. */
  readonly service: string;
  /** What the write does, such as `DELETE` or `Delete key`. */
  readonly operation: string;
  /** What it acts on: a path, key hash, or DNS name. */
  readonly target: string;
  /** What it sends; secret-looking fields are masked before the card sees them. */
  readonly payload?: unknown;
  /** The connection's kind, when known. Unknown asks. */
  readonly kind?: TempoServiceKind | undefined;
}

const SENDS_MAIL = /(^|\/)e?mail(\/|$)|(^|\/)email[-_]/i;

/** Tempo: Cloudflare and OpenRouter change infrastructure; only a mail path reaches people. */
const runsUnaskedInFullAccess = (write: ServiceWrite) =>
  (write.kind === "cloudflare" || write.kind === "openrouter") && !SENDS_MAIL.test(write.target);

const cut = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit)}…`;

function serviceWriteApprovalTool(write: ServiceWrite): TempoApprovalTool {
  const input = JSON.stringify({
    service: write.service,
    operation: write.operation,
    target: write.target,
    ...(write.payload === undefined ? {} : { payload: maskSecretFields(write.payload) }),
  });
  return {
    name: `mcp__t3-code__${write.tool}`,
    input: cut(input, TEMPO_APPROVAL_TOOL_INPUT_LIMIT),
    firstArg: cut(write.target, TEXT_LIMIT),
    subtitle: cut(`${write.service} · ${write.operation} ${write.target}`, TEXT_LIMIT),
  };
}

const notAsked = (message: string) =>
  new OrchestratorMcpFailure({ code: "parent_not_active", message });
const refused = (message: string) =>
  new OrchestratorMcpFailure({ code: "capability_denied", message });
const broken = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: `Could not ask the user to approve this service write: ${
      cause instanceof Error ? cause.message : String(cause)
    }`,
  });

type Answer = "approved" | "declined" | "cancelled" | "closed" | "timed_out";

function answerOf(request: OrchestrationV2RuntimeRequest): Answer | undefined {
  if (request.status === "pending") return undefined;
  if (request.status !== "resolved") return "closed";
  switch (request.decision) {
    case "accept":
    case "acceptForSession":
    case "acceptAlways":
      return "approved";
    case "decline":
      return "declined";
    default:
      return "cancelled";
  }
}

const REFUSALS: Record<Exclude<Answer, "approved">, string> = {
  declined:
    "The user denied this service write, so it did not run. Do not retry it unless they ask.",
  cancelled: "The user cancelled this service write, so it did not run.",
  closed:
    "The approval closed before the user answered (the turn ended), so the write did not run.",
  timed_out: `The user did not answer within ${SERVICE_APPROVAL_TIMEOUT_MS / 60_000} minutes, so the write did not run. Ask them before trying again.`,
};

/**
 * Builds `ask`: it raises the card on the caller's active run and succeeds
 * only when the user approves. Every other outcome fails with a plain message.
 */
export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const settings = yield* ServerSettings.ServerSettingsService;

  // Unreadable settings ask, rather than assume the person turned asking off.
  const asks = settings.getSettings.pipe(
    Effect.map((current) => current.askBeforeServiceWrites),
    Effect.catch((error) =>
      Effect.logWarning("Could not read askBeforeServiceWrites; asking", {
        operation: error.operation,
      }).pipe(Effect.as(true)),
    ),
  );

  return Effect.fn("ServiceWriteApproval.ask")(function* (write: ServiceWrite) {
    if (!(yield* asks)) return;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    if (scope.thread === undefined) {
      return yield* notAsked(
        `Service writes need an agent running in a ${TEMPO_APP_BASE_NAME} thread to ask the user.`,
      );
    }
    const threadId = scope.thread.threadId;
    if (runsUnaskedInFullAccess(write)) {
      const shell = yield* threads.getThreadShell(threadId).pipe(Effect.mapError(broken));
      if (shell?.runtimeMode === "full-access" && shell.interactionMode === "default") return;
    }
    const projection = yield* threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(Effect.mapError(broken));
    const run = ThreadManagementService.latestActiveRun(projection);
    if (run === undefined || run.providerInstanceId !== scope.thread.providerInstanceId) {
      return yield* notAsked(
        "A service write needs the user's approval, and this thread has no active turn to ask in. The write did not run.",
      );
    }
    const key = yield* crypto.randomUUIDv4().pipe(Effect.mapError(broken));
    const requestId = RuntimeRequestId.make(`${TEMPO_SERVICE_APPROVAL_REQUEST_ID_PREFIX}${key}`);
    const record = (status: "pending" | "cancelled") =>
      threads.dispatch({
        type: "service_approval.record",
        commandId: CommandId.make(`service-approval:${key}:${status}`),
        threadId,
        runId: run.id,
        requestId,
        tool: serviceWriteApprovalTool(write),
        status,
      });

    yield* record("pending").pipe(
      Effect.mapError(() =>
        notAsked(
          "A service write needs the user's approval, and the turn ended before they could be asked. The write did not run.",
        ),
      ),
    );

    // Only this call acts on the answer, so the card must not outlive it.
    const closeCard = record("cancelled").pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not close a service write approval", { error: String(error) }),
      ),
    );

    // A stopped turn closes the card even when the provider keeps this call waiting.
    const check = Effect.gen(function* () {
      const records = yield* threads
        .getThreadRecords(threadId, ["runs", "runtimeRequests"])
        .pipe(Effect.mapError(broken));
      const current = records.runs.find((entry) => entry.id === run.id);
      if (current === undefined || !ThreadManagementService.isActiveRun(current)) return "closed";
      const latest = records.runtimeRequests.find((entry) => entry.id === requestId);
      return latest === undefined ? "closed" : answerOf(latest);
    });

    const answer: Answer = yield* Effect.gen(function* () {
      while (true) {
        const answer = yield* check;
        if (answer !== undefined) return answer;
        yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
      }
    }).pipe(
      Effect.timeoutOption(Duration.millis(SERVICE_APPROVAL_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onSome: (answer) => Effect.succeed(answer),
          // An Allow that lands before the close wins, so the card never says Allowed for a write that did not run.
          onNone: () =>
            closeCard.pipe(
              Effect.andThen(check),
              Effect.map((answer) =>
                answer === undefined || answer === "closed" ? "timed_out" : answer,
              ),
            ),
        }),
      ),
      Effect.onInterrupt(() => closeCard),
    );
    if (answer === "closed") yield* closeCard;
    if (answer !== "approved") return yield* refused(REFUSALS[answer]);
  });
});
