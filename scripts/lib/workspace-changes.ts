// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
// Maps changed files to the workspace packages they affect, with their dependents.
// Unknown paths affect every package.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const root = NodePath.resolve(import.meta.dirname, "../..");

export interface WorkspacePackage {
  readonly name: string;
  readonly dir: string;
  readonly deps: ReadonlyArray<string>;
}

const INERT = [
  /^docs\//,
  /^\.(agents|cursor|vscode|devcontainer|macroscope|repos|github)\//,
  /^[^/]+\.md$/,
  /^LICENSE$/,
];

// Shared test setup affects every package.
const RUNS_EVERYTHING = [/^packages\/shared\/src\/(HostProcess|testing\/longTempDir)\.ts$/];

// Includes cross-package reads absent from package.json dependencies.
const EXTRA_OWNERS: ReadonlyArray<readonly [RegExp, ReadonlyArray<string>]> = [
  // Vite configs and tsconfigs of these apps import scripts/lib directly.
  [/^scripts\/lib\//, ["@t3tools/desktop", "@t3tools/web", "t3"]],
  // scripts/build-desktop-artifact.ts reads the GNOME extension manifest.
  [/^apps\/desktop\/gnome-extension\//, ["@t3tools/scripts"]],
  [/^native\/browser-secret\//, ["@t3tools/desktop"]],
  [/^native\/kde-snap-shot\//, ["@t3tools/desktop"]],
  [/^native\/libghostty-vt\//, ["@t3tools/web"]],
];
const RUST = /^native\/(resource-monitor|kde-snap-shot|hyprland-snap-shot)\//;

// These tests read other packages without declaring dependencies.
const TEST_ONLY_DEPS: Readonly<Record<string, ReadonlyArray<string>>> = {
  // Evals import the server's source to test its real model-facing text.
  "@t3tools/evals": ["t3"],
  "@t3tools/provider-pi": ["@t3tools/client-runtime"],
  "@t3tools/scripts": ["@t3tools/desktop", "@t3tools/web", "t3", "@t3tools/provider-cursor"],
};
// The server bundles the web build without importing it.
const BUILD_ONLY_DEPS: Readonly<Record<string, ReadonlyArray<string>>> = { t3: ["@t3tools/web"] };

export function readWorkspace(): ReadonlyArray<WorkspacePackage> {
  const patterns: Array<string> = [];
  let inPackages = false;
  for (const line of NodeFS.readFileSync(NodePath.join(root, "pnpm-workspace.yaml"), "utf8").split(
    "\n",
  )) {
    if (/^\S/.test(line)) inPackages = line.startsWith("packages:");
    const entry = inPackages && line.match(/^\s+-\s+["']?([^"'\s]+)/);
    if (entry) patterns.push(entry[1]!);
  }

  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return NodeFS.readdirSync(NodePath.join(root, parent)).map((name) => `${parent}/${name}`);
  });

  return dirs.flatMap((dir) => {
    const manifestPath = NodePath.join(root, dir, "package.json");
    if (!NodeFS.existsSync(manifestPath)) return [];
    const manifest = JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as {
      readonly name: string;
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
      readonly peerDependencies?: Record<string, string>;
    };
    const deps = {
      ...manifest.dependencies,
      ...manifest.devDependencies,
      ...manifest.peerDependencies,
    };
    return [
      {
        name: manifest.name,
        dir,
        deps: Object.keys(deps).filter(
          (dep) =>
            String(deps[dep]).startsWith("workspace:") &&
            !BUILD_ONLY_DEPS[manifest.name]?.includes(dep),
        ),
      },
    ];
  });
}

// [] means inert; null means unknown and affects every package.
function ownersOf(
  file: string,
  packages: ReadonlyArray<WorkspacePackage>,
): ReadonlyArray<string> | null {
  if (INERT.some((pattern) => pattern.test(file))) return [];
  // A manifest can change dependencies or versions other packages read.
  if (NodePath.posix.basename(file) === "package.json") return null;
  if (RUNS_EVERYTHING.some((pattern) => pattern.test(file))) return null;
  const extra = EXTRA_OWNERS.flatMap(([pattern, names]) => (pattern.test(file) ? names : []));
  // scripts/build-desktop-artifact.test.ts reads the crates' sources.
  if (RUST.test(file)) return ["@t3tools/scripts", ...extra];

  const owner = packages
    .filter((pkg) => file.startsWith(`${pkg.dir}/`))
    .toSorted((a, b) => b.dir.length - a.dir.length)[0];
  if (owner) return [owner.name, ...extra];
  return extra.length > 0 ? extra : null;
}

export function affectedPackages(
  files: ReadonlyArray<string>,
  packages: ReadonlyArray<WorkspacePackage>,
): ReadonlyArray<string> {
  const affected = new Set<string>();
  for (const file of files) {
    const owners = ownersOf(file, packages);
    if (owners === null) {
      console.error(`Affects every package: ${file}`);
      return packages.map((pkg) => pkg.name).toSorted();
    }
    for (const owner of owners) affected.add(owner);
  }

  let grew = true;
  while (grew) {
    grew = false;
    for (const pkg of packages) {
      if (!affected.has(pkg.name) && pkg.deps.some((dep) => affected.has(dep))) {
        affected.add(pkg.name);
        grew = true;
      }
    }
  }
  for (const [name, deps] of Object.entries(TEST_ONLY_DEPS)) {
    if (deps.some((dep) => affected.has(dep))) affected.add(name);
  }
  return [...affected].toSorted();
}
