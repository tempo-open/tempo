import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthorizationError,
  LAPTOP_TOOL_CALL_DEFAULT_TIMEOUT_MS,
  LaptopToolsUnavailableError,
  type LaptopToolCallResult,
  type LaptopToolHostId,
  type LaptopToolServer,
  type LaptopToolServerId,
  type LaptopToolServerTools,
  type LaptopToolsCallRequest,
  type LaptopToolsFailureCode,
  type LaptopToolsHostRegistration,
  type LaptopToolsListResult,
  type LaptopToolsOutcome,
  type LaptopToolsRequest,
  type LaptopToolsResponse,
  type LaptopToolsStreamEvent,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

/** The laptop answers a listing from its last list and starts nothing; this only bounds a stuck desktop. */
export const LAPTOP_TOOLS_LIST_TIMEOUT_MS = 60_000;
/**
 * The largest answer a laptop may send, counted in characters of text and
 * base64 image data. A few full-resolution screenshots fit; a runaway tool
 * output does not reach the agent.
 */
export const LAPTOP_TOOLS_MAX_RESULT_CHARS = 12 * 1024 * 1024;
/** The laptop's own failure text is short and written by the desktop app. */
const MAX_LAPTOP_MESSAGE_CHARS = 300;

export interface LaptopToolHostSummary {
  readonly hostId: LaptopToolHostId;
  readonly hostLabel: string;
  readonly servers: ReadonlyArray<LaptopToolServer>;
  /** The request kinds the laptop answers; it is sent no others. */
  readonly accepts: ReadonlyArray<string>;
}

export interface LaptopToolCallInput {
  readonly hostId?: LaptopToolHostId | undefined;
  readonly serverId: LaptopToolServerId;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, unknown>>;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly runId: RunId;
  readonly timeoutMs?: number | undefined;
}

/**
 * Desktops offering their laptop tools to this environment, and the calls agents make to them. A
 * desktop registers with `connect` and holds the returned stream open; requests arrive on it, and
 * it answers each with `respond`. Closing the stream unregisters the host and fails its calls. Only
 * the client session that registered a host may replace it or answer its requests.
 */
export class LaptopToolHosts extends Context.Service<
  LaptopToolHosts,
  {
    readonly connect: (
      registration: LaptopToolsHostRegistration,
      sessionId: string,
    ) => Effect.Effect<Stream.Stream<LaptopToolsStreamEvent, EnvironmentAuthorizationError>>;
    readonly respond: (response: LaptopToolsResponse, sessionId: string) => Effect.Effect<void>;
    readonly hosts: Effect.Effect<ReadonlyArray<LaptopToolHostSummary>>;
    readonly listTools: (input: {
      readonly hostId?: LaptopToolHostId | undefined;
    }) => Effect.Effect<LaptopToolsListResult, LaptopToolsUnavailableError>;
    readonly callTool: (
      input: LaptopToolCallInput,
    ) => Effect.Effect<LaptopToolCallResult, LaptopToolsUnavailableError>;
    /**
     * Sends any request to one laptop and waits for its outcome, with the same
     * host choice, timeout, cancellation and size limit as tool calls. New
     * kinds of laptop request (such as passkeys) add a `LaptopToolsRequest`
     * variant and go through here.
     */
    readonly send: (input: {
      readonly hostId?: LaptopToolHostId | undefined;
      /** Only laptops this client session registered, such as the person driving a browser tab. */
      readonly sessionId?: string | undefined;
      readonly request: LaptopToolsRequest;
      readonly timeoutMs: number;
    }) => Effect.Effect<LaptopToolsOutcome, LaptopToolsUnavailableError>;
  }
>()("t3/tempo/laptopTools/LaptopToolHosts") {}

interface Host extends LaptopToolHostSummary {
  readonly connectionId: string;
  readonly sessionId: string;
  readonly queue: Queue.Queue<LaptopToolsStreamEvent, Cause.Done>;
}

interface Pending {
  readonly hostId: LaptopToolHostId;
  readonly connectionId: string;
  readonly sessionId: string;
  readonly deferred: Deferred.Deferred<LaptopToolsOutcome, LaptopToolsUnavailableError>;
}

interface State {
  readonly hosts: ReadonlyMap<LaptopToolHostId, Host>;
  readonly pending: ReadonlyMap<string, Pending>;
  readonly requestSequence: number;
}

const unavailable = (reason: string, code?: LaptopToolsFailureCode) =>
  new LaptopToolsUnavailableError({ reason, ...(code === undefined ? {} : { code }) });

const NO_LAPTOP =
  "No laptop is offering tools to this environment. Ask the user to open the desktop app on their laptop, connect it to this environment, and turn on a laptop tool in Settings → Laptop tools.";

const NO_TOOL_TURNED_ON =
  "A laptop is connected, but no laptop tool is turned on. Ask the user to turn one on in Settings → Laptop tools in the desktop app on their laptop.";

const describeHosts = (hosts: ReadonlyArray<Host>) =>
  hosts.map((host) => `${host.hostId} (${host.hostLabel})`).join(", ");

const acceptsKind = (host: Host, kind: string) => host.accepts.includes(kind);

/**
 * Picks the host a request goes to from `candidates`, the hosts able to take
 * it; with several the agent must name one. `all` is every connected host, so
 * a named host that cannot take the request is told apart from one that is
 * not connected.
 */
const selectHost = (
  all: ReadonlyArray<Host>,
  candidates: ReadonlyArray<Host>,
  hostId: LaptopToolHostId | undefined,
  unableReason: (host: Host) => string,
  noneReason: string,
): Effect.Effect<Host, LaptopToolsUnavailableError> => {
  if (all.length === 0) return Effect.fail(unavailable(NO_LAPTOP, "server-not-found"));
  if (hostId !== undefined) {
    const host = all.find((candidate) => candidate.hostId === hostId);
    if (host === undefined) {
      return Effect.fail(
        unavailable(
          `Laptop ${hostId} is not connected. Connected laptops: ${describeHosts(all)}.`,
          "server-not-found",
        ),
      );
    }
    return candidates.includes(host)
      ? Effect.succeed(host)
      : Effect.fail(unavailable(unableReason(host), "server-not-found"));
  }
  const [only, ...others] = candidates;
  if (only === undefined) return Effect.fail(unavailable(noneReason, "server-not-found"));
  if (others.length > 0) {
    return Effect.fail(
      unavailable(
        `More than one laptop can take this: ${describeHosts(candidates)}. Pass hostId to choose one; call laptop_tools_list to see what each offers.`,
        "server-not-found",
      ),
    );
  }
  return Effect.succeed(only);
};

/** Characters a laptop's answer carries; compared with `LAPTOP_TOOLS_MAX_RESULT_CHARS`. */
const outcomeSize = (outcome: LaptopToolsOutcome): number => {
  switch (outcome._tag) {
    case "result": {
      let size = 0;
      for (const block of outcome.result.content) {
        size += block.type === "text" ? block.text.length : block.data.length;
      }
      if (outcome.result.structuredContent !== undefined) {
        size += JSON.stringify(outcome.result.structuredContent)?.length ?? 0;
      }
      return size;
    }
    case "tools":
      return JSON.stringify(outcome.servers).length;
    case "failure":
      return outcome.message.length;
    case "passkey":
      return JSON.stringify(outcome.result).length;
  }
};

/** The agent-facing reason for a failure the laptop reported. */
const failureReason = (
  outcome: Extract<LaptopToolsOutcome, { readonly _tag: "failure" }>,
  host: Pick<Host, "hostLabel">,
  serverName: string,
): string => {
  const detail = outcome.message.slice(0, MAX_LAPTOP_MESSAGE_CHARS);
  switch (outcome.code) {
    case "denied":
      return `The user did not allow ${serverName} on ${host.hostLabel} for this run, or stopped it. Do not retry in this run: the laptop refuses it until the next one. Continue without it or ask the user.`;
    case "cancelled":
      return `The call to ${serverName} on ${host.hostLabel} was cancelled.`;
    case "timeout":
      return `${serverName} on ${host.hostLabel} did not finish in time.`;
    case "too-large":
      return `${serverName} on ${host.hostLabel} returned more than the laptop sends back. Ask for less, such as a smaller region or page.`;
    case "server-not-found":
      return `${host.hostLabel} has no laptop tool named ${serverName}. Call laptop_tools_list.`;
    case "server-unavailable":
      return `${serverName} on ${host.hostLabel} could not start: ${detail}`;
    case "failed":
      return `${serverName} on ${host.hostLabel} failed: ${detail}`;
  }
};

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const state = yield* SynchronizedRef.make<State>({
    hosts: new Map(),
    pending: new Map(),
    requestSequence: 0,
  });

  /** Splits off the requests one host generation still owes. */
  const takeOrphans = (current: State, host: Host) => {
    const pending = new Map(current.pending);
    const orphaned: Pending[] = [];
    for (const [requestId, entry] of current.pending) {
      if (entry.hostId !== host.hostId || entry.connectionId !== host.connectionId) continue;
      pending.delete(requestId);
      orphaned.push(entry);
    }
    return { pending, orphaned };
  };

  /** Ends a generation's stream and fails what it still owed. */
  const retire = Effect.fn("LaptopToolHosts.retire")(function* (
    host: Host,
    orphaned: ReadonlyArray<Pending>,
    reason: string,
  ) {
    yield* Queue.shutdown(host.queue);
    yield* Effect.forEach(
      orphaned,
      (entry) => Deferred.fail(entry.deferred, unavailable(reason, "cancelled")),
      { discard: true },
    );
  });

  const removeHost = (host: Host) =>
    SynchronizedRef.modifyEffect(state, (current) => {
      // A replaced generation was already retired by its successor.
      if (current.hosts.get(host.hostId)?.queue !== host.queue) {
        return Effect.succeed([undefined, current] as const);
      }
      const hosts = new Map(current.hosts);
      hosts.delete(host.hostId);
      const { pending, orphaned } = takeOrphans(current, host);
      return retire(host, orphaned, `${host.hostLabel} disconnected before answering.`).pipe(
        Effect.as([undefined, { ...current, hosts, pending }] as const),
      );
    });

  const acquireHost = Effect.fn("LaptopToolHosts.acquireHost")(function* (
    registration: LaptopToolsHostRegistration,
    sessionId: string,
  ) {
    const queue = yield* Queue.unbounded<LaptopToolsStreamEvent, Cause.Done>();
    const connectionId = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    yield* Queue.offer(queue, { type: "connected", connectionId });
    const host: Host = {
      hostId: registration.hostId,
      hostLabel: registration.hostLabel,
      servers: registration.servers,
      accepts: registration.accepts,
      connectionId,
      sessionId,
      queue,
    };
    type Registered =
      | { readonly _tag: "refused" }
      | { readonly _tag: "added" }
      | { readonly _tag: "replaced"; readonly previous: Host; readonly orphaned: Pending[] };
    const replaced = yield* SynchronizedRef.modify(
      state,
      (current): readonly [Registered, State] => {
        const previous = current.hosts.get(host.hostId);
        // Another client may not take over a laptop's registration and its calls.
        if (previous !== undefined && previous.sessionId !== sessionId) {
          return [{ _tag: "refused" }, current];
        }
        const hosts = new Map(current.hosts);
        hosts.set(host.hostId, host);
        if (previous === undefined) return [{ _tag: "added" }, { ...current, hosts }];
        const { pending, orphaned } = takeOrphans(current, previous);
        return [
          { _tag: "replaced", previous, orphaned },
          { ...current, hosts, pending },
        ];
      },
    );
    if (replaced._tag === "refused") {
      yield* Queue.shutdown(queue);
      return yield* new EnvironmentAuthorizationError({
        message: "Another client already registered laptop tools under this host id.",
        requiredScope: AuthOrchestrationOperateScope,
      });
    }
    // A reconnect replaces the same desktop's earlier registration.
    if (replaced._tag === "replaced") {
      yield* retire(
        replaced.previous,
        replaced.orphaned,
        `${replaced.previous.hostLabel} reconnected before answering.`,
      );
    }
    return host;
  });

  const connect: LaptopToolHosts["Service"]["connect"] = (registration, sessionId) =>
    Effect.succeed(
      Stream.unwrap(
        Effect.acquireRelease(acquireHost(registration, sessionId), removeHost).pipe(
          Effect.map((host) => Stream.fromQueue(host.queue)),
        ),
      ),
    );

  const respond: LaptopToolHosts["Service"]["respond"] = Effect.fn("LaptopToolHosts.respond")(
    function* (response, sessionId) {
      const entry = yield* SynchronizedRef.modify(state, (current) => {
        const pending = current.pending.get(response.requestId);
        // Only the generation the request went to, on its own session, may answer it.
        if (
          pending === undefined ||
          pending.hostId !== response.hostId ||
          pending.connectionId !== response.connectionId ||
          pending.sessionId !== sessionId
        ) {
          return [undefined, current] as const;
        }
        const next = new Map(current.pending);
        next.delete(response.requestId);
        return [pending, { ...current, pending: next }] as const;
      });
      if (entry === undefined) return;
      if (outcomeSize(response.outcome) > LAPTOP_TOOLS_MAX_RESULT_CHARS) {
        yield* Deferred.fail(
          entry.deferred,
          unavailable(
            "The laptop tool returned more than the environment accepts. Ask for less, such as a smaller region or page.",
            "too-large",
          ),
        );
        return;
      }
      yield* Deferred.succeed(entry.deferred, response.outcome);
    },
  );

  /** Sends one request to a host and waits for its answer, cancelling it on timeout or interrupt. */
  const request = Effect.fn("LaptopToolHosts.request")(function* (
    host: Host,
    body: LaptopToolsRequest,
    timeoutMs: number,
  ) {
    const deferred = yield* Deferred.make<LaptopToolsOutcome, LaptopToolsUnavailableError>();
    const requestId = yield* SynchronizedRef.modify(state, (current) => {
      const id = `laptop-${current.requestSequence}`;
      const pending = new Map(current.pending);
      pending.set(id, {
        hostId: host.hostId,
        connectionId: host.connectionId,
        sessionId: host.sessionId,
        deferred,
      });
      return [id, { ...current, pending, requestSequence: current.requestSequence + 1 }] as const;
    });
    const forget = SynchronizedRef.update(state, (current) => {
      if (!current.pending.has(requestId)) return current;
      const pending = new Map(current.pending);
      pending.delete(requestId);
      return { ...current, pending };
    });
    const cancel = Queue.offer(host.queue, {
      type: "cancel",
      connectionId: host.connectionId,
      requestId,
    }).pipe(Effect.ignore);
    const offered = yield* Queue.offer(host.queue, {
      type: "request",
      connectionId: host.connectionId,
      requestId,
      request: body,
    });
    if (!offered) {
      yield* forget;
      return yield* unavailable(`${host.hostLabel} disconnected.`, "cancelled");
    }
    const answer = yield* Deferred.await(deferred).pipe(
      Effect.timeoutOption(timeoutMs),
      Effect.onInterrupt(() => cancel),
      Effect.ensuring(forget),
    );
    if (Option.isNone(answer)) {
      yield* cancel;
      return yield* unavailable(
        `${host.hostLabel} did not answer within ${Math.round(timeoutMs / 1000)}s. If nobody answered the permission prompt, the laptop treats that as a refusal for the rest of this run; ask the user before trying again.`,
        "timeout",
      );
    }
    return answer.value;
  });

  const liveHosts = SynchronizedRef.get(state).pipe(
    Effect.map((current) => Array.from(current.hosts.values())),
  );

  const hosts: LaptopToolHosts["Service"]["hosts"] = liveHosts.pipe(
    Effect.map((all) =>
      all.map(({ hostId, hostLabel, servers, accepts }) => ({
        hostId,
        hostLabel,
        servers,
        accepts,
      })),
    ),
  );

  const listHostTools = (host: Host) =>
    request(host, { _tag: "listTools" }, LAPTOP_TOOLS_LIST_TIMEOUT_MS).pipe(
      Effect.map((outcome): ReadonlyArray<LaptopToolServerTools> => {
        if (outcome._tag === "tools") return outcome.servers;
        const error =
          outcome._tag === "failure"
            ? outcome.message.slice(0, MAX_LAPTOP_MESSAGE_CHARS)
            : "The laptop sent an unexpected answer.";
        return host.servers.map((server) => ({ ...server, tools: [], error }));
      }),
      Effect.catchTags({
        LaptopToolsUnavailableError: (error) =>
          Effect.succeed(
            host.servers.map((server) => ({ ...server, tools: [], error: error.reason })),
          ),
      }),
      Effect.map((servers) => ({ hostId: host.hostId, hostLabel: host.hostLabel, servers })),
    );

  const listTools: LaptopToolHosts["Service"]["listTools"] = Effect.fn("LaptopToolHosts.listTools")(
    function* (input) {
      const all = yield* liveHosts;
      if (all.length === 0) return yield* unavailable(NO_LAPTOP, "server-not-found");
      // A laptop with no tool turned on still connects, for other kinds of request.
      const offering = all.filter(
        (candidate) => candidate.servers.length > 0 && acceptsKind(candidate, "listTools"),
      );
      if (input.hostId !== undefined && !all.some((host) => host.hostId === input.hostId)) {
        return yield* unavailable(
          `Laptop ${input.hostId} is not connected. Connected laptops: ${describeHosts(all)}.`,
          "server-not-found",
        );
      }
      const targets =
        input.hostId === undefined
          ? offering
          : offering.filter((candidate) => candidate.hostId === input.hostId);
      if (targets.length === 0) return yield* unavailable(NO_TOOL_TURNED_ON, "server-not-found");
      const listed = yield* Effect.forEach(targets, listHostTools, { concurrency: "unbounded" });
      return { hosts: listed };
    },
  );

  const callTool: LaptopToolHosts["Service"]["callTool"] = Effect.fn("LaptopToolHosts.callTool")(
    function* (input) {
      const all = yield* liveHosts;
      const callable = all.filter((candidate) => acceptsKind(candidate, "callTool"));
      const offersServer = (candidate: Host) =>
        candidate.servers.some((server) => server.id === input.serverId);
      const offered = [
        ...new Set(callable.flatMap((candidate) => candidate.servers.map((server) => server.id))),
      ];
      const host = yield* selectHost(
        all,
        callable.filter(offersServer),
        input.hostId,
        (named) =>
          named.servers.length === 0 || !acceptsKind(named, "callTool")
            ? `${named.hostLabel} offers no laptop tools right now.`
            : `${named.hostLabel} has no laptop tool ${input.serverId}. It offers: ${named.servers.map((candidate) => candidate.id).join(", ")}.`,
        offered.length === 0
          ? NO_TOOL_TURNED_ON
          : `No connected laptop offers ${input.serverId}. Offered: ${offered.join(", ")}.`,
      );
      const server = host.servers.find((candidate) => candidate.id === input.serverId);
      if (server === undefined) {
        return yield* unavailable(
          `${host.hostLabel} has no laptop tool ${input.serverId}.`,
          "server-not-found",
        );
      }
      const timeoutMs = input.timeoutMs ?? LAPTOP_TOOL_CALL_DEFAULT_TIMEOUT_MS;
      const body: LaptopToolsCallRequest = {
        _tag: "callTool",
        threadId: input.threadId,
        threadTitle: input.threadTitle,
        runId: input.runId,
        serverId: input.serverId,
        tool: input.tool,
        arguments: input.arguments,
        timeoutMs,
      };
      const outcome = yield* request(host, body, timeoutMs);
      switch (outcome._tag) {
        case "result":
          return outcome.result;
        case "failure":
          return yield* unavailable(failureReason(outcome, host, server.name), outcome.code);
        case "tools":
        case "passkey":
          return yield* unavailable(`${host.hostLabel} sent an unexpected answer.`, "failed");
      }
    },
  );

  const send: LaptopToolHosts["Service"]["send"] = Effect.fn("LaptopToolHosts.send")(
    function* (input) {
      const all = yield* liveHosts;
      const kind = input.request._tag;
      const host = yield* selectHost(
        all,
        all.filter(
          (candidate) =>
            acceptsKind(candidate, kind) &&
            (input.sessionId === undefined || candidate.sessionId === input.sessionId),
        ),
        input.hostId,
        (named) =>
          `${named.hostLabel} cannot answer ${kind} requests. Its desktop app may need an update.`,
        `No connected laptop answers ${kind} requests. Its desktop app may need an update.`,
      );
      return yield* request(host, input.request, input.timeoutMs);
    },
  );

  return LaptopToolHosts.of({ connect, respond, hosts, listTools, callTool, send });
});

export const layer = Layer.effect(LaptopToolHosts, make);
