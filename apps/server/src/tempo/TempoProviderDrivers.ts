/**
 * Tempo's only two drivers, Claude and Codex, each on this Mac's own sign-in: Claude Code reads its
 * own login (`~/.claude` and its keychain item) and Codex its own `CODEX_HOME`. Children get the host
 * environment minus provider credentials and backend overrides.
 */
import {
  type ClaudeSettings,
  CodexSettings,
  TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT,
  TEMPO_LOCAL_CODEX_SIGN_IN_HINT,
  type ProviderInstallState,
  ProviderDriverKind,
  ProviderSetupError,
  type ServerProvider,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";

import type {
  ProviderDriver,
  ProviderDriverCreateInput,
  ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import * as ModelCatalog from "@t3tools/provider-core/server/ModelCatalog";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ManagedServerProvider } from "@t3tools/provider-core/server/snapshot";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { createCodexAdapterV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import { applyCodexModelCatalog } from "../provider/codexModelCatalog.ts";
import * as CodexInstallation from "../provider/CodexInstallation.ts";
import type { CodexEffectiveRuntime } from "../provider/CodexManagedRuntime.ts";
import {
  checkCodexProviderStatus,
  makePendingCodexProvider,
  probeCodexSkillsForCwd,
} from "../provider/CodexProvider.ts";
import { ClaudeDriver, type ClaudeDriverEnv } from "../provider/Drivers/ClaudeDriver.ts";
import { CodexDriver, type CodexDriverEnv } from "../provider/Drivers/CodexDriver.ts";
import type * as CodexUsageHistory from "../usage/CodexUsageHistory.ts";
import {
  codexContinuationIdentity,
  resolveCodexHomeLayout,
} from "../provider/Drivers/CodexHomeLayout.ts";
import { ProviderDriverError } from "../provider/Errors.ts";
import { makeCodexTextGeneration } from "../textGeneration/CodexTextGeneration.ts";
import { linkPersonalClaudeFoldersInto } from "./ClaudePersonalFolders.ts";
import { linkPersonalCodexSkillsInto } from "./CodexPersonalSkills.ts";
import { sanitizeProviderEnvironment } from "./ProviderPolicy.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const CODEX = ProviderDriverKind.make("codex");
const CLAUDE_NOT_INSTALLED_MESSAGE = `Claude Code is not installed on this environment. Install it with \`npm install -g @anthropic-ai/claude-code\` (or Anthropic's native installer); ${TEMPO_APP_BASE_NAME} finds it on its next check.`;
const CODEX_INSTALLING_MESSAGE = "Installing Codex on this environment…";
// A failed Codex install is retried this often, not on every check.
const CODEX_INSTALL_RETRY_MS = 10 * 60_000;
const decodeCodexSettings = Schema.decodeSync(CodexSettings);

/**
 * How Claude presents itself on this Mac's own sign-in: no in-app setup actions, how to install
 * Claude Code when it is missing, and the command to sign in when Claude Code reports no login.
 */
export function presentLocalClaude(snapshot: ServerProvider): ServerProvider {
  const base: ServerProvider = {
    ...snapshot,
    setup: { canAuthenticate: false, canInstall: false },
  };
  if (base.driver === CLAUDE && !base.installed && base.status === "error") {
    return { ...base, message: CLAUDE_NOT_INSTALLED_MESSAGE };
  }
  return base.auth.status === "unauthenticated"
    ? { ...base, status: "error", message: TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT }
    : base;
}

/** How Codex presents itself on this Mac's own sign-in: no setup actions, and its own account. */
export function presentLocalCodex(snapshot: ServerProvider): ServerProvider {
  const base: ServerProvider = {
    ...snapshot,
    setup: { canAuthenticate: false, canInstall: false },
  };
  return base.auth.status === "unauthenticated"
    ? { ...base, status: "error", message: TEMPO_LOCAL_CODEX_SIGN_IN_HINT }
    : base;
}

const presentManagedProvider = (
  provider: ManagedServerProvider,
  present: (snapshot: ServerProvider) => Effect.Effect<ServerProvider>,
): ManagedServerProvider => ({
  ...provider,
  getSnapshot: Effect.flatMap(provider.getSnapshot, present),
  refresh: Effect.flatMap(provider.refresh, present),
  streamChanges: Stream.mapEffect(provider.streamChanges, present),
});

export type TempoProviderDriversEnv = ClaudeDriverEnv | CodexDriverEnv;

/** Claude on this Mac's own sign-in, with the person's own skills, agents and workflows. */
const makeTempoClaudeInstance = Effect.fn("TempoProviderDrivers.makeTempoClaudeInstance")(
  function* (input: ProviderDriverCreateInput<ClaudeSettings>) {
    const fileSystem = yield* FileSystem.FileSystem;
    if (input.config.homePath.trim() !== "") {
      yield* fileSystem
        .makeDirectory(input.config.homePath, { recursive: true })
        .pipe(Effect.ignore);
      // The person's own skills, commands, agents, workflows and output styles load there too.
      yield* linkPersonalClaudeFoldersInto(input.config.homePath);
    }
    const instance = yield* ClaudeDriver.create(input).pipe(
      Effect.provideService(
        HostProcess.Environment,
        sanitizeProviderEnvironment(yield* HostProcess.Environment),
      ),
    );
    return {
      ...instance,
      snapshot: presentManagedProvider(instance.snapshot, (snapshot) =>
        Effect.succeed(presentLocalClaude(snapshot)),
      ),
      ...(instance.snapshotForCwd === undefined
        ? {}
        : {
            snapshotForCwd: (cwd: string) =>
              instance.snapshotForCwd!(cwd).pipe(
                Effect.map((snapshot) => ({ ...snapshot, ...presentLocalClaude(snapshot) })),
              ),
          }),
    } satisfies ProviderInstance;
  },
);

export const TempoClaudeDriver: ProviderDriver<ClaudeSettings, ClaudeDriverEnv, Path.Path> = {
  ...ClaudeDriver,
  metadata: { ...ClaudeDriver.metadata, supportsMultipleInstances: false },
  create: makeTempoClaudeInstance,
};

const isInstallRunning = (state: ProviderInstallState) =>
  state.phase === "downloading" || state.phase === "extracting" || state.phase === "verifying";

/**
 * Codex on the managed runtime: the pinned release from CodexInstallation (Tempo never runs a
 * `codex` on PATH), with this Mac's own CODEX_HOME and sign-in. A missing runtime is installed
 * internally.
 */
const makeTempoCodexProvider = Effect.fn("TempoProviderDrivers.makeTempoCodexProvider")(function* (
  input: ProviderDriverCreateInput<CodexSettings>,
) {
  const { instanceId, displayName, accentColor, config } = input;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const host = yield* ProviderHost.ProviderHost;
  const installation = yield* CodexInstallation.CodexInstallation;
  const catalog = yield* ModelCatalog.ModelCatalog;
  const scope = yield* Scope.Scope;
  const environment = yield* mergeProviderInstanceEnvironment(
    input.environment,
    sanitizeProviderEnvironment(yield* HostProcess.Environment),
  );
  const homeLayout = yield* resolveCodexHomeLayout({ ...config, shadowHomePath: "" });
  const homePath = homeLayout.sharedHomePath;
  // Codex refuses to start when CODEX_HOME does not exist, probes included.
  yield* fileSystem.makeDirectory(homePath, { recursive: true }).pipe(Effect.ignore);
  // The person's own skills from `~/.codex/skills` load there too.
  yield* linkPersonalCodexSkillsInto(homePath);
  const continuationIdentity = codexContinuationIdentity(homeLayout);
  const stamp = withInstanceIdentity({
    instanceId,
    driverKind: CODEX,
    displayName,
    accentColor,
    continuationGroupKey: continuationIdentity.continuationKey,
  });
  const runtimeConfig = (binaryPath: string) =>
    decodeCodexSettings({
      enabled: true,
      setupMode: "managed",
      binaryPath,
      homePath,
      launchArgs: config.launchArgs,
    });

  // Why there is no runtime to use: still installing, or the install's own failure.
  const unavailableDetail = (fallback: string) =>
    installation.state.pipe(
      Effect.map((state) =>
        isInstallRunning(state)
          ? "Codex is still being installed on this environment. Try again in a moment."
          : state.phase === "failed" && state.message
            ? state.message
            : fallback,
      ),
    );

  // Opened per session and per text generation; holds the binary while in use.
  const resolve = Effect.gen(function* () {
    const executable = yield* installation
      .acquire()
      .pipe(
        Effect.catch((error) =>
          unavailableDetail(error.detail).pipe(
            Effect.flatMap((detail) =>
              Effect.fail(new ProviderSetupError({ instanceId, operation: "install", detail })),
            ),
          ),
        ),
      );
    yield* fileSystem.makeDirectory(homePath, { recursive: true }).pipe(
      Effect.mapError(
        () =>
          new ProviderSetupError({
            instanceId,
            operation: "runtime",
            detail: "Could not prepare the Codex home directory.",
          }),
      ),
    );
    return {
      config: runtimeConfig(executable.executablePath),
      environment,
      revision: "tempo-local",
    } satisfies CodexEffectiveRuntime;
  });

  const pending = makePendingCodexProvider({ ...config, customModels: [] }).pipe(
    Effect.map((draft) =>
      stamp({ ...draft, models: [], runtimePaths: { homePath, shadowHomePath: null } }),
    ),
  );

  // No runtime yet: start the pinned install, unless one is running or the
  // last attempt failed less than CODEX_INSTALL_RETRY_MS ago. When it lands,
  // the snapshot is checked again rather than waiting for the next interval.
  const lastInstallStart = yield* Ref.make<number | null>(null);
  const snapshotReady = yield* Deferred.make<ManagedServerProvider>();
  const installThenRefresh = installation.start.pipe(
    Effect.andThen(
      installation.changes.pipe(
        Stream.filter((next) => !isInstallRunning(next)),
        Stream.runHead,
      ),
    ),
    Effect.andThen(Deferred.await(snapshotReady)),
    Effect.flatMap((provider) => provider.refresh),
    Effect.ignore,
  );
  const missingRuntime = Effect.fn("TempoProviderDrivers.missingRuntime")(function* (
    draft: ServerProvider,
    resolveFailure: string,
  ) {
    const state = yield* installation.state;
    const now = yield* Clock.currentTimeMillis;
    const lastStart = yield* Ref.get(lastInstallStart);
    const retryDue = lastStart === null || now - lastStart >= CODEX_INSTALL_RETRY_MS;
    if (!isInstallRunning(state) && !retryDue) {
      return {
        ...draft,
        installed: false,
        status: "error" as const,
        auth: { status: "unknown" as const },
        message: yield* unavailableDetail(resolveFailure),
      };
    }
    if (!isInstallRunning(state)) {
      yield* Ref.set(lastInstallStart, now);
      yield* installThenRefresh.pipe(Effect.forkIn(scope));
    }
    return {
      ...draft,
      installed: false,
      status: "warning" as const,
      auth: { status: "unknown" as const },
      message: CODEX_INSTALLING_MESSAGE,
    };
  });

  const checkLocal = Effect.gen(function* () {
    const draft = yield* pending;
    const executable = yield* installation.resolve().pipe(Effect.result);
    if (Result.isFailure(executable)) {
      return presentLocalCodex(yield* missingRuntime(draft, executable.failure.detail));
    }
    const status = yield* checkCodexProviderStatus(
      runtimeConfig(executable.success.executablePath),
      undefined,
      environment,
    );
    yield* catalog.refreshInBackground;
    const current = yield* catalog.current(CODEX);
    return presentLocalCodex(
      stamp({
        ...applyCodexModelCatalog(status, current),
        version: status.version ?? executable.success.version,
        runtimePaths: { homePath, shadowHomePath: null },
      }),
    );
  });

  const check = checkLocal.pipe(
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const snapshot = yield* makeManagedServerProvider({
    resolveMaintenance: () => Effect.succeed({ provider: CODEX, packageName: null, update: null }),
    getSettings: host.settings.get,
    streamSettings: host.settings.changes,
    haveSettingsChanged: () => false,
    initialSnapshot: () => pending.pipe(Effect.map(presentLocalCodex)),
    checkProvider: check,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: CODEX,
          instanceId,
          detail: "Could not prepare Codex.",
          cause,
        }),
    ),
  );
  yield* Deferred.succeed(snapshotReady, snapshot);
  const orchestrationAdapter = yield* createCodexAdapterV2(input, {
    onUsageLimits: (update) => snapshot.applyUsageLimits(update),
    resolveRuntime: resolve,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: CODEX,
          instanceId,
          detail: "Failed to build Codex orchestration adapter.",
          cause,
        }),
    ),
  );
  const textGeneration = yield* makeCodexTextGeneration(
    config,
    undefined,
    snapshot.getSnapshot.pipe(Effect.map((value) => value.models)),
    resolve,
  );
  return {
    instanceId,
    driverKind: CODEX,
    continuationIdentity,
    displayName,
    accentColor,
    enabled: true,
    snapshot,
    orchestrationAdapter,
    textGeneration,
    snapshotForCwd: (cwd: string) =>
      resolve.pipe(
        Effect.flatMap((effective) =>
          probeCodexSkillsForCwd({
            binaryPath: effective.config.binaryPath,
            homePath: effective.config.homePath,
            launchArgs: effective.config.launchArgs,
            cwd,
            environment: effective.environment,
          }),
        ),
        Effect.flatMap((skills) =>
          snapshot.getSnapshot.pipe(Effect.map((draft) => ({ ...draft, skills }))),
        ),
        Effect.scoped,
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.catch(() => snapshot.getSnapshot),
      ),
  } satisfies ProviderInstance;
});

export const TempoCodexDriver: ProviderDriver<
  CodexSettings,
  CodexDriverEnv,
  Path.Path | CodexUsageHistory.CodexUsageHistory
> = {
  ...CodexDriver,
  metadata: { ...CodexDriver.metadata, supportsMultipleInstances: false },
  create: makeTempoCodexProvider,
};
