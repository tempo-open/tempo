import {
  EventId,
  MessageId,
  PlanId,
  ThreadId,
  TurnItemId,
  type ChatAttachment,
  type TempoThreadMoveId,
  type TempoThreadMoveLink,
  type TempoThreadMoveManifest,
  type TempoThreadMoveMessage,
  type ModelSelection,
  type OrchestrationMessageContext,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import {
  createDeterministicAttachmentId,
  parseAttachmentFileExtension,
  resolveAttachmentPath,
} from "../../attachmentStore.ts";
import { endProductionWait } from "../productionWait/productionWaitDecision.ts";
import { dropGoal } from "../goal/tempoGoalDecision.ts";

/** Thread id a move creates on its target; stable so a retried import finds it. */
export function movedThreadId(moveId: TempoThreadMoveId): ThreadId {
  return ThreadId.make(`tempo-moved-${moveId}`);
}

/**
 * The conversation a thread shows, in display order: its own messages and
 * proposed plans and, for forks, the history it inherited. Tool activity and
 * runs stay behind; the target continues from the conversation alone.
 */
export function exportMovedMessages(
  projection: Pick<OrchestrationV2ThreadProjection, "visibleTurnItems">,
): ReadonlyArray<TempoThreadMoveMessage> {
  return projection.visibleTurnItems
    .toSorted((left, right) => left.position - right.position)
    .flatMap(({ item }): ReadonlyArray<TempoThreadMoveMessage> => {
      const createdAt = item.startedAt ?? item.updatedAt;
      if (item.type === "user_message") {
        return [
          {
            role: "user",
            text: item.text,
            attachments: item.attachments,
            ...(item.context === undefined ? {} : { context: item.context }),
            createdAt,
            updatedAt: item.updatedAt,
          },
        ];
      }
      if (item.type === "assistant_message") {
        if (item.text.trim().length === 0) return [];
        return [
          {
            role: "assistant",
            text: item.text,
            attachments: item.attachments ?? [],
            createdAt,
            updatedAt: item.updatedAt,
          },
        ];
      }
      if (item.type === "proposed_plan") {
        if (item.markdown.trim().length === 0) return [];
        return [
          {
            role: "assistant",
            kind: "plan",
            text: item.markdown,
            attachments: [],
            createdAt,
            updatedAt: item.updatedAt,
          },
        ];
      }
      return [];
    });
}

export interface PathMapping {
  readonly from: string;
  readonly to: string;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Replaces absolute paths under each `from` with the same path under `to`.
 * A match must start and end on a path boundary, so `/repo` never rewrites
 * `/repository` or `/x/repo`. A `file://` URL and a sentence-ending period
 * count as boundaries. Longer prefixes win.
 */
export function rewriteMovedPaths(text: string, mappings: ReadonlyArray<PathMapping>): string {
  const usable = mappings
    .filter((mapping) => mapping.from.length > 1 && mapping.from !== mapping.to)
    .toSorted((left, right) => right.from.length - left.from.length);
  if (usable.length === 0) return text;
  const byFrom = new Map(usable.map((mapping) => [mapping.from, mapping.to]));
  const pattern = new RegExp(
    `(?:(?<=file:\\/\\/)|(?<![\\w.\\/\\\\-]))(${usable.map((mapping) => escapeRegExp(mapping.from)).join("|")})(?=$|[\\/\\\\]|\\.(?:\\s|$)|[^\\w.-])`,
    "g",
  );
  return text.replace(pattern, (match) => byFrom.get(match) ?? match);
}

/** `rewriteMovedPaths` over every string inside a JSON-shaped value. */
function rewriteMovedPathsDeep<T>(value: T, mappings: ReadonlyArray<PathMapping>): T {
  const visit = (current: unknown): unknown => {
    if (typeof current === "string") return rewriteMovedPaths(current, mappings);
    if (Array.isArray(current)) return current.map(visit);
    if (current !== null && typeof current === "object") {
      return Object.fromEntries(Object.entries(current).map(([key, entry]) => [key, visit(entry)]));
    }
    return current;
  };
  // visit keeps the shape: it only replaces string leaves.
  return visit(value) as T;
}

/** The id an attachment gets in the moved thread, keeping any file-extension suffix. */
function movedAttachmentId(threadId: ThreadId, attachmentId: string): string | null {
  const base = createDeterministicAttachmentId(threadId, attachmentId);
  if (base === null) return null;
  const extension = parseAttachmentFileExtension(attachmentId);
  return extension === null ? base : `${base}-${extension}`;
}

export function attachmentArchiveFileName(attachmentId: string): string {
  return `attachment-${attachmentId}`;
}

/**
 * Copies each attachment of `messages` that `sourcePath` finds a file for into
 * `attachmentsDir`, under the id it gets in the moved thread. Returns the source
 * id to new id of every attachment it copied; the others stay behind.
 */
export const copyMovedAttachments = Effect.fn("copyMovedAttachments")(function* (input: {
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<Pick<TempoThreadMoveMessage, "attachments">>;
  readonly attachmentsDir: string;
  /** Where the attachment's file is now; null when it has none. */
  readonly sourcePath: (attachment: ChatAttachment) => string | null;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const attachmentIds = new Map<string, string>();
  const seen = new Set<string>();
  for (const attachment of input.messages.flatMap((message) => message.attachments)) {
    if (seen.has(attachment.id)) continue;
    seen.add(attachment.id);
    const source = input.sourcePath(attachment);
    const id = movedAttachmentId(input.threadId, attachment.id);
    if (source === null || id === null || !(yield* fileSystem.exists(source))) continue;
    const moved: ChatAttachment = { ...attachment, id };
    const target = resolveAttachmentPath({
      attachmentsDir: input.attachmentsDir,
      attachment: moved,
    });
    if (target === null) continue;
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
    yield* fileSystem.copyFile(source, target);
    attachmentIds.set(attachment.id, id);
  }
  return attachmentIds;
});

interface MovedThreadEventsInput {
  /** Every event id starts with it, so the same import writes the same events. */
  readonly eventPrefix: string;
  readonly thread: Pick<
    TempoThreadMoveManifest["thread"],
    | "title"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "createdAt"
    | "linkedPullRequest"
    | "pullRequests"
  >;
  readonly messages: ReadonlyArray<TempoThreadMoveMessage>;
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly branch: string | null;
  /** Null when the thread runs in the project's own checkout. */
  readonly worktreePath: string | null;
  readonly movedFrom: TempoThreadMoveLink;
  readonly now: DateTime.Utc;
  readonly pathMappings: ReadonlyArray<PathMapping>;
  /** Source attachment id to its id here; attachments without one are dropped. */
  readonly attachmentIds: ReadonlyMap<string, string>;
  /**
   * Archive, settle and snooze state and the last update. A moved thread
   * arrives active and awake, updated `now`.
   */
  readonly lifecycle?: Pick<
    OrchestrationV2AppThread,
    "updatedAt" | "archivedAt" | "settledOverride" | "settledAt" | "snoozedUntil" | "snoozedAt"
  >;
}

function remapAttachments(
  attachments: ReadonlyArray<ChatAttachment>,
  attachmentIds: ReadonlyMap<string, string>,
): ReadonlyArray<ChatAttachment> {
  return attachments.flatMap((attachment) => {
    const id = attachmentIds.get(attachment.id);
    return id === undefined ? [] : [{ ...attachment, id }];
  });
}

/**
 * Points a message's image and file context records at the attachments' ids
 * here, as the timeline matches chips to attachments by id. A record whose
 * attachment stayed behind is dropped with it.
 */
function remapMovedContext(
  context: OrchestrationMessageContext,
  attachmentIds: ReadonlyMap<string, string>,
): OrchestrationMessageContext {
  return {
    ...context,
    records: context.records.flatMap((record) => {
      if ((record.kind !== "image" && record.kind !== "file") || !("attachmentId" in record)) {
        return [record];
      }
      const attachmentId = attachmentIds.get(record.attachmentId);
      return attachmentId === undefined ? [] : [{ ...record, attachmentId }];
    }),
  };
}

/**
 * Events that create the moved thread on its target. The history arrives
 * without runs (`historyOrigin: "v1_import"`), which is what makes the next
 * turn start a fresh provider session primed with a context handoff of it.
 * Event ids derive from `eventPrefix`, so the same import writes the same events.
 */
export function buildMovedThreadEvents(
  input: MovedThreadEventsInput,
): ReadonlyArray<OrchestrationV2DomainEvent> {
  const { threadId } = input;
  const prefix = input.eventPrefix;
  const lifecycle = input.lifecycle ?? {
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
  };
  const thread: OrchestrationV2AppThread = {
    createdBy: "system",
    creationSource: "server",
    id: threadId,
    projectId: input.projectId,
    title: input.thread.title,
    providerInstanceId: input.thread.modelSelection.instanceId,
    modelSelection: input.thread.modelSelection,
    runtimeMode: input.thread.runtimeMode,
    interactionMode: input.thread.interactionMode,
    branch: input.branch,
    worktreePath: input.worktreePath,
    linkedPullRequest: input.thread.linkedPullRequest ?? null,
    ...(input.thread.pullRequests === undefined || input.thread.pullRequests.length === 0
      ? {}
      : { pullRequests: input.thread.pullRequests }),
    branchPullRequest: null,
    activeProviderThreadId: null,
    historyOrigin: "v1_import",
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: input.thread.createdAt,
    updatedAt: lifecycle.updatedAt,
    archivedAt: lifecycle.archivedAt,
    settledOverride: lifecycle.settledOverride,
    settledAt: lifecycle.settledAt,
    // A wake time already past is kept too: the thread reads as awake, as it does wherever it was.
    snoozedUntil: lifecycle.snoozedUntil ?? null,
    snoozedAt: lifecycle.snoozedAt ?? null,
    lastVisitedAt: null,
    deletedAt: null,
    movedFrom: input.movedFrom,
  };
  const messageEvents = input.messages.flatMap(
    (source, index): ReadonlyArray<OrchestrationV2DomainEvent> => {
      const suffix = String(index).padStart(6, "0");
      const messageId = MessageId.make(`${threadId}:${suffix}`);
      const text = rewriteMovedPaths(source.text, input.pathMappings);
      const attachments = remapAttachments(source.attachments, input.attachmentIds);
      const context =
        source.context === undefined
          ? undefined
          : remapMovedContext(
              rewriteMovedPathsDeep(source.context, input.pathMappings),
              input.attachmentIds,
            );
      const message: OrchestrationV2ConversationMessage = {
        createdBy: source.role === "user" ? "user" : "agent",
        creationSource: "server",
        id: messageId,
        threadId,
        runId: null,
        nodeId: null,
        role: source.role,
        text,
        ...(context === undefined ? {} : { context }),
        attachments,
        streaming: false,
        createdAt: source.createdAt,
        updatedAt: source.updatedAt,
      };
      const base = {
        id: TurnItemId.make(`${threadId}:item:${suffix}`),
        threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: index + 1,
        status: "completed" as const,
        title: null,
        startedAt: source.createdAt,
        completedAt: source.updatedAt,
        updatedAt: source.updatedAt,
      };
      const turnItemEvent = (item: OrchestrationV2TurnItem): OrchestrationV2DomainEvent => ({
        id: EventId.make(`${prefix}:turn-item:${suffix}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: source.updatedAt,
        payload: item,
      });
      if (source.kind === "plan") {
        // A plan is a turn item of its own, not a conversation message.
        return [
          turnItemEvent({
            ...base,
            type: "proposed_plan",
            planId: PlanId.make(`${threadId}:plan:${suffix}`),
            markdown: text,
            streaming: false,
          }),
        ];
      }
      const item: OrchestrationV2TurnItem =
        source.role === "user"
          ? {
              ...base,
              createdBy: "user",
              creationSource: "server",
              type: "user_message",
              messageId,
              inputIntent: "turn_start",
              text,
              ...(context === undefined ? {} : { context }),
              attachments,
            }
          : {
              ...base,
              type: "assistant_message",
              messageId,
              text,
              ...(attachments.length === 0 ? {} : { attachments }),
              streaming: false,
            };
      return [
        {
          id: EventId.make(`${prefix}:message:${suffix}`),
          type: "message.updated",
          threadId,
          occurredAt: source.updatedAt,
          payload: message,
        },
        turnItemEvent(item),
      ];
    },
  );
  return [
    {
      id: EventId.make(`${prefix}:thread-created`),
      type: "thread.created",
      threadId,
      providerInstanceId: thread.providerInstanceId,
      occurredAt: input.now,
      payload: thread,
    },
    ...messageEvents,
  ];
}

/**
 * The stub a moved-away source thread becomes: same history, `movedTo` set,
 * settled, and no longer waiting for production or holding a goal, since a
 * stub takes no wake or turn; the moved copy carries the goal on.
 */
export function movedAwayThread(
  thread: OrchestrationV2AppThread,
  movedTo: TempoThreadMoveLink,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  return {
    ...thread,
    ...endProductionWait(thread),
    ...dropGoal(thread),
    movedTo,
    settledOverride: "settled",
    settledAt: now,
    pinnedAt: null,
    pinOrderKey: null,
    updatedAt: now,
  };
}

/**
 * The model selection a moved thread starts with here. The source's provider
 * instance wins when this environment has it enabled; otherwise the first
 * enabled instance of the same driver keeps the model. With neither, the
 * selection stays and the user picks a model before continuing.
 */
export function resolveMovedModelSelection(input: {
  readonly modelSelection: ModelSelection;
  readonly providerDriver: string | null;
  readonly instances: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly driverKind: string;
    readonly enabled: boolean;
  }>;
}): { readonly modelSelection: ModelSelection; readonly available: boolean } {
  const enabled = input.instances.filter((instance) => instance.enabled);
  if (enabled.some((instance) => instance.instanceId === input.modelSelection.instanceId)) {
    return { modelSelection: input.modelSelection, available: true };
  }
  const sameDriver =
    input.providerDriver === null
      ? undefined
      : enabled.find((instance) => instance.driverKind === input.providerDriver);
  return sameDriver === undefined
    ? { modelSelection: input.modelSelection, available: false }
    : {
        modelSelection: { ...input.modelSelection, instanceId: sameDriver.instanceId },
        available: true,
      };
}
