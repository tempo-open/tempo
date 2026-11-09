// @effect-diagnostics nodeBuiltinImport:off - builds real upstream and monorepo git repositories on disk.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeChildProcess from "node:child_process";

import { parseApplyFailures, syncUpstream, UPSTREAM_RECORD_FILE } from "./upstream-sync.ts";

type Files = Readonly<Record<string, string | null>>;

/** T3 Code at the last synced tag. */
const BASE: Files = {
  "keep.txt": "a\nb\nc\n",
  "shared.txt": "one\n",
  "gone.txt": "x\n",
  ".github/workflows/ci.yml": "wf\n",
  ".repos/ref/README": "r\n",
};

/** What T3 Code changed by the next tag. */
const NEXT: Files = {
  "keep.txt": "a\nb\nc\nd\n",
  "shared.txt": "upstream\n",
  "gone.txt": "x\ny\n",
  "added.txt": "new\n",
  ".github/workflows/ci.yml": "wf2\n",
  ".repos/ref/README": "r2\n",
};

/** Runs git for fixtures, never signing and with a fixed identity. */
function git(cwd: string, ...args: ReadonlyArray<string>): string {
  return NodeChildProcess.execFileSync(
    "git",
    [
      "-c",
      "user.name=t3",
      "-c",
      "user.email=t3@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    { cwd, encoding: "utf8", stdio: "pipe" },
  );
}

/** Writes each file; `null` leaves it absent. */
const writeFiles = Effect.fn("writeFiles")(function* (dir: string, files: Files) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(dir, file);
    if (content === null) {
      yield* fs.remove(target, { force: true });
      continue;
    }
    yield* fs.makeDirectory(path.dirname(target), { recursive: true });
    yield* fs.writeFileString(target, content);
  }
});

/**
 * A T3 Code repository tagged `v1` (BASE) and `v2` (NEXT), and a monorepo
 * holding Tempo in `app/`: a snapshot of `v1` without `.repos/`, with no shared
 * history, plus Tempo's own edits.
 */
const makeFixture = Effect.fn("makeFixture")(function* (tempoEdits: Files) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "upstream-sync-" });
  const t3 = path.join(tempDir, "t3code");
  const mono = path.join(tempDir, "mono");
  const tempo = path.join(mono, "app");

  yield* fs.makeDirectory(t3);
  git(t3, "init", "--quiet");
  yield* writeFiles(t3, BASE);
  git(t3, "add", "--all");
  git(t3, "commit", "--quiet", "-m", "base");
  git(t3, "tag", "v1");
  yield* writeFiles(t3, NEXT);
  git(t3, "add", "--all");
  git(t3, "commit", "--quiet", "-m", "next");
  git(t3, "tag", "-a", "-m", "next", "v2");

  yield* fs.makeDirectory(tempo, { recursive: true });
  git(mono, "init", "--quiet");
  yield* writeFiles(mono, { "README.md": "mono\n" });
  yield* writeFiles(tempo, { ...BASE, ".repos/ref/README": null, ...tempoEdits });
  yield* fs.writeFileString(
    path.join(tempo, UPSTREAM_RECORD_FILE),
    `${JSON.stringify(
      {
        repository: (yield* path.toFileUrl(t3)).href,
        tag: "v1",
        commit: git(t3, "rev-parse", "v1").trim(),
      },
      null,
      2,
    )}\n`,
  );
  git(mono, "add", "--all");
  git(mono, "commit", "--quiet", "-m", "import tempo");

  return { t3, mono, tempo };
});

it.layer(NodeServices.layer)("upstream-sync", (it) => {
  it.effect("applies the next tag's diff cleanly under Tempo's folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { t3, mono, tempo } = yield* makeFixture({ "tempo-only.txt": "ours\n" });

      const result = yield* syncUpstream({ root: tempo, to: "v2" });

      if (result.status !== "applied") return assert.fail(`Unexpected status: ${result.status}`);
      assert.deepStrictEqual(result.conflicts, []);
      assert.deepStrictEqual(result.skipped, []);
      assert.deepStrictEqual(result.githubChanges, ["M\t.github/workflows/ci.yml"]);
      const read = (file: string) => fs.readFileString(path.join(tempo, file));
      assert.equal(yield* read("keep.txt"), "a\nb\nc\nd\n");
      assert.equal(yield* read("shared.txt"), "upstream\n");
      assert.equal(yield* read("added.txt"), "new\n");
      assert.equal(yield* read("tempo-only.txt"), "ours\n");
      // Workflows are ported by hand and reference repos are fetched, so neither is applied.
      assert.equal(yield* read(".github/workflows/ci.yml"), "wf\n");
      assert.isFalse(yield* fs.exists(path.join(tempo, ".repos")));
      assert.isFalse(yield* fs.exists(path.join(mono, "keep.txt")));

      assert.deepStrictEqual(JSON.parse(yield* read(UPSTREAM_RECORD_FILE)), {
        repository: (yield* path.toFileUrl(t3)).href,
        tag: "v2",
        commit: git(t3, "rev-parse", "v2^{commit}").trim(),
      });
      assert.deepStrictEqual(
        git(mono, "diff", "--cached", "--name-only").trim().split("\n"),
        [
          "app/added.txt",
          "app/keep.txt",
          "app/shared.txt",
          "app/gone.txt",
          `app/${UPSTREAM_RECORD_FILE}`,
        ].sort(),
      );
    }),
  );

  it.effect("leaves conflicts to resolve and applies everything else", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { tempo } = yield* makeFixture({ "shared.txt": "tempo\n", "gone.txt": null });

      const result = yield* syncUpstream({ root: tempo, to: "v2" });

      if (result.status !== "applied") return assert.fail(`Unexpected status: ${result.status}`);
      assert.deepStrictEqual(result.conflicts, ["app/shared.txt"]);
      const shared = yield* fs.readFileString(path.join(tempo, "shared.txt"));
      assert.include(shared, "<<<<<<<");
      assert.include(shared, "tempo\n");
      assert.include(shared, "upstream\n");
      // A merge reports a file Tempo deleted and upstream changed as one conflict;
      // git apply refuses it, so it is reported and the rest still applies.
      assert.deepStrictEqual(result.skipped, [
        { status: "M", path: "app/gone.txt", reason: "does not exist in index" },
      ]);
      assert.isFalse(yield* fs.exists(path.join(tempo, "gone.txt")));
      assert.equal(yield* fs.readFileString(path.join(tempo, "keep.txt")), "a\nb\nc\nd\n");
      assert.equal(
        JSON.parse(yield* fs.readFileString(path.join(tempo, UPSTREAM_RECORD_FILE))).tag,
        "v2",
      );
    }),
  );

  it.effect("refuses a dirty tree before fetching anything", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { mono, tempo } = yield* makeFixture({});
      yield* fs.writeFileString(path.join(mono, "README.md"), "edited\n");

      const error = yield* syncUpstream({ root: tempo, to: "v2" }).pipe(Effect.flip);

      assert.equal(error._tag, "UpstreamDirtyTreeError");
      assert.equal(git(mono, "for-each-ref", "refs/t3code-upstream/"), "");
      assert.equal(
        JSON.parse(yield* fs.readFileString(path.join(tempo, UPSTREAM_RECORD_FILE))).tag,
        "v1",
      );
    }),
  );

  it.effect("reads the paths git apply refused", () =>
    Effect.sync(() =>
      assert.deepStrictEqual(
        parseApplyFailures(
          [
            "error: app/a.txt: does not exist in index",
            "Falling back to direct application...",
            "error: patch failed: app/b.txt:1",
            "error: app/b.txt: patch does not apply",
            "Applied patch to 'app/c.txt' cleanly.",
          ].join("\n"),
        ),
        [
          { path: "app/a.txt", reason: "does not exist in index" },
          { path: "app/b.txt", reason: "patch does not apply" },
        ],
      ),
    ),
  );
});
