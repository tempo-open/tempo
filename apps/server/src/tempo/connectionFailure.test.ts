import { assert, describe, it } from "@effect/vitest";
import { RunId } from "@t3tools/contracts";

import {
  asConnectionLost,
  connectionContinuationCount,
  connectionContinuationMessageId,
  isConnectionFailure,
} from "./connectionFailure.ts";

describe("isConnectionFailure", () => {
  it.each([
    [502, "API Error: 502 Bad Gateway"],
    [502, "API Error: 502 The gateway is unavailable. Try again."],
    [504, "API Error: 504 upstream request timeout"],
    [524, "API Error: 524 <html>A timeout occurred</html>"],
    [null, "API Error: Connection error."],
    [null, "API Error: Request timed out."],
    [null, "API Error: connect ECONNREFUSED 127.0.0.1:60103"],
    [null, "API Error: read ECONNRESET"],
    [null, "API Error: getaddrinfo ENOTFOUND api.example.com"],
    [null, "API Error: socket hang up"],
    [null, "stream disconnected before completion: error sending request"],
    [
      null,
      "API Error: Your computer went to sleep mid-response. The response above may be incomplete.",
    ],
    [null, "API Error: Your computer went to sleep before a response was produced. Try again."],
    [null, "API Error: The response stopped arriving. The response above may be incomplete."],
    [null, "API Error: The response stalled before a response was produced. Try again."],
    [null, "API Error: Part of the response never arrived. The response above may be incomplete."],
    [null, "API Error: Server error mid-response. The response above may be incomplete."],
    [null, "API Error: The response stream was malformed and no response was produced. Try again."],
    [null, "API Error: Connection lost mid-response. The response above may be incomplete."],
    [null, "API Error: Connection to the API was lost (read ECONNRESET)"],
  ] as const)("counts status %s with %s", (status, message) => {
    assert.isTrue(isConnectionFailure({ status, message }));
  });

  it.each([
    [401, "API Error: 401 invalid x-api-key"],
    [403, "API Error: 403 Your account does not have access."],
    [400, "API Error: 400 messages: at least one message is required"],
    [409, 'API Error: 409 {"error":"You have no account here."}'],
    [429, "API Error: 429 rate limited"],
    [500, "API Error: 500 Internal server error"],
    [529, "API Error: 529 Overloaded"],
    [
      503,
      'API Error: 503 [acct] [429]: {"type":"error","error":{"type":"rate_limit_error"}} (reset after 1h)',
    ],
    [503, 'API Error: 503 [acct] [429]: {"error":{"type":"overloaded_error"}}'],
    [502, 'API Error: 502 {"error":{"type":"authentication_error"}}'],
    [null, "Invalid API key. Please log in again."],
    [null, "Credit balance is too low."],
    [null, "Claude gave up after repeated API errors."],
  ] as const)("does not count status %s with %s", (status, message) => {
    assert.isFalse(isConnectionFailure({ status, message }));
  });

  it("trusts a provider's typed error only where no status or refusal says otherwise", () => {
    assert.isTrue(isConnectionFailure({ status: null, message: "failed", knownConnection: true }));
    assert.isTrue(isConnectionFailure({ status: 502, message: "failed", knownConnection: true }));
    assert.isFalse(isConnectionFailure({ status: 429, message: "failed", knownConnection: true }));
    assert.isFalse(
      isConnectionFailure({ status: null, message: "usage limit", knownConnection: true }),
    );
  });
});

describe("asConnectionLost", () => {
  it("says the turn stopped and how to continue it", () => {
    const failure = asConnectionLost({
      class: "provider_error",
      message: "API Error: 502",
      code: "api_error_502",
      retryable: null,
    });
    assert.strictEqual(failure.code, "connection_lost");
    assert.match(failure.message, /lost its connection, so this turn stopped/u);
    assert.match(failure.message, /Send a message to continue/u);
  });
});

describe("connectionContinuationCount", () => {
  it("counts from the message that started the run, and from zero for any other", () => {
    const source = RunId.make("run:thread:1:ordinal:3");
    assert.strictEqual(connectionContinuationCount(connectionContinuationMessageId(source, 4)), 4);
    assert.strictEqual(connectionContinuationCount("message:thread:1:ordinal:3"), 0);
    assert.strictEqual(connectionContinuationCount("message:restart-continuation:run:1"), 0);
  });
});
