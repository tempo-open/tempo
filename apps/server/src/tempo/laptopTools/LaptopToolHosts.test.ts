import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type LaptopToolsHostRegistration,
  type LaptopToolsOutcome,
  type LaptopToolsStreamEvent,
  LaptopToolHostId,
  LaptopToolServerId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as LaptopToolHosts from "./LaptopToolHosts.ts";

const makeHosts = LaptopToolHosts.make.pipe(Effect.provide(NodeServices.layer));

const computerUse = LaptopToolServerId.make("computer-use");
const threadId = ThreadId.make("thread-laptop");
const runId = RunId.make("run-laptop");

const registration = (
  hostId: string,
  label = hostId,
  servers: LaptopToolsHostRegistration["servers"] = [{ id: computerUse, name: "Computer use" }],
): LaptopToolsHostRegistration => ({
  hostId: LaptopToolHostId.make(hostId),
  hostLabel: label,
  servers,
  accepts: ["listTools", "callTool"],
});

/** Each laptop connects on its own client session unless a test says otherwise. */
const sessionFor = (input: LaptopToolsHostRegistration) => `session-${input.hostId}`;

const call = (options: { readonly hostId?: string; readonly timeoutMs?: number } = {}) => ({
  hostId: options.hostId === undefined ? undefined : LaptopToolHostId.make(options.hostId),
  serverId: computerUse,
  tool: "screenshot",
  arguments: { display: 1 },
  threadId,
  threadTitle: "Fix the login page",
  runId,
  timeoutMs: options.timeoutMs,
});

type RequestEvent = Extract<LaptopToolsStreamEvent, { readonly type: "request" }>;
type CancelEvent = Extract<LaptopToolsStreamEvent, { readonly type: "cancel" }>;

/**
 * Connects a laptop that answers each request with `answer`, or leaves it
 * unanswered when `answer` returns undefined. Resolves once the laptop has
 * its `connected` event; `requested` and `cancelled` resolve on the first of each.
 */
const connectLaptop = (
  hosts: LaptopToolHosts.LaptopToolHosts["Service"],
  input: LaptopToolsHostRegistration,
  answer: (event: RequestEvent) => LaptopToolsOutcome | undefined,
  sessionId = sessionFor(input),
) =>
  Effect.gen(function* () {
    const requests: RequestEvent[] = [];
    const connected = yield* Deferred.make<string>();
    const requested = yield* Deferred.make<RequestEvent>();
    const cancelled = yield* Deferred.make<CancelEvent>();
    const stream = yield* hosts.connect(input, sessionId);
    const fiber = yield* Stream.runForEach(stream, (event) =>
      Effect.gen(function* () {
        switch (event.type) {
          case "connected":
            yield* Deferred.succeed(connected, event.connectionId);
            return;
          case "cancel":
            yield* Deferred.succeed(cancelled, event);
            return;
          case "request": {
            requests.push(event);
            yield* Deferred.succeed(requested, event);
            const outcome = answer(event);
            if (outcome === undefined) return;
            yield* hosts.respond(
              {
                hostId: input.hostId,
                connectionId: event.connectionId,
                requestId: event.requestId,
                outcome,
              },
              sessionId,
            );
          }
        }
      }),
    ).pipe(Effect.forkScoped);
    const connectionId = yield* Deferred.await(connected);
    return { requests, requested, cancelled, fiber, connectionId };
  });

const screenshot = {
  content: [
    { type: "text" as const, text: "Took a screenshot." },
    {
      type: "image" as const,
      data: Buffer.from("png").toString("base64"),
      mimeType: "image/png",
    },
  ],
};
const answerScreenshot = (): LaptopToolsOutcome => ({ _tag: "result", result: screenshot });
const leaveUnanswered = () => undefined;

it.effect("routes a call to the only connected laptop and returns its content", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const laptop = yield* connectLaptop(
        hosts,
        registration("laptop-1", "Ada's MacBook"),
        answerScreenshot,
      );

      const result = yield* hosts.callTool(call());

      expect(result).toEqual(screenshot);
      expect(laptop.requests.map((event) => event.request)).toEqual([
        {
          _tag: "callTool",
          threadId,
          threadTitle: "Fix the login page",
          runId,
          serverId: computerUse,
          tool: "screenshot",
          arguments: { display: 1 },
          timeoutMs: 120_000,
        },
      ]);
    }),
  ),
);

it.effect("asks the agent to choose when several laptops are connected", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const first = yield* connectLaptop(hosts, registration("laptop-1"), answerScreenshot);
      const second = yield* connectLaptop(hosts, registration("laptop-2"), answerScreenshot);

      const ambiguous = yield* hosts.callTool(call()).pipe(Effect.flip);
      expect(ambiguous.reason).toContain("More than one laptop can take this");
      expect(ambiguous.reason).toContain("laptop-1");
      expect(ambiguous.reason).toContain("laptop-2");

      yield* hosts.callTool(call({ hostId: "laptop-2" }));
      expect(first.requests).toHaveLength(0);
      expect(second.requests).toHaveLength(1);
    }),
  ),
);

it.effect("explains what to do when no laptop or tool is available", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const none = yield* hosts.callTool(call()).pipe(Effect.flip);
      expect(none.reason).toContain("No laptop is offering tools");

      yield* connectLaptop(hosts, registration("laptop-1"), answerScreenshot);
      const unknown = yield* hosts
        .callTool({ ...call(), serverId: LaptopToolServerId.make("laptop-browser") })
        .pipe(Effect.flip);
      expect(unknown.reason).toContain("Offered: computer-use");
      const named = yield* hosts
        .callTool({
          ...call({ hostId: "laptop-1" }),
          serverId: LaptopToolServerId.make("laptop-browser"),
        })
        .pipe(Effect.flip);
      expect(named.reason).toContain("It offers: computer-use");
    }),
  ),
);

it.effect("removes a laptop that disconnects and fails the call it owed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const laptop = yield* connectLaptop(hosts, registration("laptop-1"), leaveUnanswered);
      const pending = yield* hosts.callTool(call()).pipe(Effect.flip, Effect.forkScoped);
      yield* Deferred.await(laptop.requested);

      yield* Fiber.interrupt(laptop.fiber);

      expect((yield* Fiber.join(pending)).code).toBe("cancelled");
      expect(yield* hosts.hosts).toEqual([]);
    }),
  ),
);

it.effect("cancels the call on the laptop when it times out, and keeps the laptop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const laptop = yield* connectLaptop(hosts, registration("laptop-1"), leaveUnanswered);
      const pending = yield* hosts
        .callTool(call({ timeoutMs: 5_000 }))
        .pipe(Effect.flip, Effect.forkScoped);
      const request = yield* Deferred.await(laptop.requested);

      yield* TestClock.adjust(5_000);

      expect((yield* Fiber.join(pending)).code).toBe("timeout");
      expect((yield* Deferred.await(laptop.cancelled)).requestId).toBe(request.requestId);
      expect((yield* hosts.hosts).map((host) => host.hostId)).toEqual(["laptop-1"]);
    }),
  ),
);

it.effect("cancels the call on the laptop when the agent stops waiting", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const laptop = yield* connectLaptop(hosts, registration("laptop-1"), leaveUnanswered);
      const pending = yield* hosts.callTool(call()).pipe(Effect.forkScoped);
      const request = yield* Deferred.await(laptop.requested);

      yield* Fiber.interrupt(pending);

      expect((yield* Deferred.await(laptop.cancelled)).requestId).toBe(request.requestId);
    }),
  ),
);

it.effect("refuses an answer larger than the environment accepts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      yield* connectLaptop(hosts, registration("laptop-1"), () => ({
        _tag: "result",
        result: {
          content: [
            { type: "text", text: "x".repeat(LaptopToolHosts.LAPTOP_TOOLS_MAX_RESULT_CHARS + 1) },
          ],
        },
      }));

      const error = yield* hosts.callTool(call()).pipe(Effect.flip);

      expect(error.code).toBe("too-large");
    }),
  ),
);

it.effect("turns the laptop's refusal into a reason the agent can act on", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      yield* connectLaptop(hosts, registration("laptop-1", "Ada's MacBook"), () => ({
        _tag: "failure",
        code: "denied",
        message: "Denied",
      }));

      const error = yield* hosts.callTool(call()).pipe(Effect.flip);

      expect(error.code).toBe("denied");
      expect(error.reason).toContain("did not allow Computer use on Ada's MacBook");
      expect(error.reason).toContain("Do not retry");
    }),
  ),
);

it.effect("ignores answers from a connection the laptop has replaced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const stale = yield* connectLaptop(hosts, registration("laptop-1"), leaveUnanswered);
      const pending = yield* hosts.callTool(call()).pipe(Effect.flip, Effect.forkScoped);
      const staleRequest = yield* Deferred.await(stale.requested);

      yield* connectLaptop(hosts, registration("laptop-1"), answerScreenshot);
      yield* hosts.respond(
        {
          hostId: LaptopToolHostId.make("laptop-1"),
          connectionId: staleRequest.connectionId,
          requestId: staleRequest.requestId,
          outcome: answerScreenshot(),
        },
        "session-laptop-1",
      );

      expect((yield* Fiber.join(pending)).code).toBe("cancelled");
      expect(yield* hosts.callTool(call())).toEqual(screenshot);
    }),
  ),
);

it.effect("lists every laptop's tools and reports one that does not answer", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      yield* connectLaptop(hosts, registration("laptop-1"), () => ({
        _tag: "tools",
        servers: [
          {
            id: computerUse,
            name: "Computer use",
            tools: [{ name: "screenshot", description: "Capture the screen." }],
          },
        ],
      }));
      const silent = yield* connectLaptop(hosts, registration("laptop-2"), leaveUnanswered);

      const listing = yield* hosts.listTools({}).pipe(Effect.forkScoped);
      yield* Deferred.await(silent.requested);
      yield* TestClock.adjust(LaptopToolHosts.LAPTOP_TOOLS_LIST_TIMEOUT_MS);
      const { hosts: listed } = yield* Fiber.join(listing);

      expect(listed.map((host) => host.hostId)).toEqual(["laptop-1", "laptop-2"]);
      expect(listed[0]?.servers[0]?.tools.map((tool) => tool.name)).toEqual(["screenshot"]);
      expect(listed[1]?.servers[0]?.tools).toEqual([]);
      expect(listed[1]?.servers[0]?.error).toContain("did not answer");
    }),
  ),
);

it.effect("only the session that registered a laptop may replace it or answer for it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const laptop = yield* connectLaptop(hosts, registration("laptop-1"), leaveUnanswered);
      const pending = yield* hosts.callTool(call()).pipe(Effect.flip, Effect.forkScoped);
      const request = yield* Deferred.await(laptop.requested);

      const impostor = yield* hosts.connect(registration("laptop-1"), "session-other");
      const refused = yield* Stream.runDrain(impostor).pipe(Effect.flip);
      expect(refused._tag).toBe("EnvironmentAuthorizationError");

      // An answer from another session does not reach the agent.
      yield* hosts.respond(
        {
          hostId: LaptopToolHostId.make("laptop-1"),
          connectionId: request.connectionId,
          requestId: request.requestId,
          outcome: answerScreenshot(),
        },
        "session-other",
      );
      yield* TestClock.adjust(120_000);
      expect((yield* Fiber.join(pending)).code).toBe("timeout");
      expect((yield* hosts.hosts).map((host) => host.hostId)).toEqual(["laptop-1"]);
    }),
  ),
);

it.effect(
  "routes a call to the laptop that offers the tool and lists only laptops with tools",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const hosts = yield* makeHosts;
        const browserOnly = yield* connectLaptop(
          hosts,
          registration("laptop-1", "laptop-1", [
            { id: LaptopToolServerId.make("laptop-browser"), name: "Laptop browser" },
          ]),
          answerScreenshot,
        );
        const computer = yield* connectLaptop(hosts, registration("laptop-2"), (event) =>
          event.request._tag === "listTools"
            ? {
                _tag: "tools",
                servers: [
                  { id: computerUse, name: "Computer use", tools: [{ name: "screenshot" }] },
                ],
              }
            : answerScreenshot(),
        );
        // Connected with nothing turned on: it takes no tool calls and is not listed.
        const idle = yield* connectLaptop(hosts, registration("laptop-3", "laptop-3", []), () =>
          answerScreenshot(),
        );

        yield* hosts.callTool(call());
        expect(computer.requests).toHaveLength(1);
        expect(browserOnly.requests).toHaveLength(0);

        const { hosts: listed } = yield* hosts.listTools({});
        expect(listed.map((host) => host.hostId)).toEqual(["laptop-1", "laptop-2"]);
        expect(idle.requests).toHaveLength(0);
        const named = yield* hosts
          .listTools({ hostId: LaptopToolHostId.make("laptop-3") })
          .pipe(Effect.flip);
        expect(named.reason).toContain("no laptop tool is turned on");
      }),
    ),
);

it.effect("sends another kind of request only to a laptop that accepts it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const tools = yield* connectLaptop(hosts, registration("laptop-1"), answerScreenshot);
      const listOnly = yield* connectLaptop(
        hosts,
        { ...registration("laptop-2", "laptop-2", []), accepts: ["listTools"] },
        () => ({ _tag: "tools", servers: [] }),
      );

      const outcome = yield* hosts.send({
        request: { _tag: "listTools" },
        hostId: LaptopToolHostId.make("laptop-2"),
        timeoutMs: 5_000,
      });
      expect(outcome).toEqual({ _tag: "tools", servers: [] });
      expect(listOnly.requests).toHaveLength(1);

      const callRequest = {
        _tag: "callTool" as const,
        threadId,
        threadTitle: "Fix the login page",
        runId,
        serverId: computerUse,
        tool: "screenshot",
        arguments: {},
        timeoutMs: 5_000,
      };
      const refused = yield* hosts
        .send({
          request: callRequest,
          hostId: LaptopToolHostId.make("laptop-2"),
          timeoutMs: 5_000,
        })
        .pipe(Effect.flip);
      expect(refused.reason).toContain("cannot answer callTool requests");
      expect(listOnly.requests).toHaveLength(1);

      // Without a hostId the only laptop that accepts the kind gets it.
      expect(yield* hosts.send({ request: callRequest, timeoutMs: 5_000 })).toEqual(
        answerScreenshot(),
      );
      expect(tools.requests).toHaveLength(1);
    }),
  ),
);

it.effect("sends a passkey only to the laptop of the session that holds the tab", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      const created = {
        _tag: "passkey" as const,
        result: { _tag: "refused" as const, error: "NotAllowedError" as const },
      };
      const passkeys = { ...registration("mine", "mine", []), accepts: ["passkey"] };
      const mine = yield* connectLaptop(hosts, passkeys, () => created);
      const theirs = yield* connectLaptop(
        hosts,
        { ...passkeys, hostId: LaptopToolHostId.make("theirs") },
        () => created,
      );
      const request = {
        _tag: "passkey" as const,
        ceremony: "get" as const,
        origin: "https://github.com",
        rpId: "github.com",
        publicKey: { challenge: { $b64u: "AQ" } },
        threadId,
        threadTitle: "Sign in",
        requester: "person" as const,
        timeoutMs: 5_000,
      };

      expect(yield* hosts.send({ sessionId: "session-mine", request, timeoutMs: 5_000 })).toEqual(
        created,
      );
      expect(mine.requests.map((event) => event.request)).toEqual([request]);
      expect(theirs.requests).toHaveLength(0);

      // A session with no laptop of its own reaches nobody else's.
      const refused = yield* hosts
        .send({ sessionId: "session-elsewhere", request, timeoutMs: 5_000 })
        .pipe(Effect.flip);
      expect(refused.code).toBe("server-not-found");
      expect(theirs.requests).toHaveLength(0);
    }),
  ),
);

it.effect("times out, cancels and size-checks requests sent with send", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const hosts = yield* makeHosts;
      let answerTooLarge = false;
      const laptop = yield* connectLaptop(hosts, registration("laptop-1"), () =>
        answerTooLarge
          ? {
              _tag: "result",
              result: {
                content: [
                  {
                    type: "text",
                    text: "x".repeat(LaptopToolHosts.LAPTOP_TOOLS_MAX_RESULT_CHARS + 1),
                  },
                ],
              },
            }
          : undefined,
      );

      const pending = yield* hosts
        .send({ request: { _tag: "listTools" }, timeoutMs: 1_000 })
        .pipe(Effect.flip, Effect.forkScoped);
      const request = yield* Deferred.await(laptop.requested);
      yield* TestClock.adjust(1_000);
      expect((yield* Fiber.join(pending)).code).toBe("timeout");
      expect((yield* Deferred.await(laptop.cancelled)).requestId).toBe(request.requestId);

      answerTooLarge = true;
      const tooLarge = yield* hosts
        .send({ request: { _tag: "listTools" }, timeoutMs: 1_000 })
        .pipe(Effect.flip);
      expect(tooLarge.code).toBe("too-large");
    }),
  ),
);
