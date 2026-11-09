/**
 * tempo: the messages a person sent in a thread, for the agent working in it. Compaction and
 * long turns push early requests out of the agent's context; the thread keeps all of them,
 * so the agent can reread them and check it did everything that was asked.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, NonNegativeInt, PositiveInt, ThreadId } from "./baseSchemas.ts";

export const TempoUserMessagesInput = Schema.Struct({
  threadId: Schema.optional(ThreadId).annotate({ description: "Omit for this thread." }),
  query: Schema.optional(Schema.String.check(Schema.isMaxLength(500))).annotate({
    description: "Keeps messages that contain every word of it, ignoring case.",
  }),
  cursor: Schema.optional(NonNegativeInt).annotate({
    description: "nextCursor from the previous call.",
  }),
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  maxCharsPerMessage: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 200, maximum: 50_000 })),
  ),
});
export type TempoUserMessagesInput = typeof TempoUserMessagesInput.Type;

export const TempoUserMessage = Schema.Struct({
  /** 1 for the first message the person sent in the thread. */
  number: PositiveInt,
  messageId: MessageId,
  sentAt: IsoDateTime,
  text: Schema.String,
  textTruncated: Schema.Boolean,
  /** Names of the files and images sent with it. */
  attachments: Schema.Array(Schema.String),
});
export type TempoUserMessage = typeof TempoUserMessage.Type;

export const TempoUserMessagesResult = Schema.Struct({
  threadId: ThreadId,
  /** Every message the person sent in the thread. */
  total: NonNegativeInt,
  /** Those that match `query`; all of them without one. */
  matches: NonNegativeInt,
  messages: Schema.Array(TempoUserMessage),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type TempoUserMessagesResult = typeof TempoUserMessagesResult.Type;
