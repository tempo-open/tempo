/**
 * Services agents call without seeing their keys. Each connection (`local/<name>`) is saved on this
 * environment and called directly under its own policy, pinned to the base URL with no redirects.
 * Responses are capped at 1 MB, keep only safe headers, and have every known secret redacted.
 */
import {
  TEMPO_SERVICE_READ_METHODS,
  type TempoLocalServiceConnection,
  type TempoLocalServiceConnectionInput,
  type TempoServiceConnection,
  type TempoServiceConnectionsSnapshot,
  TempoServiceError,
  TempoServiceKind,
  TempoServiceMethod,
  type TempoServiceRequestResult,
  type TempoServiceTestResult,
  tempoServiceKindLabel,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { type CappedResponse, executeCapped } from "./serviceHttp.ts";
import {
  appendServiceQuery,
  decodeServiceBody,
  makeSecretRedactor,
  normalizeServiceBaseUrl,
  normalizeServicePathPrefix,
  pathAllowedByPrefixes,
  redactJsonValue,
  resolveServiceUrl,
  safeResponseHeaders,
  type ServiceQuery,
} from "./serviceRequestPolicy.ts";

/** One file in the server secret store: the connections and their secrets together. */
const LOCAL_CONNECTIONS_SECRET = "tempo-service-connections";

const StoredLocalConnection = Schema.Struct({
  name: Schema.String,
  kind: TempoServiceKind,
  description: Schema.String,
  baseUrl: Schema.String,
  authHeader: Schema.String,
  authScheme: Schema.String,
  secret: Schema.String,
  allowedMethods: Schema.Array(TempoServiceMethod),
  allowedPathPrefixes: Schema.Array(Schema.String),
});
type StoredLocalConnection = typeof StoredLocalConnection.Type;

const StoredLocalConnections = Schema.Struct({
  version: Schema.Literal(1),
  connections: Schema.Array(StoredLocalConnection),
});
const encodeStored = Schema.encodeEffect(Schema.fromJsonString(StoredLocalConnections));
// Read leniently: an entry this build cannot read (a kind or method from a newer
// one, a hand edit) is skipped, so it cannot block every other connection. The
// next save drops it.
const decodeStoredEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({ version: Schema.Number, connections: Schema.Array(Schema.Unknown) }),
  ),
);
const decodeStoredConnection = Schema.decodeUnknownOption(StoredLocalConnection);

// Headers a connection may not use for its secret: the transport owns them.
const RESERVED_AUTH_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "accept",
]);

const METHOD_ORDER: ReadonlyArray<TempoServiceMethod> = TempoServiceMethod.literals;

interface TestProbe {
  readonly path: string;
  readonly query?: ServiceQuery;
}

/**
 * Reads each kind answers with a valid credential, tried in order until one
 * succeeds; `http` reads its first allowed path. Cloudflare verifies only
 * user-owned tokens at /user/tokens/verify, so an account-owned token is
 * checked by listing zones instead.
 */
const TEST_PROBES: Readonly<Record<TempoServiceKind, ReadonlyArray<TestProbe> | null>> = {
  openrouter: [{ path: "/key" }],
  cloudflare: [{ path: "/user/tokens/verify" }, { path: "/zones", query: { per_page: 5 } }],
  http: null,
};

const INVALID_PATH_DETAIL =
  "Pass a path below the connection's base URL, without a query, fragment, or ..";

export interface ServiceRequestInput {
  /** `local/<name>`, or a bare name that matches one connection. */
  readonly service: string;
  readonly method: TempoServiceMethod;
  readonly path: string;
  readonly query?: ServiceQuery | undefined;
  /** Sent as JSON; GET and HEAD cannot carry one. */
  readonly body?: unknown;
}

interface Target {
  readonly id: string;
  readonly connection: StoredLocalConnection;
}

/** The name in `local/<name>` or a bare `<name>`. */
function serviceName(service: string): string {
  const trimmed = service.trim();
  return trimmed.startsWith("local/") ? trimmed.slice("local/".length) : trimmed;
}

const writable = (methods: ReadonlyArray<TempoServiceMethod>) =>
  methods.some((method) => !TEMPO_SERVICE_READ_METHODS.has(method));

function localView(connection: StoredLocalConnection): TempoLocalServiceConnection {
  return {
    id: `local/${connection.name}`,
    name: connection.name,
    kind: connection.kind,
    description: connection.description,
    baseUrl: connection.baseUrl,
    allowedMethods: connection.allowedMethods,
    allowedPathPrefixes: connection.allowedPathPrefixes,
    writable: writable(connection.allowedMethods),
    authHeader: connection.authHeader,
    authScheme: connection.authScheme,
  };
}

function agentView(connection: TempoLocalServiceConnection): TempoServiceConnection {
  const { authHeader: _authHeader, authScheme: _authScheme, ...view } = connection;
  return view;
}

function testMessage(id: string, status: number): TempoServiceTestResult {
  if (status >= 200 && status < 300) {
    return { ok: true, status, message: `${id} answered HTTP ${status}.` };
  }
  if (status === 401 || status === 403) {
    return {
      ok: false,
      status,
      message: `${id} refused the credential (HTTP ${status}). Check the secret, auth header, and scheme.`,
    };
  }
  return { ok: false, status, message: `${id} answered HTTP ${status}.` };
}

export class ServiceConnections extends Context.Service<
  ServiceConnections,
  {
    /** The saved connections, for settings. */
    readonly snapshot: Effect.Effect<TempoServiceConnectionsSnapshot, TempoServiceError>;
    /** Every connection an agent may call. */
    readonly list: Effect.Effect<ReadonlyArray<TempoServiceConnection>, TempoServiceError>;
    /** Whether a local connection is saved. Unreadable storage counts as none. */
    readonly hasLocal: Effect.Effect<boolean>;
    /** The connection of `kind` that `service` names, or the only one of that kind. */
    readonly resolveKind: (
      kind: TempoServiceKind,
      service: string | undefined,
    ) => Effect.Effect<TempoServiceConnection, TempoServiceError>;
    /** Sends one request under the connection's policy. Non-2xx answers are results, not failures. */
    readonly request: (
      input: ServiceRequestInput,
    ) => Effect.Effect<TempoServiceRequestResult, TempoServiceError>;
    /** `value` with every saved secret replaced by `[redacted]`, at any depth. */
    readonly redactKnown: <A>(value: A) => Effect.Effect<A, TempoServiceError>;
    /** Adds or replaces a local connection; its secret is kept when omitted and the host is unchanged. */
    readonly saveLocal: (
      input: TempoLocalServiceConnectionInput,
    ) => Effect.Effect<TempoServiceConnectionsSnapshot, TempoServiceError>;
    readonly removeLocal: (
      name: string,
    ) => Effect.Effect<TempoServiceConnectionsSnapshot, TempoServiceError>;
    /** One read through the connection, ignoring its method and path policy but not its host. */
    readonly test: (id: string) => Effect.Effect<TempoServiceTestResult, TempoServiceError>;
  }
>()("t3/tempo/ServiceConnections") {}

const make = Effect.gen(function* () {
  const secretStore = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const writeLock = yield* Semaphore.make(1);

  const storageError = (cause: unknown) => new TempoServiceError({ reason: "storage", cause });

  const decodeLocal = Effect.fn("ServiceConnections.decodeLocal")(function* (bytes: Uint8Array) {
    const envelope = decodeStoredEnvelope(new TextDecoder().decode(bytes));
    if (Option.isNone(envelope)) {
      yield* Effect.logWarning("Service connections could not be read; ignoring them.");
      return [];
    }
    const connections = envelope.value.connections.flatMap((raw) =>
      Option.toArray(decodeStoredConnection(raw)),
    );
    const skipped = envelope.value.connections.length - connections.length;
    if (skipped > 0) {
      yield* Effect.logWarning("Skipped service connections this build cannot read.", {
        skipped,
      });
    }
    return connections;
  });

  const loadLocal: Effect.Effect<
    ReadonlyArray<StoredLocalConnection>,
    TempoServiceError
  > = secretStore.get(LOCAL_CONNECTIONS_SECRET).pipe(
    Effect.mapError(storageError),
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.succeed<ReadonlyArray<StoredLocalConnection>>([]),
        onSome: decodeLocal,
      }),
    ),
  );

  const saveAll = (connections: ReadonlyArray<StoredLocalConnection>) =>
    encodeStored({ version: 1, connections }).pipe(
      Effect.flatMap((json) =>
        secretStore.set(LOCAL_CONNECTIONS_SECRET, new TextEncoder().encode(json)),
      ),
      Effect.mapError(storageError),
    );

  const snapshot: ServiceConnections["Service"]["snapshot"] = loadLocal.pipe(
    Effect.map((local) => ({ local: local.map(localView) })),
    Effect.withSpan("ServiceConnections.snapshot"),
  );

  const list: ServiceConnections["Service"]["list"] = snapshot.pipe(
    Effect.map(({ local }) => local.map(agentView)),
  );

  const resolveTarget = Effect.fn("ServiceConnections.resolveTarget")(function* (service: string) {
    const name = serviceName(service);
    if (name === "") return yield* new TempoServiceError({ reason: "not_found", service });
    const local = yield* loadLocal;
    const connection = local.find((candidate) => candidate.name === name);
    if (connection === undefined) {
      return yield* new TempoServiceError({
        reason: "not_found",
        service,
        options: local.map((candidate) => `local/${candidate.name}`),
      });
    }
    return { id: `local/${name}`, connection } satisfies Target;
  });

  /** Every saved secret: whatever a response must never echo back. */
  const knownSecrets = loadLocal.pipe(
    Effect.orElseSucceed((): ReadonlyArray<StoredLocalConnection> => []),
    Effect.map((local) => local.map((connection) => connection.secret)),
  );

  // JSON-shaped values keep their shape: only strings and keys change.
  const redactKnown = <A>(value: A) =>
    Effect.map(knownSecrets, (secrets) => redactJsonValue(value, makeSecretRedactor(secrets)) as A);

  const send = Effect.fn("ServiceConnections.send")(function* (
    target: Target,
    input: Omit<ServiceRequestInput, "service">,
    enforcePolicy: boolean,
  ) {
    const { connection, id } = target;
    if (enforcePolicy && !connection.allowedMethods.includes(input.method)) {
      return yield* new TempoServiceError({
        reason: "method_not_allowed",
        service: id,
        method: input.method,
        options: connection.allowedMethods,
      });
    }
    const resolved = resolveServiceUrl(connection.baseUrl, input.path);
    if (resolved._tag !== "Resolved") {
      return yield* new TempoServiceError({
        reason: "invalid_request",
        service: id,
        detail: INVALID_PATH_DETAIL,
      });
    }
    if (
      enforcePolicy &&
      // Both spellings must pass: some upstreams decode "%2F" before routing.
      !(
        pathAllowedByPrefixes(resolved.relativePath, connection.allowedPathPrefixes) &&
        pathAllowedByPrefixes(resolved.decodedPath, connection.allowedPathPrefixes)
      )
    ) {
      return yield* new TempoServiceError({
        reason: "path_not_allowed",
        service: id,
        options: connection.allowedPathPrefixes,
      });
    }
    const base = HttpClientRequest.make(input.method)(
      appendServiceQuery(resolved.url, input.query),
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json, text/plain;q=0.9, */*;q=0.5",
        [connection.authHeader]:
          connection.authScheme === ""
            ? connection.secret
            : `${connection.authScheme} ${connection.secret}`,
      }),
    );
    // The body was decoded from JSON, so it encodes back without throwing.
    const request =
      input.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, input.body);
    return yield* executeCapped(httpClient, request, id);
  });

  const toResult = (
    id: string,
    response: CappedResponse,
    redact: (text: string) => string,
  ): TempoServiceRequestResult => ({
    service: id,
    status: response.status,
    headers: safeResponseHeaders(response.headers, redact),
    ...decodeServiceBody({
      bytes: response.bytes,
      truncated: response.truncated,
      contentType: response.headers["content-type"],
      redact,
    }),
    truncated: response.truncated,
  });

  const request: ServiceConnections["Service"]["request"] = Effect.fn("ServiceConnections.request")(
    function* (input) {
      if (input.body !== undefined && TEMPO_SERVICE_READ_METHODS.has(input.method)) {
        return yield* new TempoServiceError({
          reason: "invalid_request",
          service: input.service,
          detail: `${input.method} requests cannot carry a body.`,
        });
      }
      const target = yield* resolveTarget(input.service);
      yield* Effect.annotateCurrentSpan({
        "tempo.service.id": target.id,
        "tempo.service.method": input.method,
      });
      const redact = makeSecretRedactor(yield* knownSecrets);
      const response = yield* send(target, input, true);
      // The audit trail of what agents did with services; no paths, bodies, or keys.
      yield* Effect.logInfo("Service request", {
        service: target.id,
        method: input.method,
        status: response.status,
      });
      return toResult(target.id, response, redact);
    },
  );

  const resolveKind: ServiceConnections["Service"]["resolveKind"] = Effect.fn(
    "ServiceConnections.resolveKind",
  )(function* (kind, service) {
    const ofKind = (yield* list).filter((connection) => connection.kind === kind);
    if (service !== undefined) {
      const name = serviceName(service);
      const match = ofKind.find((connection) => connection.name === name);
      if (match !== undefined) return match;
      return yield* new TempoServiceError({
        reason: "not_found",
        service,
        kind,
        options: ofKind.map((connection) => connection.id),
      });
    }
    if (ofKind.length === 1) return ofKind[0]!;
    if (ofKind.length === 0) {
      return yield* new TempoServiceError({ reason: "not_configured", kind });
    }
    return yield* new TempoServiceError({
      reason: "ambiguous",
      service: tempoServiceKindLabel(kind),
      kind,
      options: ofKind.map((connection) => connection.id),
    });
  });

  const saveLocal: ServiceConnections["Service"]["saveLocal"] = Effect.fn(
    "ServiceConnections.saveLocal",
  )(function* (input) {
    const id = `local/${input.name}`;
    const invalid = (detail: string) =>
      new TempoServiceError({ reason: "invalid_connection", service: id, detail });
    const baseUrl = normalizeServiceBaseUrl(input.baseUrl);
    if (baseUrl === null) {
      return yield* invalid(
        "The base URL must be an https URL (http only for localhost) without credentials, a query, or a fragment.",
      );
    }
    const prefixes: Array<string> = [];
    for (const raw of input.allowedPathPrefixes ?? []) {
      const prefix = normalizeServicePathPrefix(raw);
      if (prefix === null) {
        return yield* invalid(
          "Path prefixes are plain paths such as /keys, without a query, fragment, or ..",
        );
      }
      if (!prefixes.includes(prefix)) prefixes.push(prefix);
    }
    if (RESERVED_AUTH_HEADERS.has(input.authHeader.toLowerCase())) {
      return yield* invalid("Send the secret in a header such as Authorization or X-Api-Key.");
    }
    const requested = new Set(input.allowedMethods ?? []);
    const allowedMethods = METHOD_ORDER.filter((method) => requested.has(method));

    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* loadLocal;
        const existing = current.find((connection) => connection.name === input.name);
        // A secret follows its connection to a new path, never to a new host.
        const sameHost =
          existing !== undefined && new URL(existing.baseUrl).origin === new URL(baseUrl).origin;
        const secret = input.secret ?? (sameHost ? existing.secret : undefined);
        if (secret === undefined) {
          return yield* new TempoServiceError({
            reason: "secret_required",
            service: id,
            ...(existing === undefined
              ? {}
              : { detail: "The host changed, so the saved secret is not sent there." }),
          });
        }
        const next: StoredLocalConnection = {
          name: input.name,
          kind: input.kind,
          description: input.description ?? "",
          baseUrl,
          authHeader: input.authHeader,
          authScheme: input.authScheme ?? "",
          secret,
          allowedMethods: allowedMethods.length === 0 ? ["GET"] : allowedMethods,
          // The root prefix allows every path, which is what no prefixes means.
          allowedPathPrefixes: prefixes.includes("") ? [] : prefixes,
        };
        yield* saveAll(
          existing === undefined
            ? [...current, next]
            : current.map((connection) => (connection.name === input.name ? next : connection)),
        );
      }),
    );
    return yield* snapshot;
  });

  const removeLocal: ServiceConnections["Service"]["removeLocal"] = Effect.fn(
    "ServiceConnections.removeLocal",
  )(function* (name) {
    yield* writeLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* loadLocal;
        if (!current.some((connection) => connection.name === name)) {
          return yield* new TempoServiceError({ reason: "not_found", service: `local/${name}` });
        }
        yield* saveAll(current.filter((connection) => connection.name !== name));
      }),
    );
    return yield* snapshot;
  });

  const test: ServiceConnections["Service"]["test"] = Effect.fn("ServiceConnections.test")(
    function* (id) {
      const target = yield* resolveTarget(id);
      const probes = TEST_PROBES[target.connection.kind] ?? [
        { path: target.connection.allowedPathPrefixes[0] ?? "/" },
      ];
      const probe = ({ path, query }: TestProbe) =>
        send(
          target,
          { method: "GET" as const, path, ...(query === undefined ? {} : { query }) },
          false,
        );
      return yield* Effect.gen(function* () {
        let status = 0;
        for (const next of probes) {
          status = (yield* probe(next)).status;
          if (status >= 200 && status < 300) break;
        }
        return testMessage(target.id, status);
      }).pipe(
        Effect.catchTags({
          TempoServiceError: (error) =>
            Effect.succeed<TempoServiceTestResult>({ ok: false, message: error.message }),
        }),
      );
    },
  );

  const hasLocal: ServiceConnections["Service"]["hasLocal"] = loadLocal.pipe(
    Effect.map((connections) => connections.length > 0),
    Effect.orElseSucceed(() => false),
  );

  return ServiceConnections.of({
    hasLocal,
    snapshot,
    list,
    resolveKind,
    request,
    redactKnown,
    saveLocal,
    removeLocal,
    test,
  });
});

export const layer = Layer.effect(ServiceConnections, make);
