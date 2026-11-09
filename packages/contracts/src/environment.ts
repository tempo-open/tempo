import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  EnvironmentId,
  ForwardCompatibleOptional,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SourceControlProviderKind } from "./sourceControl.ts";

export const ORCHESTRATION_PROTOCOL_VERSION = 2;
export const ORCHESTRATION_PROTOCOL_VERSION_TEXT = "2";
export const ORCHESTRATION_PROTOCOL_QUERY_PARAM = "orchestrationProtocol";
export const ORCHESTRATION_PROTOCOL_HEADER = "x-t3-orchestration-protocol";

export const ExecutionEnvironmentPlatformOs = Schema.Literals([
  "darwin",
  "linux",
  "windows",
  "unknown",
]);
export type ExecutionEnvironmentPlatformOs = typeof ExecutionEnvironmentPlatformOs.Type;

export const ExecutionEnvironmentPlatformArch = Schema.Literals(["arm64", "x64", "other"]);
export type ExecutionEnvironmentPlatformArch = typeof ExecutionEnvironmentPlatformArch.Type;

export const ENVIRONMENT_MACHINE_KINDS = [
  "server",
  "cloud",
  "linux",
  "desktop",
  "laptop",
  "mac-mini",
  "mac-studio",
] as const;
export const EnvironmentMachineKind = Schema.Literals(ENVIRONMENT_MACHINE_KINDS);
export type EnvironmentMachineKind = typeof EnvironmentMachineKind.Type;
export const isEnvironmentMachineKind = Schema.is(EnvironmentMachineKind);

export const ExecutionEnvironmentPlatform = Schema.Struct({
  os: ExecutionEnvironmentPlatformOs,
  arch: ExecutionEnvironmentPlatformArch,
  machine: ForwardCompatibleOptional(EnvironmentMachineKind),
});

// Kept outside settings.ts to avoid an orchestration import cycle.
export const ThreadEnvMode = Schema.Literals(["local", "worktree"]);
export type ThreadEnvMode = typeof ThreadEnvMode.Type;

export const WorktreeSubmodules = Schema.Literals(["recursive", "top-level", "none"]);
export type WorktreeSubmodules = typeof WorktreeSubmodules.Type;
export type ExecutionEnvironmentPlatform = typeof ExecutionEnvironmentPlatform.Type;

export const ServerSelfUpdateMethod = Schema.Literals(["boot-service", "respawn", "desktop-app"]);
export type ServerSelfUpdateMethod = typeof ServerSelfUpdateMethod.Type;

export const ServerInstallation = Schema.Union([
  Schema.Struct({ kind: Schema.Literals(["npx", "pnpm-dlx", "bunx"]) }),
  Schema.Struct({ kind: Schema.Literal("npm-global"), prefix: TrimmedNonEmptyString }),
]);
export type ServerInstallation = typeof ServerInstallation.Type;

export const ServerSelfUpdateCapability = Schema.Literals([
  "boot-service",
  "respawn",
  "desktop-managed",
]);
export type ServerSelfUpdateCapability = typeof ServerSelfUpdateCapability.Type;

export const ExecutionEnvironmentCapabilities = Schema.Struct({
  repositoryIdentity: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  connectionProbe: Schema.optionalKey(Schema.Boolean),
  attachmentUploads: Schema.optionalKey(Schema.Boolean),
  questionAttachments: Schema.optionalKey(Schema.Boolean),
  fileAttachments: Schema.optionalKey(
    Schema.Struct({
      maxUploadBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
    }),
  ),
  pullRequests: Schema.optionalKey(Schema.Boolean),
  pullRequestChecks: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  inlineMessageContext: Schema.optionalKey(Schema.Boolean),
  requiredWorktreeBootstrap: Schema.optionalKey(Schema.Boolean),
  threadSettlement: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlement: Schema.optionalKey(Schema.Boolean),
  storageCleanup: Schema.optionalKey(Schema.Boolean),
  storageCleanupRun: Schema.optionalKey(Schema.Boolean),
  databaseStorage: Schema.optionalKey(Schema.Boolean),
  otlpEndpointCheck: Schema.optionalKey(Schema.Boolean),
  projectWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  settledWorktreeCleanup: Schema.optionalKey(Schema.Boolean),
  worktreesDirectory: Schema.optionalKey(Schema.Boolean),
  /** tempo: this server clones new worktrees from a shadow checkout when the setting is on (macOS). */
  tempoShadowWorktrees: Schema.optionalKey(Schema.Boolean),
  /** tempo: serves `tempo.mcpConnectors.*`, the connectors list `/mcp` opens. */
  tempoMcpConnectors: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves `tempo.reposVolume.*`, the setup of an APFS volume at ~/repos (macOS). */
  tempoReposVolume: Schema.optionalKey(Schema.Boolean),
  threadAutoSettlementScope: Schema.optionalKey(Schema.Boolean),
  threadRestartContinuation: Schema.optionalKey(Schema.Boolean),
  projectSettingsOverrides: Schema.optionalKey(Schema.Boolean),
  /** Hide the switch when absent; older servers silently drop per-project provider patches. */
  projectProviderInstanceOverrides: Schema.optionalKey(Schema.Boolean),
  threadSnooze: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves the tempo.threadMove RPCs. Clients offer a move only between two such servers. */
  tempoThreadMove: Schema.optionalKey(Schema.Boolean),
  /**
   * tempo: server moves a thread with no Git remote as a copy of its folder.
   * Clients ask a source for one only when the target has this.
   */
  tempoThreadMoveFolders: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves the tempo.t3Import RPCs, which copy its machine's T3 Code threads into Tempo. */
  tempoT3Import: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves tempo.productionWait.set and wakes waiting threads after a production promotion. */
  tempoProductionWait: Schema.optionalKey(Schema.Boolean),
  /** tempo: server owns `/goal` (tempoGoal.ts) and serves tempo.goal.update. */
  tempoGoal: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves tempo.threadOutline.get, every user message of a thread for the minimap. */
  tempoThreadOutline: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves tempo.activity.read, what happened on each local day. */
  tempoActivity: Schema.optionalKey(Schema.Boolean),
  /** tempo: server serves tempo.threadPages.list, the pages a thread shared, for its Deliverables tab. */
  tempoThreadPages: Schema.optionalKey(Schema.Boolean),
  /** tempo: server reads the `tempoCompactNearLimit` setting; older ones decode it away. */
  tempoCompactNearLimit: Schema.optionalKey(Schema.Boolean),
  /**
   * tempo: server updates its providers by itself unless `tempoAutoUpdateProviders` is off. Older
   * servers decode that setting away, so clients offer it only where this is true.
   */
  tempoAutoUpdateProviders: Schema.optionalKey(Schema.Boolean),
  /** tempo: a Mac server that stays awake on power so other devices can reach it, unless
      `tempoKeepAwakeOnPower` is off. Absent elsewhere and on older servers. */
  tempoKeepAwakeOnPower: Schema.optionalKey(Schema.Boolean),
  /** tempo: server reads `askBeforeServiceWrites`; older ones always ask and decode it away. */
  tempoAskBeforeServiceWrites: Schema.optionalKey(Schema.Boolean),
  /** Every protocol-2 server sends this; older mobile builds still read it. */
  environmentThemes: Schema.optionalKey(Schema.Boolean),
  usageLimitSources: Schema.optionalKey(Schema.Boolean),
  /** Honors `workspaceSnapshotsOnDemand`; older servers send every snapshot and drop them in the stream. */
  providerWorkspaceSnapshotsOnDemand: Schema.optionalKey(Schema.Boolean),
  usagePriceOverrides: Schema.optionalKey(Schema.Boolean),
  usageModelAliases: Schema.optionalKey(Schema.Boolean),
  threadPinning: Schema.optionalKey(Schema.Boolean),
  threadPinReorder: Schema.optionalKey(Schema.Boolean),
  threadActiveReorder: Schema.optionalKey(Schema.Boolean),
  threadAutoSettleOptOut: Schema.optionalKey(Schema.Boolean),
  threadProjectFromScratch: Schema.optionalKey(Schema.Boolean),
  threadTitleRegeneration: Schema.optionalKey(Schema.Boolean),
  threadVisitedTracking: Schema.optionalKey(Schema.Boolean),
  threadPullRequestLinking: Schema.optionalKey(Schema.Boolean),
  serverResolvedCommandContext: Schema.optionalKey(Schema.Boolean),
  threadStop: Schema.optionalKey(Schema.Boolean),
  /** Absent on older servers and on Windows hosts, which cannot stop a discovered server. */
  localServerStop: Schema.optionalKey(Schema.Boolean),
  threadPullRequests: Schema.optionalKey(Schema.Boolean),
  threadPullRequestWatch: Schema.optionalKey(Schema.Boolean),
  pullRequestStackActions: Schema.optionalKey(Schema.Boolean),
  serverSelfUpdate: Schema.optionalKey(ServerSelfUpdateCapability),
  /** Manual commands must update this install, not the host's default global prefix. */
  serverInstallation: ForwardCompatibleOptional(ServerInstallation),
  serverSelfUpdateProgress: Schema.optionalKey(Schema.Boolean),
  serverUpdateThreadContinuation: Schema.optionalKey(Schema.Boolean),
  /** Only explicit false skips Live Activity seeding; older servers may still publish. */
  agentActivityPublishing: Schema.optionalKey(Schema.Boolean),
  projectCloneTracking: Schema.optionalKey(Schema.Boolean),
  /** Server answers projects.listIgnoredFiles. */
  ignoredFileListing: Schema.optionalKey(Schema.Boolean),
  environmentIcon: Schema.optionalKey(Schema.Boolean),
  desktopAppUpdate: Schema.optionalKey(Schema.Boolean),
  /** The desktop app switches update tracks when a server update request names one. */
  desktopAppChannelSwitch: Schema.optionalKey(Schema.Boolean),
  /** Subscribe to command output only when advertised; older servers never send it. */
  commandOutputStreaming: Schema.optionalKey(Schema.Boolean),
  /** Hosts headless Chromium tabs streamed over /api/preview-stream for clients without a local runtime. */
  serverBrowser: Schema.optionalKey(Schema.Boolean),
  /** Server links to other environments (`PeerLink`) and its agents can work
      in them. Absent on servers from before linking, which clients must not
      offer linking for. */
  peerLinks: Schema.optionalKey(Schema.Boolean),
  /** Server's `/mcp` narrows an OAuth client's modes from `T3-Mode-Limit`, so
      a linked environment's calls keep its agent's limits. Another environment
      links to this one only when it is set. */
  mcpModeLimitHeader: Schema.optionalKey(Schema.Boolean),
  /** Work a linked environment starts here stays within its link
      (`linkOrigin`). Another environment links to this one only when it is
      set, since without it that work could change the user's own threads. */
  linkFence: Schema.optionalKey(Schema.Boolean),
  /** Server answers server.prepareTriage. */
  triage: Schema.optionalKey(Schema.Boolean),
  /** tempo: server lists and edits agent instruction files (`tempo.instructionFiles.*`). */
  tempoInstructionFiles: Schema.optionalKey(Schema.Boolean),
  /** tempo: server exports and imports the person's agent files (`tempo.agentFiles.*`). */
  tempoAgentFiles: Schema.optionalKey(Schema.Boolean),
  /** tempo: server takes laptop tool hosts (`laptopTools.connect`); clients must not open it otherwise. */
  tempoLaptopTools: Schema.optionalKey(Schema.Boolean),
});
export type ExecutionEnvironmentCapabilities = typeof ExecutionEnvironmentCapabilities.Type;

export const ExecutionEnvironmentDescriptor = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  platform: ExecutionEnvironmentPlatform,
  serverVersion: TrimmedNonEmptyString,
  orchestrationProtocolVersion: Schema.optionalKey(Schema.Int),
  /** Highest migration this server's database holds; absent on older servers. */
  databaseMigration: Schema.optionalKey(Schema.Int),
  capabilities: ExecutionEnvironmentCapabilities,
});
export type ExecutionEnvironmentDescriptor = typeof ExecutionEnvironmentDescriptor.Type;

export const RepositoryIdentityLocator = Schema.Struct({
  source: Schema.Literal("git-remote"),
  remoteName: TrimmedNonEmptyString,
  remoteUrl: TrimmedNonEmptyString,
});
export type RepositoryIdentityLocator = typeof RepositoryIdentityLocator.Type;

export const RepositoryOrigin = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  remoteUrl: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
});
export type RepositoryOrigin = typeof RepositoryOrigin.Type;

export const RepositoryIdentity = Schema.Struct({
  canonicalKey: TrimmedNonEmptyString,
  locator: RepositoryIdentityLocator,
  webUrl: Schema.optionalKey(TrimmedNonEmptyString),
  /** Work tree root, or the git dir for a bare repository. */
  rootPath: Schema.optionalKey(TrimmedNonEmptyString),
  displayName: Schema.optionalKey(TrimmedNonEmptyString),
  provider: Schema.optionalKey(SourceControlProviderKind),
  owner: Schema.optionalKey(TrimmedNonEmptyString),
  name: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(RepositoryOrigin),
});
export type RepositoryIdentity = typeof RepositoryIdentity.Type;

export function repositoryGroupingKeyOf(identity: RepositoryIdentity): string {
  return identity.origin?.canonicalKey ?? identity.canonicalKey;
}

export function repositoryGroupingDisplayNameOf(identity: RepositoryIdentity): string | undefined {
  return identity.origin
    ? (identity.origin.displayName ?? identity.origin.canonicalKey)
    : identity.displayName;
}

export const ScopedProjectRef = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
});
export type ScopedProjectRef = typeof ScopedProjectRef.Type;

export const ScopedThreadRef = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
});
export type ScopedThreadRef = typeof ScopedThreadRef.Type;
