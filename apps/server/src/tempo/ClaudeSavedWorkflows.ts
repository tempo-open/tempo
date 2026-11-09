/**
 * The saved workflow scripts a Claude thread can run by name: the repo's `.claude/workflows/*.js`
 * (from the main checkout for a worktree) and the user's own in the instance's Claude config
 * directory (`~/.claude` in Tempo).
 *
 * @module tempo/ClaudeSavedWorkflows
 */
import {
  ClaudeSettings,
  TempoClaudeWorkflowsError,
  ProviderInstanceId,
  type TempoClaudeSavedWorkflow,
  type TempoListClaudeSavedWorkflowsInput,
  type TempoListClaudeSavedWorkflowsResult,
} from "@t3tools/contracts";
import { parseClaudeWorkflowMeta } from "@t3tools/shared/tempoClaudeWorkflowMeta";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveTempoClaudeProjectConfigRoot } from "./claudeWorkflows.ts";
import { InstructionProviderInstances } from "./InstructionRoots.ts";

/** Workflow headers sit at the top; nothing past this is read. */
const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_WORKFLOWS_PER_SCOPE = 200;

const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);
const CLAUDE_DEFAULT_INSTANCE_ID = ProviderInstanceId.make("claudeAgent");

export class ClaudeSavedWorkflows extends Context.Service<
  ClaudeSavedWorkflows,
  {
    readonly list: (
      input: TempoListClaudeSavedWorkflowsInput,
    ) => Effect.Effect<TempoListClaudeSavedWorkflowsResult, TempoClaudeWorkflowsError>;
  }
>()("t3/tempo/ClaudeSavedWorkflows") {}

const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settings = yield* ServerSettingsService;
  const providerInstances = yield* InstructionProviderInstances;

  /** Reads one directory's scripts. A missing or unreadable one has none. */
  const readScope = Effect.fn("ClaudeSavedWorkflows.readScope")(function* (
    directory: string,
    scope: TempoClaudeSavedWorkflow["scope"],
  ) {
    const entries = yield* fileSystem
      .readDirectory(directory)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
    const scripts = entries
      .filter((entry) => entry.endsWith(".js"))
      .toSorted()
      .slice(0, MAX_WORKFLOWS_PER_SCOPE);
    const workflows = yield* Effect.forEach(
      scripts,
      (entry) =>
        Effect.gen(function* () {
          const filePath = path.join(directory, entry);
          const info = yield* fileSystem.stat(filePath);
          if (info.type !== "File" || Number(info.size) > MAX_SCRIPT_BYTES) return [];
          const script = yield* fileSystem.readFileString(filePath);
          const meta = parseClaudeWorkflowMeta(script);
          const workflow: TempoClaudeSavedWorkflow = {
            name: meta?.name ?? entry.slice(0, -".js".length),
            ...(meta?.description === undefined ? {} : { description: meta.description }),
            phases: (meta?.phases ?? []).map((phase) => phase.title),
            scope,
            path: filePath,
          };
          return [workflow];
        }).pipe(Effect.orElseSucceed((): ReadonlyArray<TempoClaudeSavedWorkflow> => [])),
      { concurrency: 8 },
    );
    return workflows.flat();
  });

  const list: ClaudeSavedWorkflows["Service"]["list"] = Effect.fn("ClaudeSavedWorkflows.list")(
    function* (input) {
      const serverSettings = yield* settings.getSettings.pipe(
        Effect.mapError((cause) => new TempoClaudeWorkflowsError({ cause })),
      );
      // The config the instance launches with, not settings.json: tempo sets the home itself.
      const configMap = yield* providerInstances.configMap(serverSettings);
      const instanceConfig = configMap[input.instanceId ?? CLAUDE_DEFAULT_INSTANCE_ID]?.config;
      const claudeSettings = decodeClaudeSettings(instanceConfig ?? {});
      const homePath = claudeSettings._tag === "Some" ? claudeSettings.value.homePath : "";
      const environment = yield* HostProcess.Environment;
      const claudeHome = yield* resolveClaudeHomePath({ homePath }, environment);
      const projectRoot = (yield* resolveTempoClaudeProjectConfigRoot(input.cwd)) ?? input.cwd;
      const [project, user] = yield* Effect.all(
        [
          readScope(path.join(projectRoot, ".claude", "workflows"), "project"),
          readScope(path.join(claudeHome, "workflows"), "user"),
        ],
        { concurrency: 2 },
      );
      // A project workflow shadows a user one with the same name, as in Claude.
      const projectNames = new Set(project.map((workflow) => workflow.name));
      return {
        workflows: [...project, ...user.filter((workflow) => !projectNames.has(workflow.name))],
      };
    },
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  return ClaudeSavedWorkflows.of({ list });
});

export const layer = Layer.effect(ClaudeSavedWorkflows, make);
