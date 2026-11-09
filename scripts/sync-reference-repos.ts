#!/usr/bin/env node
/**
 * tempo: fetches the untracked reference repositories under `.repos/` (upstream's git subtree tracked
 * 150 MB, too much to commit here). Each `.repos/<id>` is a plain copy of one ref with a stamp
 * naming it, so a checkout at its pinned version is left alone. Downloads go to one shared bare
 * repo per reference under `~/.cache/tempo/reference-repos`; later worktrees clone it locally.
 */

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Command, Flag } from "effect/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { fromYaml } from "@t3tools/shared/schemaYaml";

import { referenceRepos, type ReferenceRepo } from "./lib/reference-repos.ts";

/** Names the ref a `.repos/<id>` copy was taken from. */
export const REFERENCE_REPO_STAMP_FILE = ".synced-ref";

export type ReferenceRepoSyncAction = "current" | "fetch";

export interface ReferenceRepoSyncOptions {
  readonly rootDir?: string | undefined;
  readonly cacheDir?: string | undefined;
  readonly repoId?: string | undefined;
  readonly latest?: boolean | undefined;
  readonly dryRun?: boolean | undefined;
}

export interface ReferenceRepoSyncPlan {
  readonly repo: ReferenceRepo;
  readonly action: ReferenceRepoSyncAction;
  readonly ref: string;
  /** `ref` is the repo's moving `latestRef` branch rather than a version tag. */
  readonly latest: boolean;
}

export class ReferenceRepoSelectionError extends Schema.TaggedError<ReferenceRepoSelectionError>()(
  "ReferenceRepoSelectionError",
  {
    repoId: Schema.String,
    expectedRepoIds: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `Unknown reference repo "${this.repoId}". Expected one of: ${this.expectedRepoIds.join(", ")}.`;
  }
}

export class ReferenceRepoVersionSourceError extends Schema.TaggedError<ReferenceRepoVersionSourceError>()(
  "ReferenceRepoVersionSourceError",
  {
    operation: Schema.Literals(["read", "parse"]),
    repoId: Schema.String,
    sourcePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Reference repo "${this.repoId}" version source operation "${this.operation}" failed for ${this.sourcePath}.`;
  }
}

export class ReferenceRepoVersionResolutionError extends Schema.TaggedError<ReferenceRepoVersionResolutionError>()(
  "ReferenceRepoVersionResolutionError",
  {
    repoId: Schema.String,
    sourcePath: Schema.String,
    packageVersionPath: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return `No version was found for reference repo "${this.repoId}" at ${this.sourcePath}:${this.packageVersionPath.join(".")}.`;
  }
}

export class ReferenceRepoGitError extends Schema.TaggedError<ReferenceRepoGitError>()(
  "ReferenceRepoGitError",
  {
    operation: Schema.Literals(["spawn", "communicate", "exit"]),
    step: Schema.Literals(["init", "check", "fetch", "clone"]),
    repoId: Schema.String,
    repository: Schema.String,
    ref: Schema.String,
    argumentCount: Schema.Number,
    exitCode: Schema.optional(Schema.Number),
    stdoutLength: Schema.optional(Schema.Number),
    stderrLength: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Git ${this.step} for reference repo "${this.repoId}" at ${this.ref} failed during "${this.operation}".`;
  }
}

export class ReferenceRepoFileSystemError extends Schema.TaggedError<ReferenceRepoFileSystemError>()(
  "ReferenceRepoFileSystemError",
  {
    repoId: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Reference repo "${this.repoId}" could not update ${this.path}.`;
  }
}

export type ReferenceRepoSyncError =
  | ReferenceRepoSelectionError
  | ReferenceRepoVersionSourceError
  | ReferenceRepoVersionResolutionError
  | ReferenceRepoGitError
  | ReferenceRepoFileSystemError;

const decodeJsonSource = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const decodeYamlSource = Schema.decodeEffect(fromYaml(Schema.Unknown));

const collectStreamAsString = <E>(stream: Stream.Stream<Uint8Array, E>): Effect.Effect<string, E> =>
  stream.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (acc, chunk) => acc + chunk,
    ),
  );

function readNestedString(input: unknown, keys: ReadonlyArray<string>): string | undefined {
  let value = input;
  for (const key of keys) {
    if (typeof value !== "object" || value === null || !(key in value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[key];
  }
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function decodeVersionSource(
  repo: ReferenceRepo,
  sourcePath: string,
  content: string,
): Effect.Effect<unknown, ReferenceRepoSyncError> {
  const decode =
    repo.versionSourcePath.endsWith(".yaml") || repo.versionSourcePath.endsWith(".yml")
      ? decodeYamlSource
      : decodeJsonSource;
  return decode(content).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoVersionSourceError({
          operation: "parse",
          repoId: repo.id,
          sourcePath,
          cause,
        }),
    ),
  );
}

function getSelectedRepos(
  repoId: string | undefined,
): Effect.Effect<ReadonlyArray<ReferenceRepo>, ReferenceRepoSyncError> {
  if (!repoId) {
    return Effect.succeed(referenceRepos);
  }

  const repo = referenceRepos.find((candidate) => candidate.id === repoId);
  return repo
    ? Effect.succeed([repo])
    : Effect.fail(
        new ReferenceRepoSelectionError({
          repoId,
          expectedRepoIds: referenceRepos.map((candidate) => candidate.id),
        }),
      );
}

export const resolveReferenceRepoRef = Effect.fn("resolveReferenceRepoRef")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  if (latest) {
    return repo.latestRef;
  }

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const versionSourcePath = path.join(rootDir, repo.versionSourcePath);
  const versionSourceContent = yield* fs.readFileString(versionSourcePath).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoVersionSourceError({
          operation: "read",
          repoId: repo.id,
          sourcePath: versionSourcePath,
          cause,
        }),
    ),
  );
  const versionSource = yield* decodeVersionSource(repo, versionSourcePath, versionSourceContent);
  const version = readNestedString(versionSource, repo.packageVersionPath);

  if (!version) {
    return yield* new ReferenceRepoVersionResolutionError({
      repoId: repo.id,
      sourcePath: versionSourcePath,
      packageVersionPath: repo.packageVersionPath,
    });
  }

  return `${repo.versionTagPrefix}${version}`;
});

export const planReferenceRepoSync = Effect.fn("planReferenceRepoSync")(function* (
  repo: ReferenceRepo,
  rootDir: string,
  latest: boolean,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const ref = yield* resolveReferenceRepoRef(repo, rootDir, latest);
  const stamp = yield* fs
    .readFileString(path.join(rootDir, repo.prefix, REFERENCE_REPO_STAMP_FILE))
    .pipe(
      Effect.map((content) => content.trim()),
      Effect.orElseSucceed(() => undefined),
    );
  // A branch moves, so `--latest` always fetches.
  const action: ReferenceRepoSyncAction = !latest && stamp === ref ? "current" : "fetch";

  return { repo, action, ref, latest } satisfies ReferenceRepoSyncPlan;
});

/** `~/.cache/tempo/reference-repos`, shared by every checkout on the machine. */
const defaultReferenceRepoCacheDir = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(yield* HostProcess.HomeDirectory, ".cache", "tempo", "reference-repos");
});

const runGit = Effect.fn("runGit")(function* (
  plan: ReferenceRepoSyncPlan,
  step: ReferenceRepoGitError["step"],
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const errorContext = {
    step,
    repoId: plan.repo.id,
    repository: plan.repo.repository,
    ref: plan.ref,
    argumentCount: args.length,
  } as const;
  const child = yield* spawner.spawn(ChildProcess.make("git", args)).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoGitError({
          ...errorContext,
          operation: "spawn",
          cause,
        }),
    ),
  );
  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      collectStreamAsString(child.stdout),
      collectStreamAsString(child.stderr),
      child.exitCode.pipe(Effect.map(Number)),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.mapError(
      (cause) =>
        new ReferenceRepoGitError({
          ...errorContext,
          operation: "communicate",
          cause,
        }),
    ),
  );

  if (exitCode !== 0) {
    // Git's own words say why (offline, unknown tag); the error keeps none of them.
    if (stderr.trim().length > 0) {
      yield* Console.error(stderr.trim());
    }
    return yield* new ReferenceRepoGitError({
      ...errorContext,
      operation: "exit",
      exitCode,
      stdoutLength: stdout.length,
      stderrLength: stderr.length,
    });
  }

  return stdout;
}, Effect.scoped);

/**
 * Brings `plan.ref` into the shared cache unless it is already there, then
 * replaces `.repos/<id>` with a local clone of it, stripped of its `.git`.
 * The clone is staged beside the destination, so an interrupted sync leaves
 * the previous copy (or nothing) rather than half a tree.
 */
export const materializeReferenceRepo = Effect.fn("materializeReferenceRepo")(function* (
  plan: ReferenceRepoSyncPlan,
  rootDir: string,
  cacheDir: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const atPath =
    (target: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new ReferenceRepoFileSystemError({ repoId: plan.repo.id, path: target, cause }),
        ),
      );

  const cache = path.join(cacheDir, `${plan.repo.id}.git`);
  if (!(yield* fs.exists(cache).pipe(atPath(cache)))) {
    yield* fs.makeDirectory(cacheDir, { recursive: true }).pipe(atPath(cacheDir));
    yield* runGit(plan, "init", ["init", "--bare", "--quiet", cache]);
  }
  // A version tag never moves, so once cached it is never downloaded again.
  const cachedRef = plan.latest ? `refs/heads/${plan.ref}` : `refs/tags/${plan.ref}`;
  const cached = yield* runGit(plan, "check", [
    "--git-dir",
    cache,
    "for-each-ref",
    "--format=%(refname)",
    cachedRef,
  ]);
  if (plan.latest || cached.trim() !== cachedRef) {
    yield* runGit(plan, "fetch", [
      "--git-dir",
      cache,
      "fetch",
      "--quiet",
      "--depth=1",
      "--no-tags",
      "--force",
      plan.repo.repository,
      `${cachedRef}:${cachedRef}`,
    ]);
  }

  const target = path.join(rootDir, plan.repo.prefix);
  const staging = `${target}.partial`;
  yield* fs.remove(staging, { recursive: true, force: true }).pipe(atPath(staging));
  yield* runGit(plan, "clone", [
    "-c",
    "advice.detachedHead=false",
    "clone",
    "--quiet",
    "--depth=1",
    "--branch",
    plan.ref,
    (yield* path.toFileUrl(cache).pipe(atPath(cache))).href,
    staging,
  ]);
  yield* fs.remove(path.join(staging, ".git"), { recursive: true }).pipe(atPath(staging));
  yield* fs
    .writeFileString(path.join(staging, REFERENCE_REPO_STAMP_FILE), `${plan.ref}\n`)
    .pipe(atPath(staging));
  yield* fs.remove(target, { recursive: true, force: true }).pipe(atPath(target));
  yield* fs.rename(staging, target).pipe(atPath(target));
});

export const syncReferenceRepos = Effect.fn("syncReferenceRepos")(function* (
  options: ReferenceRepoSyncOptions = {},
) {
  const path = yield* Path.Path;
  // tempo: this script's checkout, from wherever it runs, also when Tempo is a folder of a bigger repository.
  const rootDir =
    options.rootDir !== undefined
      ? path.resolve(options.rootDir)
      : yield* path.fromFileUrl(new URL("..", import.meta.url)).pipe(Effect.orDie);
  const cacheDir = options.cacheDir ?? (yield* defaultReferenceRepoCacheDir);
  const repos = yield* getSelectedRepos(options.repoId);
  const plans: Array<ReferenceRepoSyncPlan> = [];

  for (const repo of repos) {
    const plan = yield* planReferenceRepoSync(repo, rootDir, options.latest ?? false);
    plans.push(plan);
    if (plan.action === "current") {
      yield* Console.log(`${repo.prefix} is already at ${plan.ref}.`);
      continue;
    }
    yield* Console.log(`Fetching ${repo.id} at ${plan.ref} into ${repo.prefix}.`);
    if (!(options.dryRun ?? false)) {
      yield* materializeReferenceRepo(plan, rootDir, cacheDir);
    }
  }

  return plans;
});

export const syncReferenceReposCommand = Command.make(
  "sync-reference-repos",
  {
    repo: Flag.String("repo").pipe(
      Flag.withDescription("Sync only the named reference repo. Defaults to all configured repos."),
      Flag.optional,
    ),
    latest: Flag.Boolean("latest").pipe(
      Flag.withDescription(
        "Sync each repo from its latest branch instead of the installed version.",
      ),
      Flag.withDefault(false),
    ),
    root: Flag.String("root").pipe(
      Flag.withDescription(
        "Workspace root used to resolve versions and the .repos/ folder. Defaults to this script's checkout.",
      ),
      Flag.optional,
    ),
    dryRun: Flag.Boolean("dry-run").pipe(
      Flag.withDescription("Print which repos would be fetched without fetching them."),
      Flag.withDefault(false),
    ),
  },
  ({ repo, latest, root, dryRun }) =>
    syncReferenceRepos({
      repoId: Option.getOrUndefined(repo),
      rootDir: Option.getOrUndefined(root),
      latest,
      dryRun,
    }),
).pipe(Command.withDescription("Fetch the reference repositories under .repos/."));

if (import.meta.main) {
  Command.run(syncReferenceReposCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
