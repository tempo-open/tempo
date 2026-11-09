import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { TempoThreadMoveId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import {
  captureMoveGitState,
  chooseMovedBranch,
  deleteMoveRefs,
  moveRefPrefix,
  restoreMoveGitState,
} from "./ThreadMoveGit.ts";

const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerTest = Layer.mergeAll(
  CheckpointStore.layer.pipe(
    Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
  ),
  GitVcsDriver.layer.pipe(Layer.provide(layerVcsProcess)),
  layerVcsProcess,
).pipe(
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "tempo-thread-move-git-test-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "ThreadMoveGit.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });

const configureIdentity = (cwd: string) =>
  Effect.gen(function* () {
    yield* git(cwd, ["config", "user.name", "Tempo Test"]);
    yield* git(cwd, ["config", "user.email", "tempo-test@example.com"]);
    yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  });

/** A bare remote, a source clone with a pushed main, and a target clone of the same remote. */
const makeRepositories = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-thread-move-git-" });
  const remote = path.join(root, "remote.git");
  const source = path.join(root, "source");
  const target = path.join(root, "target");
  yield* git(root, ["init", "--bare", "--initial-branch=main", remote]);
  yield* git(root, ["init", "--initial-branch=main", source]);
  yield* configureIdentity(source);
  yield* fileSystem.writeFileString(path.join(source, "README.md"), "# moved\n");
  yield* git(source, ["add", "README.md"]);
  yield* git(source, ["commit", "-m", "initial"]);
  yield* git(source, ["remote", "add", "origin", remote]);
  yield* git(source, ["push", "--quiet", "origin", "main"]);
  yield* git(root, ["clone", "--quiet", remote, target]);
  yield* configureIdentity(target);
  return { root, remote, source, target };
});

describe("ThreadMoveGit", () => {
  it.effect("carries unpushed commits and uncommitted work without touching the source", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source, target } = yield* makeRepositories;
      yield* git(source, ["switch", "--quiet", "-c", "feature/move"]);
      yield* fileSystem.writeFileString(path.join(source, "feature.txt"), "committed\n");
      yield* git(source, ["add", "feature.txt"]);
      yield* git(source, ["commit", "-m", "feature work"]);
      yield* fileSystem.writeFileString(path.join(source, "README.md"), "# moved\nedited\n");
      yield* fileSystem.writeFileString(path.join(source, "staged.txt"), "staged\n");
      yield* git(source, ["add", "staged.txt"]);
      yield* fileSystem.writeFileString(path.join(source, "untracked.txt"), "untracked\n");

      const statusBefore = yield* git(source, ["status", "--porcelain"]);
      const headBefore = yield* git(source, ["rev-parse", "HEAD"]);
      const moveId = TempoThreadMoveId.make("11111111-2222-4333-8444-555555555555");
      const bundlePath = path.join(root, "repo.bundle");

      const state = yield* captureMoveGitState({
        cwd: source,
        moveId,
        bundlePath,
        bundleFile: "repo.bundle",
      });
      yield* deleteMoveRefs({ cwd: source, moveId });

      assert.equal(state.branch, "feature/move");
      assert.equal(state.headCommit, headBefore);
      assert.isNotNull(state.wipCommit);
      assert.equal(state.bundleFile, "repo.bundle");
      // The user's checkout, index, and branch are exactly as they were.
      assert.equal(yield* git(source, ["status", "--porcelain"]), statusBefore);
      assert.equal(yield* git(source, ["rev-parse", "HEAD"]), headBefore);
      assert.equal(yield* git(source, ["symbolic-ref", "--short", "HEAD"]), "feature/move");
      assert.equal(
        yield* git(source, ["for-each-ref", "--format=%(refname)", moveRefPrefix(moveId)]),
        "",
      );

      const restored = yield* restoreMoveGitState({
        repoCwd: target,
        moveId,
        git: state,
        bundlePath,
        worktreesDirectory: path.join(root, "worktrees"),
        home: null,
      });
      assert.equal(restored.branch, "feature/move");
      assert.equal(yield* git(restored.worktreePath, ["rev-parse", "HEAD"]), headBefore);
      assert.equal(
        yield* git(restored.worktreePath, ["symbolic-ref", "--short", "HEAD"]),
        "feature/move",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(restored.worktreePath, "README.md")),
        "# moved\nedited\n",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(restored.worktreePath, "staged.txt")),
        "staged\n",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(restored.worktreePath, "untracked.txt")),
        "untracked\n",
      );
      // Uncommitted work arrives uncommitted: nothing was committed on the moved branch.
      const movedStatus = (yield* git(restored.worktreePath, ["status", "--porcelain"]))
        .split("\n")
        .map((line) => line.trim())
        .toSorted();
      assert.deepEqual(movedStatus, ["?? staged.txt", "?? untracked.txt", "M README.md"]);
      assert.equal(
        yield* git(target, ["for-each-ref", "--format=%(refname)", moveRefPrefix(moveId)]),
        "",
      );

      // Moving onto a repository where the branch is taken picks a fresh name.
      assert.equal(
        yield* chooseMovedBranch({ cwd: target, preferred: "feature/move" }),
        "feature/move-moved",
      );

      // A failed import undoes the checkout, so a retry does not land on "-moved".
      yield* restored.undo;
      assert.isFalse(yield* fileSystem.exists(restored.worktreePath));
      assert.equal(
        yield* chooseMovedBranch({ cwd: target, preferred: "feature/move" }),
        "feature/move",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("needs no bundle when the remote already has the work", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, source, target } = yield* makeRepositories;
      yield* git(source, ["switch", "--quiet", "-c", "pushed"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "pushed work"]);
      yield* git(source, ["push", "--quiet", "origin", "pushed"]);
      const moveId = TempoThreadMoveId.make("22222222-2222-4333-8444-555555555555");

      const state = yield* captureMoveGitState({
        cwd: source,
        moveId,
        bundlePath: path.join(root, "unused.bundle"),
        bundleFile: "repo.bundle",
      });
      assert.isNull(state.bundleFile);
      assert.isNull(state.wipCommit);

      // The target's clone predates the push, so it fetches the commit from the remote.
      const restored = yield* restoreMoveGitState({
        repoCwd: target,
        moveId,
        git: state,
        bundlePath: null,
        worktreesDirectory: path.join(root, "worktrees"),
        home: null,
      });
      assert.equal(yield* git(restored.worktreePath, ["rev-parse", "HEAD"]), state.headCommit);
      assert.equal(yield* git(restored.worktreePath, ["status", "--porcelain"]), "");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("carries the commits of a branch deleted on the remote", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, remote, source, target } = yield* makeRepositories;
      yield* git(source, ["switch", "--quiet", "-c", "merged"]);
      yield* fileSystem.writeFileString(path.join(source, "merged.txt"), "merged\n");
      yield* git(source, ["add", "merged.txt"]);
      yield* git(source, ["commit", "-m", "merged work"]);
      yield* git(source, ["push", "--quiet", "-u", "origin", "merged"]);
      // The pull request merged and the host deleted its branch; the source never pruned.
      // Git started by the server opens a bare repository only by --git-dir.
      yield* git(root, ["--git-dir", remote, "branch", "-D", "merged"]);
      const moveId = TempoThreadMoveId.make("44444444-2222-4333-8444-555555555555");
      const bundlePath = path.join(root, "repo.bundle");

      const state = yield* captureMoveGitState({
        cwd: source,
        moveId,
        bundlePath,
        bundleFile: "repo.bundle",
      });
      assert.equal(state.bundleFile, "repo.bundle");
      // Capture reads the remote; it leaves the stale ref alone.
      assert.equal(
        yield* git(source, ["rev-parse", "refs/remotes/origin/merged"]),
        state.headCommit,
      );

      const restored = yield* restoreMoveGitState({
        repoCwd: target,
        moveId,
        git: state,
        bundlePath,
        worktreesDirectory: path.join(root, "worktrees"),
        home: null,
      });
      assert.equal(yield* git(restored.worktreePath, ["rev-parse", "HEAD"]), state.headCommit);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("trusts only the default branch of a remote it cannot list", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { root, source } = yield* makeRepositories;
      yield* git(source, ["switch", "--quiet", "-c", "pushed"]);
      yield* git(source, ["commit", "--allow-empty", "-m", "pushed work"]);
      yield* git(source, ["push", "--quiet", "origin", "pushed"]);
      yield* git(source, ["remote", "set-url", "origin", path.join(root, "unreachable.git")]);
      const capture = (moveId: string) =>
        captureMoveGitState({
          cwd: source,
          moveId: TempoThreadMoveId.make(moveId),
          bundlePath: path.join(root, `${moveId}.bundle`),
          bundleFile: "repo.bundle",
        });

      // With no default branch known here, every remote-tracking ref counts, as before.
      const unknownDefault = yield* capture("55555555-2222-4333-8444-555555555555");
      assert.isNull(unknownDefault.bundleFile);

      // Once it is known, only it counts: the pushed branch may be gone, so its commit travels.
      yield* git(source, ["remote", "set-head", "origin", "main"]);
      const knownDefault = yield* capture("66666666-2222-4333-8444-555555555555");
      assert.equal(knownDefault.bundleFile, "repo.bundle");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("refuses a move whose base commits this repository cannot get", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root, source } = yield* makeRepositories;
      yield* fileSystem.writeFileString(path.join(source, "local.txt"), "local\n");
      yield* git(source, ["add", "local.txt"]);
      yield* git(source, ["commit", "-m", "local"]);
      const moveId = TempoThreadMoveId.make("33333333-2222-4333-8444-555555555555");
      const bundlePath = path.join(root, "repo.bundle");
      const state = yield* captureMoveGitState({
        cwd: source,
        moveId,
        bundlePath,
        bundleFile: "repo.bundle",
      });

      const unrelated = path.join(root, "unrelated");
      yield* git(root, ["init", "--initial-branch=main", unrelated]);
      yield* configureIdentity(unrelated);
      yield* git(unrelated, ["commit", "--allow-empty", "-m", "elsewhere"]);
      const error = yield* restoreMoveGitState({
        repoCwd: unrelated,
        moveId,
        git: state,
        bundlePath,
        worktreesDirectory: path.join(root, "worktrees"),
        home: null,
      }).pipe(Effect.flip);
      assert.equal(error._tag, "TempoThreadMoveMissingCommitsError");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
