/**
 * tempo: hand-written GraphQL documents, sent through the request policy every GitHub request shares.
 * Upstream's GraphQL client sends only generated documents, and tempo's documents change per read
 * (the production deployments' workflow aliases, the activity's date windows).
 */
import { normalizeHost } from "@t3tools/source-control-core/server/pullRequestUtils";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubRequestPolicy from "@t3tools/source-control-github/server/GitHubRequestPolicy";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface GitHubGraphQlInput {
  readonly host: string;
  readonly operation: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}

export class GitHubGraphQl extends Context.Service<
  GitHubGraphQl,
  {
    /** The answer's body, once GitHub's status and `errors` say it is one. */
    readonly graphql: (
      input: GitHubGraphQlInput,
    ) => Effect.Effect<string, GitHubRequestPolicy.GitHubApiError>;
  }
>()("t3/tempo/GitHubGraphQl") {}

const decodeGraphQlErrors = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      errors: Schema.optional(
        Schema.Array(
          Schema.Struct({
            type: Schema.optional(Schema.String),
            message: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
);

/** GitHub fails a GraphQL document with HTTP 200 and an `errors` list, so the body is read too. */
export function classifyGraphQlAnswer(answer: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: string;
}): GitHubRequestPolicy.GitHubAnswer<string> {
  const { status, headers, body } = answer;
  const meta = { status, headers };
  const errors = Option.getOrUndefined(decodeGraphQlErrors(body))?.errors;
  if (
    GitHubRequestPolicy.isRateLimited({
      status,
      headers,
      body,
      ...(errors === undefined ? {} : { graphqlErrors: errors }),
    })
  ) {
    return { _tag: "RateLimited", ...meta };
  }
  if (status === 401) return { _tag: "Unauthorized", ...meta };
  if (
    status === 404 ||
    (errors !== undefined && errors.every(({ type }) => type === "NOT_FOUND"))
  ) {
    return { _tag: "NotFound", ...meta };
  }
  if (errors !== undefined) {
    return {
      _tag: "Failed",
      messages: errors.flatMap(({ message }) => (message === undefined ? [] : [message])),
      ...meta,
    };
  }
  if (status >= 200 && status < 300) return { _tag: "Ok", value: body, ...meta };
  return { _tag: "Failed", ...meta };
}

export const layer = Layer.effect(
  GitHubGraphQl,
  Effect.gen(function* () {
    const policy = yield* GitHubRequestPolicy.GitHubRequestPolicy;
    const httpClient = yield* HttpClient.HttpClient;
    const graphql: GitHubGraphQl["Service"]["graphql"] = Effect.fn("GitHubGraphQl.graphql")(
      function* (input) {
        const host = normalizeHost(input.host);
        return yield* policy.request(
          {
            host,
            operation: input.operation,
            resource: "graphql",
            allowReserve: yield* SourceControlRateLimit.Interactive,
          },
          (headers) =>
            httpClient
              .execute(
                HttpClientRequest.post(GitHubRequestPolicy.gitHubApiUrls(host).graphql).pipe(
                  HttpClientRequest.acceptJson,
                  HttpClientRequest.setHeaders(headers),
                  HttpClientRequest.bodyJsonUnsafe({
                    query: input.query,
                    variables: input.variables,
                  }),
                ),
              )
              .pipe(
                Effect.flatMap((response) =>
                  response.text.pipe(
                    Effect.map((body) =>
                      classifyGraphQlAnswer({
                        status: response.status,
                        headers: response.headers,
                        body,
                      }),
                    ),
                  ),
                ),
                Effect.mapError(
                  (cause) =>
                    new GitHubRequestPolicy.GitHubApiRequestError({
                      host,
                      operation: input.operation,
                      cause,
                    }),
                ),
              ),
        );
      },
    );
    return GitHubGraphQl.of({ graphql });
  }),
);
