/**
 * tempo: the pages a thread shared (tempoThreadPages.ts), with each page's own title, line about it,
 * preview picture and emoji.
 * A page is read at most once an hour; one that is signed in only or does not answer keeps the
 * reply's name for it, and one that answers with something other than a page is left out.
 */
import {
  TempoThreadPagesError,
  type TempoThreadPages,
  type TempoThreadPagesInput,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import { pageTitleFromUrl } from "@t3tools/shared/tempoPageLinks";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import { readPageHead, readPageMeta, type PageMeta } from "./pageMeta.ts";
import { threadPageLinks, type AgentReply } from "./threadPageLinks.ts";

const VISIT_TIMEOUT = Duration.seconds(8);
const VISIT_CONCURRENCY = 6;
const HEADERS = { "user-agent": `${TEMPO_APP_BASE_NAME} (page preview)`, accept: "text/html" };

type PageVisit =
  | ({ readonly _tag: "page" } & PageMeta)
  | { readonly _tag: "notPage" }
  | { readonly _tag: "unread" };

const UNREAD: PageVisit = { _tag: "unread" };
const NOT_PAGE: PageVisit = { _tag: "notPage" };

export class ThreadPages extends Context.Service<
  ThreadPages,
  {
    readonly list: (
      input: TempoThreadPagesInput,
    ) => Effect.Effect<TempoThreadPages, TempoThreadPagesError>;
  }
>()("t3/tempo/threadPages/ThreadPages") {}

export const layer = Layer.effect(
  ThreadPages,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const threads = yield* ThreadManagementService.ThreadManagementService;
    const httpClient = yield* HttpClient.HttpClient;

    const visit = Effect.fn("ThreadPages.visit")(
      function* (url: string) {
        const response = yield* httpClient.execute(
          HttpClientRequest.get(url).pipe(HttpClientRequest.setHeaders(HEADERS)),
        );
        // A redirect is a sign in page, and so are 401 and 403.
        if (response.status >= 300 && response.status < 400) return UNREAD;
        if (response.status === 401 || response.status === 403) return UNREAD;
        if (response.status >= 400 && response.status < 500) return NOT_PAGE;
        if (response.status >= 500) return UNREAD;
        const type = response.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
        if (type !== "text/html" && type !== "application/xhtml+xml") return NOT_PAGE;
        const head = yield* readPageHead(response.stream);
        return { _tag: "page", ...readPageMeta(head, url) } satisfies PageVisit;
      },
      (effect, url) =>
        effect.pipe(
          Effect.timeout(VISIT_TIMEOUT),
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.interrupt
              : Effect.logDebug("Shared page did not answer", { url, cause }).pipe(
                  Effect.as(UNREAD),
                ),
          ),
        ),
    );
    const visits = yield* Cache.makeWith(visit, {
      capacity: 512,
      timeToLive: (exit) =>
        Exit.isSuccess(exit) && exit.value._tag !== "unread" ? "1 hour" : "1 minute",
    });

    return ThreadPages.of({
      list: Effect.fn("ThreadPages.list")(
        function* (input: TempoThreadPagesInput) {
          // A migrated V1 thread's messages are only in the projection once hydrated.
          yield* threads.ensureLegacyTranscript(input.threadId);
          const replies = yield* sql<AgentReply>`
            SELECT json_extract(payload_json, '$.text') AS text, created_at AS "createdAt"
            FROM orchestration_v2_projection_messages
            WHERE thread_id = ${input.threadId} AND role = 'assistant' AND streaming = 0
              AND json_extract(payload_json, '$.text') LIKE '%http%'
            ORDER BY created_at, message_id`;
          const pages = yield* Effect.forEach(
            threadPageLinks(replies),
            (link) =>
              Effect.map(Cache.get(visits, link.url), (visit) => {
                if (visit._tag === "notPage") return [];
                const page = visit._tag === "page" ? visit : null;
                return [
                  {
                    url: link.url,
                    title: page?.title ?? link.label ?? pageTitleFromUrl(link.url),
                    about: page?.about ?? null,
                    picture: page?.picture ?? null,
                    emoji: page?.emoji ?? null,
                    sharedAt: link.sharedAt,
                  },
                ];
              }),
            { concurrency: VISIT_CONCURRENCY },
          );
          return { pages: pages.flat() };
        },
        (effect, input) =>
          effect.pipe(
            Effect.mapError(
              (cause) => new TempoThreadPagesError({ threadId: input.threadId, cause }),
            ),
          ),
      ),
    });
  }),
);
