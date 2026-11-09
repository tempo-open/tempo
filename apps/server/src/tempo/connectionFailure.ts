/**
 * tempo: recognizes a turn that failed because the connection was lost. A failure only counts when
 * nothing says the model API refused the request: those need a person, and continuing would
 * repeat them.
 */
import type { OrchestrationV2ProviderFailure, RunId } from "@t3tools/contracts";
import { MessageId } from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";

/** The code of a failure recognized here. Older failures of any kind never carry it. */
export const CONNECTION_LOST_CODE = "connection_lost";

/** How many times in a row a turn continues by itself before its failure just stays. */
export const MAX_CONNECTION_CONTINUATIONS = 5;

const isGatewayFailureStatus = (status: number) =>
  status === 502 || status === 503 || status === 504 || (status >= 520 && status <= 527);

const REFUSAL_TEXT =
  /\[4\d\d\]|overloaded|rate.?limit|usage limit|quota|authenticat|unauthori[sz]ed|forbidden|permission|credential|billing|credit|invalid.?request|invalid.+key|\bsign.?in\b|\blog.?in\b/iu;

const CONNECTION_TEXT =
  /could not reach|connection (?:error|refused|reset|closed|lost|terminated|timed out)|unable to connect|socket hang up|fetch failed|network|stream disconnected|premature close|tim(?:ed|e) ?out|econnrefused|econnreset|econnaborted|enotfound|eai_again|etimedout|ehostunreach|enetunreach|enetdown|epipe|getaddrinfo|dns|went to sleep|response (?:stopped arriving|stalled)|never arrived|server error mid-response|response stream was malformed|connection to the api was lost/iu;

/**
 * Whether a provider's terminal error means the connection failed. An HTTP status decides when
 * there is one, because any other status is the API's own answer. `knownConnection` is a provider's
 * typed error saying so when its text does not.
 */
export function isConnectionFailure(input: {
  readonly status: number | null;
  readonly message: string;
  readonly knownConnection?: boolean;
}): boolean {
  if (REFUSAL_TEXT.test(input.message)) return false;
  if (input.status !== null) return isGatewayFailureStatus(input.status);
  return input.knownConnection === true || CONNECTION_TEXT.test(input.message);
}

export function asConnectionLost(
  failure: OrchestrationV2ProviderFailure,
): OrchestrationV2ProviderFailure {
  return {
    ...failure,
    class: "transport_error",
    code: CONNECTION_LOST_CODE,
    retryable: true,
    message: `${TEMPO_APP_BASE_NAME} lost its connection, so this turn stopped. Send a message to continue once the connection returns.`,
  };
}

/** Sent as the next turn: agents and delegated tasks do not come back with the connection. */
export const CONNECTION_CONTINUATION_TEXT =
  "Continue where you left off. Check which agents and delegated tasks the lost connection cut off, restart what did not finish, and finish the whole task.";

const CONTINUATION_MESSAGE_ID = /^message:connection-continuation:(\d+):/u;

/** The message that continues `sourceRunId` as a turn's `attempt`th automatic continue. */
export const connectionContinuationMessageId = (sourceRunId: RunId, attempt: number): MessageId =>
  MessageId.make(`message:connection-continuation:${attempt}:${sourceRunId}`);

/** How many automatic continues led to the run started by this message. */
export function connectionContinuationCount(userMessageId: string): number {
  const attempt = CONTINUATION_MESSAGE_ID.exec(userMessageId)?.[1];
  return attempt === undefined ? 0 : Number(attempt);
}
