import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerSettings from "../serverSettings.ts";
import * as ClaudeSavedWorkflows from "./ClaudeSavedWorkflows.ts";
import { InstructionProviderInstances } from "./InstructionRoots.ts";

const REVIEW_SCRIPT = `export const meta = {
  name: 'review',
  description: "Review the diff with three critics", // header comment
  phases: [{ title: 'Read' }, { title: \`Critique\` }, 'Merge'],
};
export default async function () {
  await agent("unused");
}
`;

describe("ClaudeSavedWorkflows", () => {
  it.effect("lists the main checkout's workflows and the instance's user workflows", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-saved-workflows-" });
      const main = path.join(root, "repo");
      const worktree = path.join(root, "repo-feature");
      const claudeHome = path.join(root, "claude-home");
      yield* fileSystem.makeDirectory(path.join(main, ".git", "worktrees", "feature"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(path.join(main, ".claude", "workflows"), {
        recursive: true,
      });
      yield* fileSystem.makeDirectory(worktree, { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(worktree, ".git"),
        `gitdir: ${path.join(main, ".git", "worktrees", "feature")}\n`,
      );
      yield* fileSystem.writeFileString(
        path.join(main, ".claude", "workflows", "review.js"),
        REVIEW_SCRIPT,
      );
      yield* fileSystem.writeFileString(
        path.join(main, ".claude", "workflows", "notes.md"),
        "not a workflow",
      );
      yield* fileSystem.makeDirectory(path.join(claudeHome, "workflows"), { recursive: true });
      yield* fileSystem.writeFileString(
        path.join(claudeHome, "workflows", "triage.js"),
        "// no meta header\nexport default async () => {};\n",
      );
      yield* fileSystem.writeFileString(
        path.join(claudeHome, "workflows", "review.js"),
        "export const meta = { name: 'review', phases: [] };",
      );

      const instanceId = ProviderInstanceId.make("claude-second");
      const result = yield* Effect.gen(function* () {
        const service = yield* ClaudeSavedWorkflows.ClaudeSavedWorkflows;
        return yield* service.list({ cwd: worktree, instanceId });
      }).pipe(
        Effect.provide(
          ClaudeSavedWorkflows.layer.pipe(
            Layer.provide(InstructionProviderInstances.layer),
            Layer.provide(
              ServerSettings.layerTest({
                providerInstances: {
                  [instanceId]: {
                    driver: ProviderDriverKind.make("claudeAgent"),
                    config: { homePath: claudeHome },
                  },
                },
              }),
            ),
          ),
        ),
      );

      assert.deepEqual(result.workflows, [
        {
          name: "review",
          description: "Review the diff with three critics",
          phases: ["Read", "Critique", "Merge"],
          scope: "project",
          path: path.join(main, ".claude", "workflows", "review.js"),
        },
        {
          name: "triage",
          phases: [],
          scope: "user",
          path: path.join(claudeHome, "workflows", "triage.js"),
        },
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "reads user workflows from the home the instance launches with, not settings.json",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "tempo-saved-workflows-",
        });
        const managedHome = path.join(root, "provider-homes", "claude");
        const personalHome = path.join(root, "personal-claude");
        for (const [home, name] of [
          [managedHome, "managed"],
          [personalHome, "personal"],
        ] as const) {
          yield* fileSystem.makeDirectory(path.join(home, "workflows"), { recursive: true });
          yield* fileSystem.writeFileString(
            path.join(home, "workflows", `${name}.js`),
            "export default async () => {};\n",
          );
        }
        const instanceId = ProviderInstanceId.make("claudeAgent");
        const claude = {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: managedHome },
        };
        const result = yield* Effect.gen(function* () {
          const service = yield* ClaudeSavedWorkflows.ClaudeSavedWorkflows;
          return yield* service.list({ cwd: root });
        }).pipe(
          Effect.provide(
            ClaudeSavedWorkflows.layer.pipe(
              // tempo's policy ignores the saved homePath and launches from its own home.
              Layer.provide(
                InstructionProviderInstances.layerFrom(() =>
                  Effect.succeed({ [instanceId]: claude }),
                ),
              ),
              Layer.provide(
                ServerSettings.layerTest({
                  providerInstances: {
                    [instanceId]: { ...claude, config: { homePath: personalHome } },
                  },
                }),
              ),
            ),
          ),
        );

        assert.deepEqual(
          result.workflows.map((workflow) => workflow.path),
          [path.join(managedHome, "workflows", "managed.js")],
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
