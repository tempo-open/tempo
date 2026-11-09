/**
 * tempo: the newest production deployments of the repository TEMPO_PRODUCTION_REPOSITORY names, read
 * through a `GitHubRequestPolicy`. A deployment does not name its workflow, but its latest status
 * links the Actions run, so a second request asks the workflow of each new successful deployment.
 */
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as GitHubGraphQl from "../GitHubGraphQl.ts";
import {
  resolveProductionPromotionTarget,
  type ProductionDeployment,
  type ProductionPromotionTarget,
} from "./productionWaitDecision.ts";

/** Deployments read per sweep. A promotion older than these has a newer one beside it. */
const DEPLOYMENTS_READ = 20;

const QUERY = `query TempoProductionDeployments($owner: String!, $name: String!, $environment: String!, $first: Int!) {
  repository(owner: $owner, name: $name) {
    deployments(environments: [$environment], first: $first, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { databaseId createdAt latestStatus { state logUrl } }
    }
  }
}`;

/** The Actions run a status's log URL (`…/actions/runs/<run>/job/<job>`) belongs to. */
const RUN_URL = /^(https:\/\/[^/]+\/[^/]+\/[^/]+\/actions\/runs\/\d+)(?:[/?#]|$)/;

/** Asks the workflow file of each run in `runUrls`, one alias per run. */
function workflowsQuery(runUrls: ReadonlyArray<string>): string {
  const variables = runUrls.map((_, index) => `$run${index}: URI!`).join(", ");
  const fields = runUrls
    .map(
      (_, index) =>
        `run${index}: resource(url: $run${index}) { ... on WorkflowRun { file { path } } }`,
    )
    .join("\n  ");
  return `query TempoProductionDeploymentWorkflows(${variables}) {\n  ${fields}\n}`;
}

const decodeDeployments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Struct({
        repository: Schema.NullOr(
          Schema.Struct({
            deployments: Schema.Struct({
              nodes: Schema.Array(
                Schema.NullOr(
                  Schema.Struct({
                    databaseId: Schema.NullOr(Schema.Number),
                    createdAt: Schema.String,
                    latestStatus: Schema.NullOr(
                      Schema.Struct({ state: Schema.String, logUrl: Schema.NullOr(Schema.String) }),
                    ),
                  }),
                ),
              ),
            }),
          }),
        ),
      }),
    }),
  ),
);

const decodeWorkflows = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      data: Schema.Record(
        Schema.String,
        // A resource that is not a workflow run answers without `file`.
        Schema.NullOr(
          Schema.Struct({
            file: Schema.optional(Schema.NullOr(Schema.Struct({ path: Schema.String }))),
          }),
        ),
      ),
    }),
  ),
);

export class ProductionDeploymentsReadError extends Schema.TaggedError<ProductionDeploymentsReadError>()(
  "ProductionDeploymentsReadError",
  {
    /** The repository as `owner/name`. */
    repository: Schema.String,
    /** The repository answered as missing: it is gone or the credential cannot see it. */
    repositoryMissing: Schema.Boolean,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return this.repositoryMissing
      ? `GitHub did not show ${this.repository} to this machine's GitHub credential.`
      : `Could not read ${this.repository}'s production deployments from GitHub.`;
  }
}

export class ProductionDeployments extends Context.Service<
  ProductionDeployments,
  {
    /** Whose deployments end a wait; null while Waiting for Production is off here. */
    readonly target: ProductionPromotionTarget | null;
    /** The newest production deployments, newest first; none while `target` is null. */
    readonly recent: Effect.Effect<
      ReadonlyArray<ProductionDeployment>,
      ProductionDeploymentsReadError
    >;
  }
>()("t3/tempo/productionWait/ProductionDeployments") {}

/** @public Reads `target`'s deployments; with a null target it reads nothing. */
export const makeFor = Effect.fn("ProductionDeployments.makeFor")(function* (
  configured: ProductionPromotionTarget | null,
) {
  const github = yield* GitHubGraphQl.GitHubGraphQl;
  if (configured === null) {
    return ProductionDeployments.of({ target: null, recent: Effect.succeed([]) });
  }
  const target = configured;
  const repository = `${target.owner}/${target.repository}`;
  const readFailed = (cause: unknown) =>
    new ProductionDeploymentsReadError({ repository, repositoryMissing: false, cause });
  // The workflow behind each successful deployment still read; it never changes.
  const workflows = new Map<number, string | null>();

  /** Each run's workflow file; a run GitHub does not show maps to null. */
  const workflowFiles = (runUrls: ReadonlyArray<string>) =>
    runUrls.length === 0
      ? Effect.succeed(new Map<string, string | null>())
      : github
          .graphql({
            host: target.host,
            operation: "tempoProductionDeploymentWorkflows",
            query: workflowsQuery(runUrls),
            variables: Object.fromEntries(runUrls.map((url, index) => [`run${index}`, url])),
          })
          .pipe(
            Effect.flatMap(decodeWorkflows),
            Effect.map(
              ({ data }) =>
                new Map(
                  runUrls.map((url, index) => [url, data[`run${index}`]?.file?.path ?? null]),
                ),
            ),
            Effect.mapError(readFailed),
          );

  const recent = Effect.gen(function* () {
    const body = yield* github
      .graphql({
        host: target.host,
        operation: "tempoProductionDeployments",
        query: QUERY,
        variables: {
          owner: target.owner,
          name: target.repository,
          environment: target.environment,
          first: DEPLOYMENTS_READ,
        },
      })
      .pipe(Effect.mapError(readFailed));
    const { data } = yield* decodeDeployments(body).pipe(Effect.mapError(readFailed));
    if (data.repository === null) {
      return yield* new ProductionDeploymentsReadError({ repository, repositoryMissing: true });
    }
    const nodes = data.repository.deployments.nodes.flatMap((node) =>
      node === null || node.databaseId === null ? [] : [{ ...node, id: node.databaseId }],
    );
    // Only a success can be a promotion, so only those need their workflow.
    const unread = nodes.flatMap((node) =>
      node.latestStatus?.state === "SUCCESS" && !workflows.has(node.id)
        ? [{ id: node.id, runUrl: RUN_URL.exec(node.latestStatus.logUrl ?? "")?.[1] ?? null }]
        : [],
    );
    const files = yield* workflowFiles([
      ...new Set(unread.flatMap(({ runUrl }) => (runUrl === null ? [] : [runUrl]))),
    ]);
    for (const { id, runUrl } of unread) {
      const workflow = runUrl === null ? null : (files.get(runUrl) ?? null);
      if (workflow === null) {
        yield* Effect.logWarning("production deployment has no readable workflow run", {
          deploymentId: id,
        });
      }
      workflows.set(id, workflow);
    }
    const read = new Set(nodes.map((node) => node.id));
    for (const id of workflows.keys()) if (!read.has(id)) workflows.delete(id);
    return nodes.map((node): ProductionDeployment => ({
      id: node.id,
      createdAt: node.createdAt,
      latestState: node.latestStatus?.state.toLowerCase() ?? null,
      workflow: workflows.get(node.id) ?? null,
    }));
  }).pipe(Effect.withSpan("ProductionDeployments.recent"));
  return ProductionDeployments.of({ target, recent });
});

/** @public Reads the repository TEMPO_PRODUCTION_REPOSITORY names, if any. */
export const make = Effect.suspend(() => makeFor(resolveProductionPromotionTarget()));

// The GitHub driver now builds its request policy privately, so these reads get their own
// credential and quota view; the rate-limit pause still comes from the server.
export const layer = Layer.effect(ProductionDeployments, make).pipe(
  Layer.provide(GitHubGraphQl.layer),
  Layer.provide(GitHubRest.layerWithDependencies),
);
