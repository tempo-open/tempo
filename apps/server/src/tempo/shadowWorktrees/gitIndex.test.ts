// @effect-diagnostics nodeBuiltinImport:off -- builds real repositories and stats their files the way git does.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  encodeGitIndex,
  parseStagedEntries,
  writeGitIndexFile,
  type GitIndexEntry,
  type GitObjectFormat,
} from "./gitIndex.ts";

const git = (cwd: string, args: ReadonlyArray<string>) => {
  const result = NodeChildProcess.spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout;
};

const makeRepository = (objectFormat: GitObjectFormat) => {
  const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tempo-git-index-"));
  git(repo, ["init", "--quiet", `--object-format=${objectFormat}`]);
  git(repo, ["config", "user.name", "Tempo Test"]);
  git(repo, ["config", "user.email", "tempo-test@example.com"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  NodeFS.writeFileSync(NodePath.join(repo, "README.md"), "# index\n");
  NodeFS.writeFileSync(NodePath.join(repo, "empty"), "");
  NodeFS.mkdirSync(NodePath.join(repo, "bin"));
  NodeFS.writeFileSync(NodePath.join(repo, "bin", "run.sh"), "#!/bin/sh\necho run\n", {
    mode: 0o755,
  });
  NodeFS.mkdirSync(NodePath.join(repo, "nested", "deeper"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repo, "nested", "deeper", "file.txt"), "deep\n");
  NodeFS.writeFileSync(NodePath.join(repo, "nested-file.txt"), "sorts after nested/\n");
  NodeFS.writeFileSync(NodePath.join(repo, "ünïcode.txt"), "unicode\n");
  NodeFS.symlinkSync("README.md", NodePath.join(repo, "link"));
  git(repo, ["add", "."]);
  git(repo, ["commit", "--quiet", "-m", "initial"]);
  return repo;
};

/** `git ls-tree -r -z`: `<mode> <type> <oid>\t<path>\0`. */
const treeEntries = (repo: string): ReadonlyArray<GitIndexEntry> =>
  git(repo, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const tab = record.indexOf("\t");
      const [mode, , oid] = record.slice(0, tab).split(" ");
      return { mode: Number.parseInt(mode!, 8), oid: oid!, path: record.slice(tab + 1) };
    });

describe("encodeGitIndex", () => {
  it.each(["sha1", "sha256"] as const)(
    "writes an index git finds up to date without hashing (%s)",
    async (objectFormat) => {
      const repo = makeRepository(objectFormat);
      try {
        const expected = git(repo, ["ls-files", "--stage"]);
        NodeFS.rmSync(NodePath.join(repo, ".git", "index"));
        const statted = treeEntries(repo).map((entry) => ({
          entry,
          stats: NodeFS.lstatSync(NodePath.join(repo, entry.path), { bigint: true }),
        }));
        await writeGitIndexFile(
          NodePath.join(repo, ".git", "index"),
          encodeGitIndex(statted, objectFormat),
        );

        // diff-files compares stat data only: any wrong field reports the file.
        const diffFiles = NodeChildProcess.spawnSync("git", ["diff-files", "--quiet"], {
          cwd: repo,
        });
        expect(diffFiles.status).toBe(0);
        expect(git(repo, ["ls-files", "--stage"])).toBe(expected);
        expect(git(repo, ["status", "--porcelain"])).toBe("");
        expect(NodeFS.existsSync(NodePath.join(repo, ".git", "index.lock"))).toBe(false);
      } finally {
        NodeFS.rmSync(repo, { recursive: true, force: true });
      }
    },
  );

  it("refuses to overwrite an index another git command has locked", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tempo-git-index-lock-"));
    try {
      const indexPath = NodePath.join(directory, "index");
      NodeFS.writeFileSync(`${indexPath}.lock`, "");
      await expect(writeGitIndexFile(indexPath, Buffer.from("DIRC"))).rejects.toThrow();
      expect(NodeFS.existsSync(indexPath)).toBe(false);
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("parseStagedEntries", () => {
  it("reads ls-files --stage -z", () => {
    const oid = "a".repeat(40);
    expect(
      parseStagedEntries(`100755 ${oid} 0\tbin/run.sh\u0000120000 ${oid} 0\tlink\u0000`),
    ).toEqual([
      { mode: 0o100755, oid, path: "bin/run.sh" },
      { mode: 0o120000, oid, path: "link" },
    ]);
  });

  it("refuses unmerged entries and unexpected output", () => {
    const oid = "a".repeat(40);
    expect(parseStagedEntries(`100644 ${oid} 2\tconflicted.txt\u0000`)).toBeNull();
    expect(parseStagedEntries("not a listing\u0000")).toBeNull();
  });
});
