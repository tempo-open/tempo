/**
 * Typed calls to OpenRouter's key management API and Cloudflare's API on
 * ServiceConnections.request, so the same policy, redaction, and audit apply as to a hand-written
 * request. A key OpenRouter creates is written to a file and never returned: a tool result is
 * stored in thread history, sent to every client, and kept in the provider's own transcript.
 */
import {
  TempoServiceError,
  type TempoServiceKind,
  type TempoServiceMethod,
  type TempoServiceRequestResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServiceConnections from "./ServiceConnections.ts";
import { makeSecretRedactor, redactJsonValue, type ServiceQuery } from "./serviceRequestPolicy.ts";

type Result = Effect.Effect<TempoServiceRequestResult, TempoServiceError>;

/** Which connection to use when several of the kind exist; omitted, the only one. */
interface Via {
  readonly service?: string | undefined;
}

export interface OpenRouterKeyLimit {
  /** USD; null removes the limit. */
  readonly limit?: number | null | undefined;
  readonly limitReset?: "daily" | "weekly" | "monthly" | null | undefined;
}

export interface CloudflareDnsRecord {
  readonly zoneId: string;
  /** Updates this record; omitted, the record with this type and name, else a new one. */
  readonly recordId?: string | undefined;
  readonly type: string;
  /** The full record name, such as www.example.com. */
  readonly name: string;
  readonly content: string;
  readonly ttl?: number | undefined;
  readonly proxied?: boolean | undefined;
  readonly comment?: string | undefined;
}

export class CompanyServiceApis extends Context.Service<
  CompanyServiceApis,
  {
    readonly openrouterKeysList: (
      input: Via & {
        readonly offset?: number | undefined;
        readonly includeDisabled?: boolean | undefined;
      },
    ) => Result;
    /**
     * Creates a key and writes it to `saveTo`, a new absolute file path
     * (owner-only). The result has the key's value replaced by where it went.
     */
    readonly openrouterKeyCreate: (
      input: Via & OpenRouterKeyLimit & { readonly name: string; readonly saveTo: string },
    ) => Result;
    readonly openrouterKeyUpdate: (
      input: Via &
        OpenRouterKeyLimit & {
          readonly hash: string;
          readonly name?: string | undefined;
          readonly disabled?: boolean | undefined;
        },
    ) => Result;
    readonly openrouterKeyDelete: (input: Via & { readonly hash: string }) => Result;
    readonly openrouterCredits: (input: Via) => Result;
    readonly openrouterActivity: (input: Via & { readonly date?: string | undefined }) => Result;
    readonly cloudflareZonesList: (
      input: Via & {
        readonly name?: string | undefined;
        readonly accountId?: string | undefined;
        readonly page?: number | undefined;
        readonly perPage?: number | undefined;
      },
    ) => Result;
    readonly cloudflareDnsRecordsList: (
      input: Via & {
        readonly zoneId: string;
        readonly type?: string | undefined;
        readonly name?: string | undefined;
        readonly page?: number | undefined;
        readonly perPage?: number | undefined;
      },
    ) => Result;
    /** Updates the matching record or creates one; two matches is an error that lists them. */
    readonly cloudflareDnsRecordUpsert: (input: Via & CloudflareDnsRecord) => Result;
    readonly cloudflareWorkersList: (input: Via & { readonly accountId: string }) => Result;
  }
>()("t3/tempo/CompanyServiceApis") {}

// Ids become path segments, so they may not carry "/", "..", or anything to encode.
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Drops undefined values so they are not sent as "undefined". */
function definedQuery(values: Record<string, string | number | boolean | undefined>): ServiceQuery {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, string | number | boolean] => entry[1] !== undefined,
    ),
  );
}

function definedBody(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

const make = Effect.gen(function* () {
  const connections = yield* ServiceConnections.ServiceConnections;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const segment = (label: string, value: string): Effect.Effect<string, TempoServiceError> =>
    ID_PATTERN.test(value)
      ? Effect.succeed(value)
      : Effect.fail(
          new TempoServiceError({
            reason: "invalid_request",
            detail: `${label} must be letters, digits, dashes, or underscores.`,
          }),
        );

  type RequestOptions = { readonly query?: ServiceQuery; readonly body?: unknown };

  /** One request through the connection `id`, already resolved. */
  const send = (
    id: string,
    method: TempoServiceMethod,
    requestPath: string,
    options: RequestOptions = {},
  ) =>
    connections.request({
      service: id,
      method,
      path: requestPath,
      ...(options.query === undefined ? {} : { query: options.query }),
      ...(options.body === undefined ? {} : { body: options.body }),
    });

  const call = (
    kind: TempoServiceKind,
    via: Via,
    method: TempoServiceMethod,
    requestPath: string,
    options: RequestOptions = {},
  ) =>
    connections
      .resolveKind(kind, via.service)
      .pipe(Effect.flatMap((connection) => send(connection.id, method, requestPath, options)));

  const limitBody = (input: OpenRouterKeyLimit) =>
    definedBody({ limit: input.limit, limit_reset: input.limitReset });

  const openrouterKeysList: CompanyServiceApis["Service"]["openrouterKeysList"] = (input) =>
    call("openrouter", input, "GET", "/keys", {
      query: definedQuery({ offset: input.offset, include_disabled: input.includeDisabled }),
    });

  const openrouterKeyCreate: CompanyServiceApis["Service"]["openrouterKeyCreate"] = Effect.fn(
    "CompanyServiceApis.openrouterKeyCreate",
  )(function* (input) {
    const invalid = (detail: string) =>
      new TempoServiceError({ reason: "invalid_request", detail });
    if (!path.isAbsolute(input.saveTo)) {
      return yield* invalid("saveTo must be an absolute file path.");
    }
    const target = path.resolve(input.saveTo);
    // Checked before the key exists, so a bad path never strands a new key.
    if (yield* fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false))) {
      return yield* invalid(`${target} already exists; pass a new file path as saveTo.`);
    }
    const result = yield* call("openrouter", input, "POST", "/keys", {
      body: { name: input.name, ...limitBody(input) },
    });
    const created = createdKey(result.body);
    if (created === null) return result;
    yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true }).pipe(
      Effect.andThen(
        fileSystem.writeFileString(target, `${created.key}\n`, { flag: "wx", mode: 0o600 }),
      ),
      Effect.mapError(
        () =>
          new TempoServiceError({
            reason: "key_not_saved",
            service: result.service,
            detail: `Delete it with openrouter_key_delete${created.hash === null ? "" : ` (hash ${created.hash})`}, then create another with a new saveTo.`,
          }),
      ),
    );
    const replace = makeSecretRedactor([created.key], `[saved to ${target}]`);
    return {
      ...result,
      headers: Object.fromEntries(
        Object.entries(result.headers).map(([name, value]) => [name, replace(value)]),
      ),
      body:
        typeof result.body === "string"
          ? replace(result.body)
          : redactJsonValue(result.body, replace),
    };
  });

  const openrouterKeyUpdate: CompanyServiceApis["Service"]["openrouterKeyUpdate"] = (input) =>
    segment("hash", input.hash).pipe(
      Effect.flatMap((hash) =>
        call("openrouter", input, "PATCH", `/keys/${hash}`, {
          body: definedBody({ name: input.name, disabled: input.disabled, ...limitBody(input) }),
        }),
      ),
    );

  const openrouterKeyDelete: CompanyServiceApis["Service"]["openrouterKeyDelete"] = (input) =>
    segment("hash", input.hash).pipe(
      Effect.flatMap((hash) => call("openrouter", input, "DELETE", `/keys/${hash}`)),
    );

  const openrouterCredits: CompanyServiceApis["Service"]["openrouterCredits"] = (input) =>
    call("openrouter", input, "GET", "/credits");

  const openrouterActivity: CompanyServiceApis["Service"]["openrouterActivity"] = (input) =>
    call("openrouter", input, "GET", "/activity", { query: definedQuery({ date: input.date }) });

  const cloudflareZonesList: CompanyServiceApis["Service"]["cloudflareZonesList"] = (input) =>
    call("cloudflare", input, "GET", "/zones", {
      query: definedQuery({
        name: input.name,
        "account.id": input.accountId,
        page: input.page,
        per_page: input.perPage,
      }),
    });

  const cloudflareDnsRecordsList: CompanyServiceApis["Service"]["cloudflareDnsRecordsList"] = (
    input,
  ) =>
    segment("zoneId", input.zoneId).pipe(
      Effect.flatMap((zoneId) =>
        call("cloudflare", input, "GET", `/zones/${zoneId}/dns_records`, {
          query: definedQuery({
            type: input.type,
            name: input.name,
            page: input.page,
            per_page: input.perPage,
          }),
        }),
      ),
    );

  const cloudflareDnsRecordUpsert: CompanyServiceApis["Service"]["cloudflareDnsRecordUpsert"] =
    Effect.fn("CompanyServiceApis.cloudflareDnsRecordUpsert")(function* (input) {
      const zoneId = yield* segment("zoneId", input.zoneId);
      const record = definedBody({
        type: input.type,
        name: input.name,
        content: input.content,
        ttl: input.ttl,
        proxied: input.proxied,
        comment: input.comment,
      });
      // Pin the connection once, so the lookup and the write go to the same account.
      const connection = yield* connections.resolveKind("cloudflare", input.service);
      if (input.recordId !== undefined) {
        const recordId = yield* segment("recordId", input.recordId);
        return yield* send(connection.id, "PATCH", `/zones/${zoneId}/dns_records/${recordId}`, {
          body: record,
        });
      }
      const existing = yield* send(connection.id, "GET", `/zones/${zoneId}/dns_records`, {
        query: { type: input.type, name: input.name },
      });
      if (existing.status < 200 || existing.status >= 300) return existing;
      const ids = recordIds(existing.body);
      if (ids === null) {
        return yield* new TempoServiceError({
          reason: "bad_response",
          service: connection.id,
          detail: "Cloudflare's record list could not be read; pass recordId to update a record.",
        });
      }
      if (ids.length > 1) {
        return yield* new TempoServiceError({
          reason: "invalid_request",
          service: connection.id,
          detail: `Several ${input.type} records are named ${input.name} (${ids.join(", ")}); pass recordId to choose one.`,
        });
      }
      const [recordId] = ids;
      return recordId === undefined
        ? yield* send(connection.id, "POST", `/zones/${zoneId}/dns_records`, { body: record })
        : yield* send(connection.id, "PATCH", `/zones/${zoneId}/dns_records/${recordId}`, {
            body: record,
          });
    });

  const cloudflareWorkersList: CompanyServiceApis["Service"]["cloudflareWorkersList"] = (input) =>
    segment("accountId", input.accountId).pipe(
      Effect.flatMap((accountId) =>
        call("cloudflare", input, "GET", `/accounts/${accountId}/workers/scripts`),
      ),
    );

  return CompanyServiceApis.of({
    openrouterKeysList,
    openrouterKeyCreate,
    openrouterKeyUpdate,
    openrouterKeyDelete,
    openrouterCredits,
    openrouterActivity,
    cloudflareZonesList,
    cloudflareDnsRecordsList,
    cloudflareDnsRecordUpsert,
    cloudflareWorkersList,
  });
});

/** The key an OpenRouter create answered with (`{ key, data: { hash } }`), or null. */
function createdKey(body: unknown): { readonly key: string; readonly hash: string | null } | null {
  if (typeof body !== "object" || body === null) return null;
  const { key, data } = body as { readonly key?: unknown; readonly data?: unknown };
  if (typeof key !== "string" || key === "") return null;
  const hash =
    typeof data === "object" && data !== null ? (data as { readonly hash?: unknown }).hash : null;
  return { key, hash: typeof hash === "string" ? hash : null };
}

/** The ids in a Cloudflare list body (`{ result: [{ id }] }`), or null when it is not one. */
function recordIds(body: unknown): ReadonlyArray<string> | null {
  if (typeof body !== "object" || body === null) return null;
  const result = (body as { readonly result?: unknown }).result;
  if (!Array.isArray(result)) return null;
  return result.flatMap((record: unknown) =>
    typeof record === "object" &&
    record !== null &&
    typeof (record as { readonly id?: unknown }).id === "string"
      ? [(record as { readonly id: string }).id]
      : [],
  );
}

export const layer = Layer.effect(CompanyServiceApis, make);
