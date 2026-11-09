import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import { runMigrations } from "../persistence/Migrations.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as MainCheckoutSync from "./mainCheckoutSync.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerGit = Layer.merge(layerVcsProcess, NodeServices.layer);
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const layerService = Layer.mergeAll(
  database,
  layerGit,
  MainCheckoutSync.layer.pipe(Layer.provide(Layer.merge(database, layerGit))),
);

const run = (cwd: string, command: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "mainCheckoutSync.test.run",
      command,
      cwd,
      args,
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });
const git = (cwd: string, args: ReadonlyArray<string>) => run(cwd, "git", args);

const configureIdentity = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.name", "Tempo Test"]);
    yield* git(cwd, ["config", "user.email", "tempo-test@example.com"]);
    yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  });

const commitFile = (cwd: string, file: string, contents: string) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fileSystem.writeFileString(path.join(cwd, file), contents);
    yield* git(cwd, ["add", file]);
    yield* git(cwd, ["commit", "--quiet", "-m", `add ${file}`]);
  });

/** A remote, the project's main checkout cloned from it with a linked worktree, and a teammate's clone. */
const makeRepositories = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-main-checkout-sync-" });
  const remote = path.join(root, "remote.git");
  const teammate = path.join(root, "teammate");
  const main = path.join(root, "main");
  const worktree = path.join(root, "worktree");
  yield* git(root, ["init", "--quiet", "--bare", "--initial-branch=main", remote]);
  yield* git(root, ["init", "--quiet", "--initial-branch=main", teammate]);
  yield* configureIdentity(teammate);
  yield* commitFile(teammate, "README.md", "# repo\n");
  yield* git(teammate, ["remote", "add", "origin", remote]);
  yield* git(teammate, ["push", "--quiet", "-u", "origin", "main"]);
  yield* git(root, ["clone", "--quiet", remote, main]);
  yield* configureIdentity(main);
  yield* git(main, ["worktree", "add", "--quiet", "-b", "feature", worktree]);
  const pushUpstream = (file: string) =>
    commitFile(teammate, file, `${file}\n`).pipe(
      Effect.andThen(git(teammate, ["push", "--quiet", "origin", "main"])),
      Effect.andThen(git(teammate, ["rev-parse", "HEAD"])),
    );
  return { root, remote, main, worktree, pushUpstream };
});

const head = (cwd: string) => git(cwd, ["rev-parse", "HEAD"]);
const fastForward = (root: string, inUse = false) =>
  MainCheckoutSync.fastForwardMainCheckout({ root, inUse: Effect.succeed(inUse) });

describe("fastForwardMainCheckout", () => {
  it.effect("fast-forwards a clean checkout that is behind its upstream", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      const upstream = yield* pushUpstream("skill.md");
      assert.equal(yield* fastForward(main), "fast-forwarded");
      assert.equal(yield* head(main), upstream);
      assert.equal(yield* fastForward(main), "current");
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("uses the remote ref it already has when the fetch fails", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      const upstream = yield* pushUpstream("skill.md");
      yield* git(main, ["fetch", "--quiet", "origin"]);
      yield* git(main, ["remote", "set-url", "origin", "/nonexistent/remote.git"]);
      assert.equal(yield* fastForward(main), "fast-forwarded");
      assert.equal(yield* head(main), upstream);
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves a checkout with tracked changes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      const before = yield* head(main);
      yield* fileSystem.writeFileString(path.join(main, "README.md"), "# edited\n");
      assert.equal(yield* fastForward(main), "tracked-changes");
      assert.equal(yield* head(main), before);
      assert.equal(yield* fileSystem.readFileString(path.join(main, "README.md")), "# edited\n");
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves a checkout with local commits", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      yield* commitFile(main, "local.md", "local\n");
      const before = yield* head(main);
      assert.equal(yield* fastForward(main), "diverged");
      assert.equal(yield* head(main), before);
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves a checkout on another branch", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      yield* git(main, ["switch", "--quiet", "--track", "-c", "other", "origin/main"]);
      const before = yield* head(main);
      assert.equal(yield* fastForward(main), "not-default-branch");
      assert.equal(yield* head(main), before);
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves a checkout with an operation in progress", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      const before = yield* head(main);
      yield* git(main, ["bisect", "start"]);
      assert.equal(yield* fastForward(main), "operation-in-progress");
      assert.equal(yield* head(main), before);
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves a checkout a running thread uses", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      const before = yield* head(main);
      assert.equal(yield* fastForward(main, true), "in-use");
      assert.equal(yield* head(main), before);
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves a checkout with no upstream", () =>
    Effect.gen(function* () {
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      yield* git(main, ["branch", "--quiet", "--unset-upstream"]);
      const before = yield* head(main);
      assert.equal(yield* fastForward(main), "no-upstream");
      assert.equal(yield* head(main), before);
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves the checkout when git refuses to overwrite an untracked file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { main, pushUpstream } = yield* makeRepositories;
      yield* pushUpstream("skill.md");
      const before = yield* head(main);
      yield* fileSystem.writeFileString(path.join(main, "skill.md"), "mine\n");
      assert.equal(yield* fastForward(main), "git-refused");
      assert.equal(yield* head(main), before);
      assert.equal(yield* fileSystem.readFileString(path.join(main, "skill.md")), "mine\n");
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );

  it.effect("leaves the checkout when git refuses to overwrite an ignored file", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { main, pushUpstream } = yield* makeRepositories;
      yield* fileSystem.writeFileString(path.join(main, ".git", "info", "exclude"), "secret.env\n");
      yield* fileSystem.writeFileString(path.join(main, "secret.env"), "mine\n");
      yield* pushUpstream("secret.env");
      const before = yield* head(main);
      assert.equal(yield* fastForward(main), "git-refused");
      assert.equal(yield* head(main), before);
      assert.equal(yield* fileSystem.readFileString(path.join(main, "secret.env")), "mine\n");
    }).pipe(Effect.provide(layerGit), Effect.scoped),
  );
});

describe("MainCheckoutSync.beforeTurn", () => {
  const seedThread = (input: {
    readonly workspaceRoot: string;
    readonly runStatus: string;
    readonly worktreePath?: string;
  }) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const payload = JSON.stringify({ worktreePath: input.worktreePath ?? null });
      yield* sql`
        INSERT INTO projection_projects
          (project_id, title, workspace_root, scripts_json, created_at, updated_at)
        VALUES ('project', 'Project', ${input.workspaceRoot}, '[]', '2026-01-01', '2026-01-01')
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
           created_at, updated_at, payload_json)
        VALUES ('thread-main', 'project', 'Main', 'codex', 'full-access', 'default',
          '2026-01-01', '2026-01-01', ${payload})
      `;
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run-main', 'thread-main', 1, 'codex', ${input.runStatus}, '2026-01-01', '{}')
      `;
    });

  it.effect("leaves the checkout while a thread runs in a folder inside it", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sync = yield* MainCheckoutSync.MainCheckoutSync;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { main, worktree, pushUpstream } = yield* makeRepositories;
      const subfolder = path.join(main, "app");
      yield* fileSystem.makeDirectory(subfolder);
      yield* seedThread({ workspaceRoot: subfolder, runStatus: "running" });
      const before = yield* head(main);
      yield* pushUpstream("skill.md");
      yield* sync.beforeTurn(worktree);
      assert.equal(yield* head(main), before);
    }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect("syncs while the running thread's own worktree sits inside the checkout", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sync = yield* MainCheckoutSync.MainCheckoutSync;
      const path = yield* Path.Path;
      const { main, pushUpstream } = yield* makeRepositories;
      const nested = path.join(main, ".claude", "worktrees", "nested");
      yield* git(main, ["worktree", "add", "--quiet", "-b", "nested", nested]);
      yield* seedThread({ workspaceRoot: main, runStatus: "running", worktreePath: nested });
      const upstream = yield* pushUpstream("skill.md");
      yield* sync.beforeTurn(nested);
      assert.equal(yield* head(main), upstream);
    }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.live("a thread starting in the main checkout waits for an update in flight", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sync = yield* MainCheckoutSync.MainCheckoutSync;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, main, worktree, pushUpstream } = yield* makeRepositories;
      // The post-merge hook holds the update open until the test lets it finish.
      const started = path.join(root, "started");
      const release = path.join(root, "release");
      yield* run(root, "mkfifo", [started, release]);
      const hooks = path.join(main, ".git", "hooks");
      yield* git(main, ["config", "core.hooksPath", hooks]);
      yield* fileSystem.writeFileString(
        path.join(hooks, "post-merge"),
        `#!/bin/sh\necho > '${started}'\nread _ < '${release}'\n`,
      );
      yield* fileSystem.chmod(path.join(hooks, "post-merge"), 0o755);
      const subfolder = path.join(main, "app");
      yield* fileSystem.makeDirectory(subfolder);
      const upstream = yield* pushUpstream("skill.md");

      const updating = yield* Effect.forkChild(sync.beforeTurn(worktree));
      yield* fileSystem.readFileString(started);
      const starting = yield* Effect.forkChild(
        sync.beforeTurn(subfolder).pipe(Effect.andThen(head(main))),
      );
      // Room for a turn that does not wait to finish first; a waiting one never does.
      assert.isTrue(Option.isNone(yield* Fiber.await(starting).pipe(Effect.timeoutOption(500))));
      yield* fileSystem.writeFileString(release, "\n");
      yield* Fiber.join(updating);
      assert.equal(yield* Fiber.join(starting), upstream);
    }).pipe(Effect.provide(layerService), Effect.scoped),
  );

  it.effect("leaves the checkout while a thread runs in it, then syncs once a minute", () =>
    Effect.gen(function* () {
      yield* runMigrations();
      const sync = yield* MainCheckoutSync.MainCheckoutSync;
      const sql = yield* SqlClient.SqlClient;
      const { main, worktree, pushUpstream } = yield* makeRepositories;
      yield* seedThread({ workspaceRoot: main, runStatus: "running" });
      const before = yield* head(main);
      const upstream = yield* pushUpstream("skill.md");

      yield* sync.beforeTurn(worktree);
      assert.equal(yield* head(main), before);

      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed'`;
      yield* sync.beforeTurn(worktree);
      assert.equal(yield* head(main), before, "throttled within the minute");

      yield* TestClock.adjust(MainCheckoutSync.MAIN_CHECKOUT_SYNC_INTERVAL_MS);
      yield* sync.beforeTurn(worktree);
      assert.equal(yield* head(main), upstream);

      // A thread in the checkout itself never syncs it.
      yield* TestClock.adjust(MainCheckoutSync.MAIN_CHECKOUT_SYNC_INTERVAL_MS);
      const next = yield* pushUpstream("hook.md");
      yield* sync.beforeTurn(main);
      assert.notEqual(yield* head(main), next);
    }).pipe(Effect.provide(layerService), Effect.scoped),
  );
});
