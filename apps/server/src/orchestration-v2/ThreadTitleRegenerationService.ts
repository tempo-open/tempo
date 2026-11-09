import { isUserFacingRun } from "@t3tools/shared/orchestrationV2ThreadError";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  CommandId,
  type ChatAttachment,
  type MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type RunId,
  type ServerSettingsError,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import * as TempoSiteLogos from "../tempo/TempoSiteLogos.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import type { OrchestratorV2Error } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

import { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";
import { THREAD_LOGO_IDS } from "@t3tools/shared/tempoThreadLogos";
export { formatThreadTitleContext } from "@t3tools/provider-core/server/threadTitleContext";

export class ThreadTitleRegenerationService extends Context.Service<
  ThreadTitleRegenerationService,
  {
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly requestId: CommandId;
      readonly kind:
        | { readonly type: "initial"; readonly messageId: MessageId }
        | { readonly type: "regenerate" };
    }) => Effect.Effect<
      void,
      | OrchestratorV2Error
      | ProjectStore.ProjectStoreV2Error
      | ServerSettingsError
      | ThreadManagementService.ThreadManagementProviderInstanceDisabledError
    >;
    /**
     * tempo: picks the logo of a thread the title model never saw (one from before logos, or one
     * imported from the Claude or Codex app), or one that got none before company logos existed,
     * from its whole conversation. Its title stays.
     */
    readonly chooseLogo: (threadId: ThreadId) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadTitleRegenerationService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  // Absent in tests that build this service alone; company logos then get none.
  const siteLogos = yield* Effect.serviceOption(TempoSiteLogos.TempoSiteLogos);

  const complete = (input: {
    readonly threadId: ThreadId;
    readonly requestId: CommandId;
    readonly title?: string;
    readonly tempoLogo?: string | null;
    readonly tempoNeedsRefinement?: true;
  }) =>
    threads
      .dispatch({
        type: "thread.title.regeneration.complete",
        commandId: CommandId.make(`${input.requestId}:title-complete`),
        threadId: input.threadId,
        requestId: input.requestId,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.tempoLogo === undefined ? {} : { tempoLogo: input.tempoLogo }),
        ...(input.tempoNeedsRefinement ? { tempoNeedsRefinement: true as const } : {}),
      })
      .pipe(Effect.asVoid);

  const messagesThroughRun = Effect.fn("ThreadTitleRegenerationService.messagesThroughRun")(
    function* (threadId: ThreadId, runId: RunId) {
      const source = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      const ordinals = new Map(
        source.runs
          .filter((run) => run.status !== "rolled_back")
          .map((run) => [run.id, run.ordinal]),
      );
      const forkOrdinal = ordinals.get(runId) ?? -1;
      const messages = source.messages.filter((message) => {
        if (message.streaming) return false;
        if (message.runId === null) return source.thread.historyOrigin === "v1_import";
        return (ordinals.get(message.runId) ?? Infinity) <= forkOrdinal;
      });
      return { thread: source.thread, messages };
    },
  );

  // A fork starts with no messages of its own, so its subject lives in the history it inherited.
  const forkSource = Effect.fn("ThreadTitleRegenerationService.forkSource")(function* (
    thread: OrchestrationV2AppThread,
  ) {
    let title: string | undefined;
    const history: Array<ReadonlyArray<OrchestrationV2ConversationMessage>> = [];
    let forkedFrom = thread.forkedFrom;
    while (forkedFrom?.type === "run") {
      const source = yield* messagesThroughRun(forkedFrom.threadId, forkedFrom.runId);
      history.push(source.messages);
      title ??= source.thread.title;
      forkedFrom = source.thread.forkedFrom;
    }
    const context = formatThreadTitleContext(history.reverse().flat());
    return title === undefined || context.message.length === 0
      ? undefined
      : { title, history: context.message };
  });

  // Idle compaction's "/compact" prompt and output are not conversation.
  const conversationContext = (projection: {
    readonly runs: ReadonlyArray<Parameters<typeof isUserFacingRun>[0] & { readonly id: RunId }>;
    readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  }) => {
    const idleRunIds = new Set(
      projection.runs.filter((run) => !isUserFacingRun(run)).map((run) => run.id),
    );
    return formatThreadTitleContext(
      projection.messages.filter(
        (message) =>
          !message.streaming && (message.runId === null || !idleRunIds.has(message.runId)),
      ),
    );
  };

  const generate = Effect.fn("ThreadTitleRegenerationService.generate")(function* (input: {
    readonly thread: OrchestrationV2AppThread;
    readonly workspaceRoot: string;
    readonly context: {
      readonly message: string;
      readonly attachments: ReadonlyArray<ChatAttachment>;
    };
    readonly previousTitle?: string;
  }) {
    // A deleted source should not cost the fork its title.
    const inherited = yield* forkSource(input.thread).pipe(Effect.orElseSucceed(() => undefined));
    const settings = resolveProjectSettings(
      yield* serverSettings.getSettings,
      input.thread.projectId,
    ).settings;
    const result = yield* textGeneration.generateThreadTitle({
      cwd: input.thread.worktreePath ?? input.workspaceRoot,
      message: input.context.message,
      attachments: input.context.attachments,
      ...(input.previousTitle === undefined ? {} : { previousTitle: input.previousTitle }),
      ...(inherited === undefined ? {} : { forkSource: inherited }),
      instructions: settings.threadTitleInstructions,
      modelSelection: settings.textGenerationModelSelection,
    });
    // tempo: a company off the logo list shows its own site's icon, or none when the site does not
    // check out (`TempoSiteLogos.ts`).
    const logo =
      typeof result.logo !== "string" || THREAD_LOGO_IDS.has(result.logo)
        ? result.logo
        : Option.isNone(siteLogos)
          ? null
          : yield* siteLogos.value.siteLogo(
              result.logo,
              `${input.thread.title}\n${input.context.message}`,
            );
    // tempo: no logo found, so keep the model's emoji icon; the sidebar still
    // prefers the project folder's logo or favicon over it.
    return { ...result, logo: logo === null ? (result.icon ?? null) : logo };
  });

  const execute: ThreadTitleRegenerationService["Service"]["execute"] = Effect.fn(
    "ThreadTitleRegenerationService.execute",
  )(function* (input) {
    const outcome:
      | { readonly type: "stale" }
      | {
          readonly type: "complete";
          readonly title?: string;
          readonly tempoLogo?: string | null;
          readonly tempoNeedsRefinement?: true;
        } = yield* Effect.gen(function* () {
      const projection = yield* threads.getThreadRecords(
        input.threadId,
        ["messages", "runs"],
        input.kind.type === "initial"
          ? { messageIds: [input.kind.messageId] }
          : { messageRoles: ["user", "assistant"] },
      );
      if (projection.thread.titleRegeneration?.requestId !== input.requestId) {
        return { type: "stale" as const };
      }

      const project = yield* projects.get(projection.thread.projectId);
      if (Option.isNone(project)) {
        return { type: "complete" as const };
      }

      let context: {
        readonly message: string;
        readonly attachments: ReadonlyArray<ChatAttachment>;
      };
      if (input.kind.type === "initial") {
        const messageId = input.kind.messageId;
        const message = projection.messages.find(
          (candidate) => candidate.id === messageId && !candidate.streaming,
        );
        context =
          message === undefined
            ? { message: "", attachments: [] }
            : { message: message.text, attachments: message.attachments };
      } else {
        context = conversationContext(projection);
      }
      if (context.message.length === 0 && context.attachments.length === 0) {
        return { type: "complete" as const };
      }

      const result = yield* generate({
        thread: projection.thread,
        workspaceRoot: project.value.workspaceRoot,
        context,
        ...(input.kind.type === "regenerate" ? { previousTitle: projection.thread.title } : {}),
      });
      const tempoLogo = result.logo === undefined ? {} : { tempoLogo: result.logo };
      // tempo: a first title written without knowing the subject gets a second look once the agent
      // has replied (`TempoThreadTitleRefinement.ts`).
      const tempoRefine =
        input.kind.type === "initial" && result.needsRefinement === true
          ? { tempoNeedsRefinement: true as const }
          : {};
      const generatedTitle = result.title.trim();
      return generatedTitle === "New thread" ||
        (input.kind.type === "regenerate" && generatedTitle === projection.thread.title.trim())
        ? { type: "complete" as const, ...tempoLogo, ...tempoRefine }
        : { type: "complete" as const, title: result.title, ...tempoLogo, ...tempoRefine };
    }).pipe(
      Effect.retry({
        times: input.kind.type === "initial" ? 2 : 0,
        schedule: Schedule.exponential("2 seconds"),
      }),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread title generation failed", {
              threadId: input.threadId,
              requestId: input.requestId,
              cause,
            }).pipe(Effect.as({ type: "complete" as const })),
      ),
    );

    if (outcome.type === "stale") {
      return;
    }
    yield* complete({
      ...input,
      ...(outcome.title === undefined ? {} : { title: outcome.title }),
      ...(outcome.tempoLogo === undefined ? {} : { tempoLogo: outcome.tempoLogo }),
      ...(outcome.tempoNeedsRefinement ? { tempoNeedsRefinement: true as const } : {}),
    });
  });

  const chooseLogo: ThreadTitleRegenerationService["Service"]["chooseLogo"] = Effect.fn(
    "ThreadTitleRegenerationService.chooseLogo",
  )(
    function* (threadId) {
      const projection = yield* threads.getThreadRecords(threadId, ["messages", "runs"], {
        messageRoles: ["user", "assistant"],
      });
      if (typeof projection.thread.tempoLogo === "string") return;
      const project = yield* projects.get(projection.thread.projectId);
      const context = conversationContext(projection);
      // Nothing to read means nothing to show; the thread's first title, if it gets one, decides.
      const tempoLogo =
        Option.isNone(project) || (context.message.length === 0 && context.attachments.length === 0)
          ? null
          : (yield* generate({
              thread: projection.thread,
              workspaceRoot: project.value.workspaceRoot,
              context,
              previousTitle: projection.thread.title,
            })).logo;
      if (tempoLogo === undefined) return;
      yield* threads.dispatch({
        type: "thread.metadata.update",
        // Version 3 gives threads that earlier versions left with no logo a fallback icon.
        commandId: CommandId.make(`tempo-logo:3:${threadId}`),
        threadId,
        tempoLogo,
      });
    },
    (effect, threadId) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread logo choice failed", { threadId, cause }),
        ),
      ),
  );

  return ThreadTitleRegenerationService.of({ execute, chooseLogo });
});

export const layer = Layer.effect(ThreadTitleRegenerationService, make);
