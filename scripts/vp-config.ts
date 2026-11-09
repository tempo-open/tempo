// @effect-diagnostics nodeBuiltinImport:off - a `prepare` step that only runs git and vp.
/**
 * tempo: runs `vp config` for the `prepare` script. `vp config` points git's `core.hooksPath` at this
 * checkout's `.vite-hooks`, right only when Tempo is its repository's root. In a bigger repository
 * (Tempo in a folder of it) that repository owns the hooks, and taking `core.hooksPath` would silently
 * switch them off, so hooks are skipped.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

const root = NodePath.dirname(import.meta.dirname);
const prefix = NodeChildProcess.spawnSync("git", ["rev-parse", "--show-prefix"], {
  cwd: root,
  encoding: "utf8",
});
const isFolderOfRepository = prefix.status === 0 && prefix.stdout.trim().length > 0;

// `shell` resolves `vp` through PATH, including Windows command shims.
const config = NodeChildProcess.spawnSync(
  `vp config --no-agent${isFolderOfRepository ? " --no-hooks" : ""}`,
  { cwd: root, shell: true, stdio: "inherit" },
);
process.exit(config.status ?? 1);
