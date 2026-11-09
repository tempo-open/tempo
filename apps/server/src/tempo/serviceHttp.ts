/**
 * Sends one request that carries a company secret: no redirects (a hop would
 * carry the secret to another host), no request spans (they record headers),
 * a timeout, and a body read that stops at the cap.
 *
 * @module serviceHttp
 */
import { TempoServiceError } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { FetchHttpClient, type HttpClient, type HttpClientRequest } from "effect/http";

import { SERVICE_RESPONSE_MAX_BYTES } from "./serviceRequestPolicy.ts";

/** Proxied service calls may be slow, so each one gets this long before it fails. */
const REQUEST_TIMEOUT_SECONDS = 30;

export interface CappedResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  /** At most SERVICE_RESPONSE_MAX_BYTES. */
  readonly bytes: Uint8Array;
  readonly truncated: boolean;
}

function concat(chunks: ReadonlyArray<Uint8Array>, limit: number): Uint8Array {
  const total = Math.min(
    limit,
    chunks.reduce((sum, chunk) => sum + chunk.length, 0),
  );
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= total) break;
    const part = chunk.subarray(0, total - offset);
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** `service` names the connection in the error an unreachable host fails with. */
export const executeCapped = Effect.fn("serviceHttp.executeCapped")(function* (
  httpClient: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  service: string,
  timeoutSeconds: number = REQUEST_TIMEOUT_SECONDS,
): Effect.fn.Return<CappedResponse, TempoServiceError> {
  const answered = yield* Effect.gen(function* () {
    const response = yield* httpClient.execute(request);
    let received = 0;
    const chunks = yield* response.stream.pipe(
      Stream.takeUntil((chunk) => {
        received += chunk.length;
        return received > SERVICE_RESPONSE_MAX_BYTES;
      }),
      Stream.runCollect,
      // A redirect or 204 has no body at all, which the stream reports as an error.
      Effect.catchIf(
        (error) => error.reason._tag === "EmptyBodyError",
        () => Effect.succeed<ReadonlyArray<Uint8Array>>([]),
      ),
    );
    return {
      status: response.status,
      headers: response.headers,
      bytes: concat(chunks, SERVICE_RESPONSE_MAX_BYTES),
      truncated: received > SERVICE_RESPONSE_MAX_BYTES,
    } satisfies CappedResponse;
  }).pipe(
    // No cause: an HttpClientError carries the request, and a connection's own
    // auth header is not one Effect knows to redact.
    Effect.mapError(() => new TempoServiceError({ reason: "unreachable", service })),
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.withTracerEnabled(false),
    Effect.timeoutOption(Duration.seconds(timeoutSeconds)),
  );
  if (Option.isSome(answered)) return answered.value;
  return yield* new TempoServiceError({
    reason: "unreachable",
    service,
    detail: `It did not answer within ${timeoutSeconds} seconds.`,
  });
});
