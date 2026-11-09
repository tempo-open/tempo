import { assert, describe, it } from "@effect/vitest";

import * as GitHubGraphQl from "./GitHubGraphQl.ts";

describe("classifyGraphQlAnswer", () => {
  it("reads GitHub's GraphQL errors as well as its status", () => {
    const tagOf = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      GitHubGraphQl.classifyGraphQlAnswer({ status, headers, body: JSON.stringify(body) })._tag;
    assert.equal(tagOf(200, { data: { repository: null } }), "Ok");
    assert.equal(
      tagOf(200, { data: null, errors: [{ type: "NOT_FOUND", message: "x" }] }),
      "NotFound",
    );
    assert.equal(
      tagOf(200, { errors: [{ type: "RATE_LIMITED", message: "slow down" }] }),
      "RateLimited",
    );
    assert.equal(
      tagOf(
        200,
        { errors: [{ message: "API rate limit exceeded" }] },
        { "x-ratelimit-remaining": "0" },
      ),
      "RateLimited",
    );
    assert.equal(tagOf(200, { errors: [{ type: "FORBIDDEN", message: "no" }] }), "Failed");
    assert.equal(tagOf(401, { message: "Bad credentials" }), "Unauthorized");
    assert.equal(tagOf(502, ""), "Failed");
  });
});
