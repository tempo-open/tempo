import * as Schema from "effect/Schema";
import { GitPreparePullRequestThreadInput, GitRunStackedActionInput } from "./git.ts";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  AuthPreviewOperateScope,
  AuthSettingsWriteScope,
  AuthSourceControlWriteScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
} from "./auth.ts";
import { TEMPO_THREAD_MOVE_RPC_SCOPES, tempoThreadMoveRequiredScopes } from "./tempoThreadMove.ts";
import { TEMPO_T3_IMPORT_WS_METHODS } from "./tempoT3Import.ts";
import { TEMPO_PRODUCTION_WAIT_WS_METHODS } from "./tempoProductionWait.ts";
import { TEMPO_GOAL_WS_METHODS } from "./tempoGoal.ts";
import { TEMPO_REPOS_VOLUME_WS_METHODS } from "./tempoReposVolume.ts";
import { TEMPO_MCP_CONNECTORS_WS_METHODS } from "./tempoMcpConnectors.ts";
import { ORCHESTRATION_V2_WS_METHODS } from "./orchestrationV2.ts";
import { LAPTOP_TOOLS_WS_METHODS } from "./tempoLaptopTools.ts";
import { WS_METHODS } from "./rpc.ts";

/** Incremental client enforcement; the server still authorizes every request. */
export const CLIENT_GUARDED_RPC_SCOPES = {
  [WS_METHODS.previewClose]: AuthPreviewOperateScope,
  // Stopping a server signals its processes, as closing a terminal does.
  [WS_METHODS.previewStopLocalServer]: AuthTerminalOperateScope,
  [WS_METHODS.serverRunStorageCleanup]: AuthSettingsWriteScope,
  [WS_METHODS.serverCheckOtlpEndpoint]: AuthSettingsWriteScope,
  [WS_METHODS.pullRequestsRunAction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdate]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsUpdateComment]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSubmitReview]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsReplyToThread]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetThreadResolution]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetReaction]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetFilesViewed]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsRequestReviewers]: AuthSourceControlWriteScope,
  [WS_METHODS.pullRequestsSetLabels]: AuthSourceControlWriteScope,
  // Writing a guide runs a model on this environment's providers, which reading one does not.
  [WS_METHODS.pullRequestsGenerateReviewGuide]: AuthOrchestrationOperateScope,
  [WS_METHODS.projectsCreateFromThread]: AuthOrchestrationOperateScope,
  [WS_METHODS.sourceControlCloneRepository]: AuthSourceControlWriteScope,
  [WS_METHODS.sourceControlPublishRepository]: AuthSourceControlWriteScope,
  // Signing in replaces the server's GitHub credential, as saving a token in Settings does.
  [WS_METHODS.sourceControlSignInStart]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInWait]: AuthSettingsWriteScope,
  [WS_METHODS.sourceControlSignInCancel]: AuthSettingsWriteScope,
  [WS_METHODS.projectCloneStart]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneCancel]: AuthSourceControlWriteScope,
  [WS_METHODS.projectCloneRetry]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsPull]: AuthSourceControlWriteScope,
  [WS_METHODS.gitRunStackedAction]: AuthSourceControlWriteScope,
  [WS_METHODS.gitPreparePullRequestThread]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsRemoveWorktree]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsCreateRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsSwitchRef]: AuthSourceControlWriteScope,
  [WS_METHODS.vcsInit]: AuthSourceControlWriteScope,

  // Starts an agent session on this environment that can read its logs and database.
  [WS_METHODS.serverPrepareTriage]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksSetEnabled]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksDelete]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRunNow]: AuthOrchestrationOperateScope,
  [WS_METHODS.scheduledTasksRotateWebhookToken]: AuthOrchestrationOperateScope,
  [ORCHESTRATION_V2_WS_METHODS.stopWorkflow]: AuthOrchestrationOperateScope,
  // A guest link hands thread access to someone outside, like a pairing link.
  [WS_METHODS.guestShareCreate]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksLink]: AuthAccessWriteScope,
  [WS_METHODS.peerLinksUnlink]: AuthAccessWriteScope,
  // A link lets every agent here reach the other environment: Settings' bar.
  [WS_METHODS.peerLinksAnswerRequest]: AuthAccessWriteScope,
  // tempo: signing in saves a token Claude Code uses for every thread.
  [TEMPO_MCP_CONNECTORS_WS_METHODS.signIn]: AuthProvidersManageScope,
  [TEMPO_MCP_CONNECTORS_WS_METHODS.cancelSignIn]: AuthProvidersManageScope,
  [TEMPO_MCP_CONNECTORS_WS_METHODS.reconnect]: AuthProvidersManageScope,
  // tempo: instruction files configure every agent on the environment, like settings do.
  [WS_METHODS.tempoInstructionFilesWrite]: AuthSettingsWriteScope,
  [WS_METHODS.tempoInstructionFilesDelete]: AuthSettingsWriteScope,
  // tempo: a sync writes the person's own instruction files and Claude folders, the same grant.
  [WS_METHODS.tempoAgentFilesImport]: AuthSettingsWriteScope,
  // tempo: service connections hold secrets and send them out.
  [WS_METHODS.tempoSaveLocalServiceConnection]: AuthProvidersManageScope,
  [WS_METHODS.tempoRemoveLocalServiceConnection]: AuthProvidersManageScope,
  [WS_METHODS.tempoTestServiceConnection]: AuthProvidersManageScope,
  ...TEMPO_THREAD_MOVE_RPC_SCOPES,
  // tempo: importing from T3 Code creates projects and threads, like importing agent sessions.
  [TEMPO_T3_IMPORT_WS_METHODS.run]: AuthOrchestrationOperateScope,
  // tempo: waiting for production parks a thread until the server wakes it, like a snooze.
  [TEMPO_PRODUCTION_WAIT_WS_METHODS.set]: AuthOrchestrationOperateScope,
  // tempo: pausing, resuming or clearing a goal starts or stops a thread's turns.
  [TEMPO_GOAL_WS_METHODS.update]: AuthOrchestrationOperateScope,
  // tempo: answering an agent's laptop tool call acts on that agent's thread.
  [LAPTOP_TOOLS_WS_METHODS.respond]: AuthOrchestrationOperateScope,
  // tempo: extensions run code in every tab of a profile, and the passkey and password
  // switches decide whether agents can sign in, so changing any is a settings write.
  [WS_METHODS.tempoBrowserAddExtension]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserSetExtensionEnabled]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserRemoveExtension]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserCheckExtensionUpdates]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserSetPasskeySettings]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserRemovePasskey]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserSetPasswordSettings]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserRemovePassword]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserForgetProfile]: AuthSettingsWriteScope,
  [WS_METHODS.tempoBrowserOpenExtensionPage]: AuthPreviewOperateScope,
  // tempo: the setup script only runs in a terminal on that machine, so preparing it
  // takes the grant that opening that terminal does.
  [TEMPO_REPOS_VOLUME_WS_METHODS.prepare]: AuthTerminalOperateScope,
} as const;
export type ClientGuardedRpcTag = keyof typeof CLIENT_GUARDED_RPC_SCOPES;

const decodePrepareThread = Schema.decodeUnknownSync(GitPreparePullRequestThreadInput);
const decodeStackedAction = Schema.decodeUnknownSync(GitRunStackedActionInput);

export function clientRpcRequiredScopes(
  method: string,
  input: unknown,
): readonly AuthEnvironmentScope[] {
  if (method === WS_METHODS.gitPreparePullRequestThread && input !== undefined) {
    const payload = decodePrepareThread(input);
    if (payload.mode === "worktree" && payload.threadId !== undefined)
      return [AuthSourceControlWriteScope, AuthOrchestrationOperateScope];
  }
  if (method === WS_METHODS.gitRunStackedAction && input !== undefined) {
    const payload = decodeStackedAction(input);
    if (
      payload.threadId !== undefined &&
      (payload.action === "create_pr" || payload.action === "commit_push_pr")
    )
      return [AuthSourceControlWriteScope, AuthOrchestrationReadScope];
  }
  // tempo: moving a thread also needs the source-control and filesystem grants.
  const tempoThreadMove = tempoThreadMoveRequiredScopes(method);
  if (tempoThreadMove !== null) return tempoThreadMove;
  return Object.hasOwn(CLIENT_GUARDED_RPC_SCOPES, method)
    ? [CLIENT_GUARDED_RPC_SCOPES[method as ClientGuardedRpcTag]]
    : [];
}
