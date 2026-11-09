/**
 * tempo: a thread's outline, one entry per user message, oldest first. The web minimap marks every
 * message of a long thread with it while only the latest turns are loaded.
 */
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, MessageId, ThreadId } from "./baseSchemas.ts";

/** The most characters of a message an outline entry carries. */
export const TEMPO_THREAD_OUTLINE_TEXT_LIMIT = 160;

export const TempoThreadOutlineInput = Schema.Struct({ threadId: ThreadId });
export type TempoThreadOutlineInput = typeof TempoThreadOutlineInput.Type;

export const TempoThreadOutlineEntry = Schema.Struct({
  /** The message's id, which is also its timeline entry id. */
  id: MessageId,
  /** The message's start, whitespace collapsed, at most `TEMPO_THREAD_OUTLINE_TEXT_LIMIT` long. */
  text: Schema.String,
  createdAt: IsoDateTime,
});
export type TempoThreadOutlineEntry = typeof TempoThreadOutlineEntry.Type;

export const TempoThreadOutline = Schema.Struct({
  entries: Schema.Array(TempoThreadOutlineEntry),
});
export type TempoThreadOutline = typeof TempoThreadOutline.Type;

export class TempoThreadOutlineError extends Schema.TaggedError<TempoThreadOutlineError>()(
  "TempoThreadOutlineError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read this thread's messages.";
  }
}

export const TEMPO_THREAD_OUTLINE_WS_METHODS = {
  get: "tempo.threadOutline.get",
} as const;

export const TempoThreadOutlineGetRpc = Rpc.make(TEMPO_THREAD_OUTLINE_WS_METHODS.get, {
  payload: TempoThreadOutlineInput,
  success: TempoThreadOutline,
  error: Schema.Union([TempoThreadOutlineError, EnvironmentAuthorizationError]),
});
