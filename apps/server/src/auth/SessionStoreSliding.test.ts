// tempo: paired bearer and browser-cookie sessions slide forward while they are used.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const DAY = Duration.toMillis(Duration.days(1));

const layerSessionStore = SessionStore.layer.pipe(
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(EnvironmentId.make("sliding-test")),
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-sliding-test-" })),
);

const pairedSession = {
  method: "bearer-access-token",
  subject: "paired-phone",
  sliding: true,
  ttl: Duration.days(4),
} as const;

describe("slidingSessionExpiry", () => {
  it("moves the deadline to now plus the session length, at most once per interval", () => {
    const lengthMs = 30 * DAY;
    expect(slide({ lengthMs, currentExpiresAtMs: 30 * DAY, nowMs: 10 * DAY })).toBe(40 * DAY);
    // Used again an hour later: no write.
    expect(
      slide({ lengthMs, currentExpiresAtMs: 40 * DAY, nowMs: 10 * DAY + DAY / 24 }),
    ).toBeNull();
    // A day later: slides again.
    expect(slide({ lengthMs, currentExpiresAtMs: 40 * DAY, nowMs: 11 * DAY })).toBe(41 * DAY);
  });

  it("never revives an expired session", () => {
    expect(slide({ lengthMs: 30 * DAY, currentExpiresAtMs: 5 * DAY, nowMs: 5 * DAY })).toBeNull();
  });
});

function slide(input: Parameters<typeof SessionStore.slidingSessionExpiry>[0]) {
  return SessionStore.slidingSessionExpiry(input);
}

it.layer(NodeServices.layer)("SessionStore sliding sessions", (it) => {
  it.effect("keeps a paired session working past its first deadline while it is used", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(pairedSession);

      yield* TestClock.adjust(Duration.days(3));
      const used = yield* sessions.verify(issued.token);
      expect(used.expiresAt?.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds + 3 * DAY);

      // Past the token's own exp, still inside the slid window.
      yield* TestClock.adjust(Duration.days(3));
      const later = yield* sessions.verify(issued.token);
      expect(later.sessionId).toBe(issued.sessionId);
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);
      expect((yield* sessions.verifyWebSocketToken(websocket.token)).sessionId).toBe(
        issued.sessionId,
      );

      // Left unused for longer than its length, it expires.
      yield* TestClock.adjust(Duration.days(5));
      expect(yield* Effect.flip(sessions.verify(issued.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
      });
    }).pipe(Effect.provide(Layer.merge(layerSessionStore, TestClock.layer()))),
  );

  it.effect("writes at most once per renewal interval", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(pairedSession);
      yield* TestClock.adjust(Duration.days(2));
      const first = yield* sessions.verify(issued.token);
      yield* TestClock.adjust(Duration.hours(1));
      const second = yield* sessions.verify(issued.token);
      expect(second.expiresAt?.epochMilliseconds).toBe(first.expiresAt?.epochMilliseconds);
    }).pipe(Effect.provide(Layer.merge(layerSessionStore, TestClock.layer()))),
  );

  it.effect("revokes a slid session immediately", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(pairedSession);
      yield* TestClock.adjust(Duration.days(3));
      yield* sessions.verify(issued.token);
      expect(yield* sessions.revoke(issued.sessionId)).toBe(true);
      expect(yield* Effect.flip(sessions.verify(issued.token))).toMatchObject({
        _tag: "SessionTokenRevokedError",
      });
    }).pipe(Effect.provide(Layer.merge(layerSessionStore, TestClock.layer()))),
  );

  it.effect("does not slide sessions issued without it", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({ ...pairedSession, sliding: false });
      yield* TestClock.adjust(Duration.days(3));
      const used = yield* sessions.verify(issued.token);
      expect(used.expiresAt?.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
      yield* TestClock.adjust(Duration.days(2));
      expect(yield* Effect.flip(sessions.verify(issued.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
      });
    }).pipe(Effect.provide(Layer.merge(layerSessionStore, TestClock.layer()))),
  );

  it.effect("slides a paired browser's cookie session, but never a proof-bound one", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const browser = yield* sessions.issue({
        ...pairedSession,
        method: "browser-session-cookie",
      });
      const proofBound = yield* sessions.issue({
        ...pairedSession,
        method: "dpop-access-token",
        proofKeyThumbprint: "relay-proof-key",
      });
      yield* TestClock.adjust(Duration.days(3));
      const used = yield* sessions.verify(browser.token);
      expect(used.expiresAt?.epochMilliseconds).toBe(browser.expiresAt.epochMilliseconds + 3 * DAY);
      expect((yield* sessions.verify(proofBound.token)).expiresAt?.epochMilliseconds).toBe(
        proofBound.expiresAt.epochMilliseconds,
      );
      // Past the cookie token's own exp, the browser still signs in; the other does not.
      yield* TestClock.adjust(Duration.days(3));
      expect((yield* sessions.verify(browser.token)).sessionId).toBe(browser.sessionId);
      expect(yield* Effect.flip(sessions.verify(proofBound.token))).toMatchObject({
        _tag: "SessionTokenExpiredError",
      });
    }).pipe(Effect.provide(Layer.merge(layerSessionStore, TestClock.layer()))),
  );

  it.effect("keeps sliding a session while its connection stays open", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue(pairedSession);
      yield* sessions.verify(issued.token);
      yield* sessions.markConnected(issued.sessionId);
      const invalidated = yield* Deferred.make<void>();
      const watcher = yield* sessions
        .awaitInvalidation(issued.sessionId)
        .pipe(
          Effect.andThen(Deferred.succeed(invalidated, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
      for (let day = 0; day < 10; day++) {
        yield* TestClock.adjust(Duration.days(1));
      }
      expect(yield* Deferred.isDone(invalidated)).toBe(false);
      expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);

      yield* sessions.revoke(issued.sessionId);
      yield* Fiber.join(watcher);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layerSessionStore, TestClock.layer()))),
  );
});
