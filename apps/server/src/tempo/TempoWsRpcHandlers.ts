/**
 * The WebSocket handlers for Tempo's own RPCs (`TempoWsRpcGroup`), merged with upstream's per connection
 * in ws.ts. They stay apart because one `toLayer`'s requirements cost TypeScript instantiations
 * that grow with the square of its group's size.
 *
 * @module TempoWsRpcHandlers
 */
import {
  TEMPO_ACTIVITY_WS_METHODS,
  TEMPO_MCP_CONNECTORS_WS_METHODS,
  TEMPO_CLAUDE_WORKFLOWS_WS_METHODS,
  TEMPO_PRODUCTION_WAIT_WS_METHODS,
  TEMPO_GOAL_WS_METHODS,
  TEMPO_REPOS_VOLUME_WS_METHODS,
  TEMPO_T3_IMPORT_WS_METHODS,
  TEMPO_THREAD_OUTLINE_WS_METHODS,
  TEMPO_THREAD_PAGES_WS_METHODS,
  TempoWsRpcGroup,
  LAPTOP_TOOLS_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import type * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as TempoActivity from "./activity/TempoActivity.ts";
import * as AgentFilesSync from "./AgentFilesSync.ts";
import * as TempoBrowser from "./browser/TempoBrowser.ts";
import * as TempoBrowserPages from "./browser/TempoBrowserPages.ts";
import * as ClaudeSavedWorkflows from "./ClaudeSavedWorkflows.ts";
import * as TempoMcpConnectors from "./TempoMcpConnectors.ts";
import * as InstructionFiles from "./InstructionFiles.ts";
import * as LaptopToolHosts from "./laptopTools/LaptopToolHosts.ts";
import * as ProductionWait from "./productionWait/ProductionWait.ts";
import * as TempoGoals from "./goal/TempoGoals.ts";
import * as ReposVolume from "./reposVolume/ReposVolume.ts";
import * as ServiceConnections from "./ServiceConnections.ts";
import * as T3ImportService from "./t3Import/T3ImportService.ts";
import * as ThreadMoveRpc from "./threadMove/ThreadMoveRpc.ts";
import * as ThreadOutline from "./threadOutline/ThreadOutline.ts";
import * as ThreadPages from "./threadPages/ThreadPages.ts";

/** Tempo's handlers for one authenticated WebSocket connection. */
export const layer = (currentSession: EnvironmentAuth.AuthenticatedSession) =>
  TempoWsRpcGroup.toLayer(
    Effect.gen(function* () {
      const currentSessionId = currentSession.sessionId;
      const threadMoveHandlers = yield* ThreadMoveRpc.handlers;
      const claudeSavedWorkflows = yield* ClaudeSavedWorkflows.ClaudeSavedWorkflows;
      const instructionFiles = yield* InstructionFiles.InstructionFiles;
      const agentFilesSync = yield* AgentFilesSync.AgentFilesSync;
      const laptopToolHosts = yield* LaptopToolHosts.LaptopToolHosts;
      const mcpConnectors = yield* TempoMcpConnectors.TempoMcpConnectors;
      const tempoServices = yield* ServiceConnections.ServiceConnections;
      const tempoBrowser = yield* TempoBrowser.TempoBrowser;
      const tempoBrowserPages = yield* TempoBrowserPages.TempoBrowserPages;
      const t3Import = yield* T3ImportService.T3ImportService;
      const productionWait = yield* ProductionWait.ProductionWait;
      const goals = yield* TempoGoals.TempoGoals;
      const threadOutline = yield* ThreadOutline.ThreadOutline;
      const activity = yield* TempoActivity.TempoActivity;
      const threadPages = yield* ThreadPages.ThreadPages;
      const reposVolume = yield* ReposVolume.ReposVolume;
      return TempoWsRpcGroup.of({
        ...threadMoveHandlers,
        // Copying this machine's T3 Code threads into Tempo.
        [TEMPO_T3_IMPORT_WS_METHODS.scan]: (input) => t3Import.scan(input),
        [TEMPO_T3_IMPORT_WS_METHODS.run]: (input) => t3Import.run(input),
        // Waiting for Production; failures are already TempoProductionWaitError.
        [TEMPO_PRODUCTION_WAIT_WS_METHODS.set]: (input) => productionWait.setWaiting(input),
        // Thread goals; failures are already TempoGoalError.
        [TEMPO_GOAL_WS_METHODS.update]: (input) =>
          goals.update({ threadId: input.threadId, change: { type: input.action } }),
        // The minimap's marks for every message; failures are already TempoThreadOutlineError.
        [TEMPO_THREAD_OUTLINE_WS_METHODS.get]: (input) => threadOutline.get(input),
        // Activity per local day; failures are already TempoActivityError.
        [TEMPO_ACTIVITY_WS_METHODS.read]: (input) => activity.read(input),
        // The Deliverables tab's pages; failures are already TempoThreadPagesError.
        [TEMPO_THREAD_PAGES_WS_METHODS.list]: (input) => threadPages.list(input),
        [TEMPO_CLAUDE_WORKFLOWS_WS_METHODS.listSaved]: (input) => claudeSavedWorkflows.list(input),
        // Agent instruction files; failures are already InstructionFileError.
        [WS_METHODS.tempoInstructionFilesList]: (input) => instructionFiles.list(input),
        [WS_METHODS.tempoInstructionFilesRead]: (input) => instructionFiles.read(input),
        [WS_METHODS.tempoInstructionFilesWrite]: (input) => instructionFiles.write(input),
        [WS_METHODS.tempoInstructionFilesDelete]: (input) =>
          instructionFiles.remove(input).pipe(Effect.as({})),
        // The person's agent files, copied from one environment to another.
        [WS_METHODS.tempoAgentFilesExport]: (_input) => agentFilesSync.exportFiles,
        [WS_METHODS.tempoAgentFilesImport]: (input) => agentFilesSync.importFiles(input),
        // The MCP servers a thread's Claude has; failures are already TempoMcpConnectorsError.
        [TEMPO_MCP_CONNECTORS_WS_METHODS.list]: (input) => mcpConnectors.list(input.threadId),
        [TEMPO_MCP_CONNECTORS_WS_METHODS.signIn]: (input) =>
          mcpConnectors.signIn(input.threadId, input.name),
        [TEMPO_MCP_CONNECTORS_WS_METHODS.cancelSignIn]: (_input) => mcpConnectors.cancelSignIn,
        [TEMPO_MCP_CONNECTORS_WS_METHODS.reconnect]: (input) =>
          mcpConnectors.reconnect(input.threadId, input.name),
        // Service connections saved on this environment
        [WS_METHODS.tempoListServiceConnections]: (_input) => tempoServices.snapshot,
        [WS_METHODS.tempoSaveLocalServiceConnection]: (input) => tempoServices.saveLocal(input),
        [WS_METHODS.tempoRemoveLocalServiceConnection]: (input) =>
          tempoServices.removeLocal(input.name),
        [WS_METHODS.tempoTestServiceConnection]: (input) => tempoServices.test(input.id),
        [LAPTOP_TOOLS_WS_METHODS.connect]: (input) =>
          Stream.unwrap(laptopToolHosts.connect(input, currentSessionId)),
        [LAPTOP_TOOLS_WS_METHODS.respond]: (input) =>
          laptopToolHosts.respond(input, currentSessionId),
        // Server browser extensions, saved passkeys and saved passwords
        [WS_METHODS.tempoBrowserGetProfile]: (input) => tempoBrowser.getProfile(input.profileId),
        [WS_METHODS.tempoBrowserAddExtension]: (input) => tempoBrowser.addExtension(input),
        [WS_METHODS.tempoBrowserSetExtensionEnabled]: (input) =>
          tempoBrowser.setExtensionEnabled(input),
        [WS_METHODS.tempoBrowserRemoveExtension]: (input) => tempoBrowser.removeExtension(input),
        [WS_METHODS.tempoBrowserCheckExtensionUpdates]: (input) =>
          tempoBrowser.checkExtensionUpdates(input.profileId),
        [WS_METHODS.tempoBrowserSetPasskeySettings]: (input) =>
          tempoBrowser.setPasskeySettings(input),
        [WS_METHODS.tempoBrowserRemovePasskey]: (input) => tempoBrowser.removePasskey(input),
        [WS_METHODS.tempoBrowserSetPasswordSettings]: (input) =>
          tempoBrowser.setPasswordSettings(input),
        [WS_METHODS.tempoBrowserRemovePassword]: (input) => tempoBrowser.removePassword(input),
        [WS_METHODS.tempoBrowserOpenExtensionPage]: (input) =>
          tempoBrowserPages.openExtensionPage(input),
        [WS_METHODS.tempoBrowserForgetProfile]: (input) =>
          tempoBrowser.forgetProfile(input.profileId),
        // The repos volume; the person runs its setup script in a terminal.
        [TEMPO_REPOS_VOLUME_WS_METHODS.status]: (_input) => reposVolume.status,
        [TEMPO_REPOS_VOLUME_WS_METHODS.prepare]: (_input) => reposVolume.prepare,
      });
    }),
  );
