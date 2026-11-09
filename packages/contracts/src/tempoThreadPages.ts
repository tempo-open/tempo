/**
 * tempo: the pages a thread's agent shared, from the links in its replies to sites that host the
 * pages it makes. The side panel's Deliverables tab lists them beside the thread's pull requests.
 */
import * as Effect from "effect/Effect";
import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import { IsoDateTime, ThreadId } from "./baseSchemas.ts";

export const TempoThreadPagesInput = Schema.Struct({ threadId: ThreadId });
export type TempoThreadPagesInput = typeof TempoThreadPagesInput.Type;

export const TempoThreadPage = Schema.Struct({
  /** The link's href without its fragment or a slash at the end of its path; a site root keeps "/". */
  url: Schema.String,
  /** The page's own title, else the reply's name for the link, else a name read from the address. */
  title: Schema.String,
  /** The page's one line about itself (`og:description`), when the page answers without a sign in. */
  about: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** The page's preview picture (`og:image`), when the page answers without a sign in. */
  picture: Schema.NullOr(Schema.String),
  /** The one emoji the page's icon draws, when its icon is an SVG of that emoji. */
  emoji: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
  /** When a reply last linked the page. */
  sharedAt: IsoDateTime,
});
export type TempoThreadPage = typeof TempoThreadPage.Type;

/** Newest first. */
export const TempoThreadPages = Schema.Struct({ pages: Schema.Array(TempoThreadPage) });
export type TempoThreadPages = typeof TempoThreadPages.Type;

export class TempoThreadPagesError extends Schema.TaggedError<TempoThreadPagesError>()(
  "TempoThreadPagesError",
  { threadId: ThreadId, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not read this thread's pages.";
  }
}

export const TEMPO_THREAD_PAGES_WS_METHODS = {
  list: "tempo.threadPages.list",
} as const;

export const TempoThreadPagesListRpc = Rpc.make(TEMPO_THREAD_PAGES_WS_METHODS.list, {
  payload: TempoThreadPagesInput,
  success: TempoThreadPages,
  error: Schema.Union([TempoThreadPagesError, EnvironmentAuthorizationError]),
});
