import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitHubGraphQl from "../GitHubGraphQl.ts";
import * as ProductionDeployments from "./ProductionDeployments.ts";

/** GitHub answering each GraphQL operation with its body, recording what it was asked. */
function gitHubAnswering(bodies: Readonly<Record<string, unknown>>) {
  const asked: Array<GitHubGraphQl.GitHubGraphQlInput> = [];
  const layer = Layer.effect(
    ProductionDeployments.ProductionDeployments,
    ProductionDeployments.makeFor(TARGET),
  ).pipe(
    Layer.provide(
      Layer.mock(GitHubGraphQl.GitHubGraphQl)({
        graphql: (input) =>
          Effect.sync(() => {
            asked.push(input);
            return JSON.stringify(bodies[input.operation]);
          }),
      }),
    ),
  );
  return { asked, layer };
}

const TARGET = {
  host: "github.com",
  owner: "acme",
  repository: "app",
  environment: "production",
  workflow: ".github/workflows/deploy.yml",
} as const;

const runs = "https://github.com/acme/app/actions/runs";

describe("ProductionDeployments", () => {
  it.effect("reads production deployments and, once, the workflow behind each success", () => {
    const github = gitHubAnswering({
      tempoProductionDeployments: {
        data: {
          repository: {
            deployments: {
              nodes: [
                {
                  databaseId: 1001,
                  createdAt: "2026-01-14T17:00:00Z",
                  latestStatus: {
                    state: "SUCCESS",
                    logUrl: `${runs}/2001/job/3001`,
                  },
                },
                {
                  databaseId: 1002,
                  createdAt: "2026-01-11T16:00:00Z",
                  latestStatus: {
                    state: "SUCCESS",
                    logUrl: `${runs}/2002/job/3002`,
                  },
                },
                {
                  databaseId: 1003,
                  createdAt: "2026-01-10T21:00:00Z",
                  latestStatus: {
                    state: "FAILURE",
                    logUrl: `${runs}/2003/job/3003`,
                  },
                },
                {
                  databaseId: 1004,
                  createdAt: "2026-01-10T15:00:00Z",
                  latestStatus: { state: "SUCCESS", logUrl: null },
                },
                { databaseId: 1005, createdAt: "2026-01-08T21:00:00Z", latestStatus: null },
                null,
              ],
            },
          },
        },
      },
      tempoProductionDeploymentWorkflows: {
        data: {
          run0: { file: { path: ".github/workflows/deploy.yml" } },
          run1: { file: { path: ".github/workflows/android-play-bundle.yml" } },
        },
      },
    });
    return Effect.gen(function* () {
      const deployments = yield* ProductionDeployments.ProductionDeployments;
      const expected = [
        {
          id: 1001,
          createdAt: "2026-01-14T17:00:00Z",
          latestState: "success",
          workflow: ".github/workflows/deploy.yml",
        },
        {
          id: 1002,
          createdAt: "2026-01-11T16:00:00Z",
          latestState: "success",
          workflow: ".github/workflows/android-play-bundle.yml",
        },
        {
          id: 1003,
          createdAt: "2026-01-10T21:00:00Z",
          latestState: "failure",
          workflow: null,
        },
        {
          id: 1004,
          createdAt: "2026-01-10T15:00:00Z",
          latestState: "success",
          workflow: null,
        },
        { id: 1005, createdAt: "2026-01-08T21:00:00Z", latestState: null, workflow: null },
      ];
      assert.deepEqual(yield* deployments.recent, expected);
      assert.equal(github.asked[0]?.host, "github.com");
      assert.deepEqual(github.asked[0]?.variables, {
        owner: "acme",
        name: "app",
        environment: "production",
        first: 20,
      });
      // Only successes with a run are asked about, each run once.
      assert.deepEqual(github.asked[1]?.variables, {
        run0: `${runs}/2001`,
        run1: `${runs}/2002`,
      });

      // The next read asks only for the deployments: their workflows are known.
      assert.deepEqual(yield* deployments.recent, expected);
      assert.deepEqual(
        github.asked.map((input) => input.operation),
        [
          "tempoProductionDeployments",
          "tempoProductionDeploymentWorkflows",
          "tempoProductionDeployments",
        ],
      );
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("fails when the credential cannot see the repository", () => {
    const github = gitHubAnswering({ tempoProductionDeployments: { data: { repository: null } } });
    return Effect.gen(function* () {
      const deployments = yield* ProductionDeployments.ProductionDeployments;
      const error = yield* deployments.recent.pipe(Effect.flip);
      assert.instanceOf(error, ProductionDeployments.ProductionDeploymentsReadError);
      assert.isTrue(error.repositoryMissing);
      assert.equal(
        error.message,
        "GitHub did not show acme/app to this machine's GitHub credential.",
      );
    }).pipe(Effect.provide(github.layer));
  });

  it.effect("reads nothing while no production repository is named", () => {
    const layer = Layer.effect(
      ProductionDeployments.ProductionDeployments,
      ProductionDeployments.makeFor(null),
    ).pipe(
      Layer.provide(
        Layer.mock(GitHubGraphQl.GitHubGraphQl)({
          graphql: () => Effect.die("GitHub must not be read"),
        }),
      ),
    );
    return Effect.gen(function* () {
      const deployments = yield* ProductionDeployments.ProductionDeployments;
      assert.isNull(deployments.target);
      assert.deepEqual(yield* deployments.recent, []);
    }).pipe(Effect.provide(layer));
  });
});
