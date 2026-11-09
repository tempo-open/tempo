import { assert, it } from "@effect/vitest";
import type { TempoLocalServiceConnectionInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe } from "vite-plus/test";

import * as ServiceConnections from "./ServiceConnections.ts";
import { makeServicesWorld } from "./ServiceConnections.testkit.ts";
import { REDACTED, SERVICE_RESPONSE_MAX_BYTES } from "./serviceRequestPolicy.ts";

const OPENROUTER_SECRET = "sk-or-v1-management-0123456789";
const BILLING_SECRET = "billing-secret-abcdef123456";

const openrouter: TempoLocalServiceConnectionInput = {
  name: "openrouter",
  kind: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  authHeader: "Authorization",
  authScheme: "Bearer",
  secret: OPENROUTER_SECRET,
};

const ok = (body: object) => ({ status: 200, body });

const failureOf = <A, E>(effect: Effect.Effect<A, E>) => Effect.flip(effect);

describe("ServiceConnections", () => {
  it.effect("saves a local connection and never shows its secret", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      const snapshot = yield* services.saveLocal(openrouter);

      assert.deepStrictEqual(snapshot.local, [
        {
          id: "local/openrouter",
          name: "openrouter",
          kind: "openrouter",
          description: "",
          baseUrl: "https://openrouter.ai/api/v1",
          allowedMethods: ["GET"],
          allowedPathPrefixes: [],
          writable: false,
          authHeader: "Authorization",
          authScheme: "Bearer",
        },
      ]);
      assert.notInclude(JSON.stringify(snapshot), OPENROUTER_SECRET);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("rejects connections that could send a secret somewhere unexpected", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      const plainHttp = yield* failureOf(
        services.saveLocal({ ...openrouter, baseUrl: "http://openrouter.ai/api/v1" }),
      );
      assert.strictEqual(plainHttp.reason, "invalid_connection");
      const { secret: _secret, ...withoutSecret } = openrouter;
      const noSecret = yield* failureOf(services.saveLocal({ ...withoutSecret, name: "other" }));
      assert.strictEqual(noSecret.reason, "secret_required");
      const badPrefix = yield* failureOf(
        services.saveLocal({ ...openrouter, allowedPathPrefixes: ["/keys/../admin"] }),
      );
      assert.strictEqual(badPrefix.reason, "invalid_connection");

      yield* services.saveLocal(openrouter);
      const movedHost = yield* failureOf(
        services.saveLocal({ ...withoutSecret, baseUrl: "https://evil.example.com/api/v1" }),
      );
      assert.strictEqual(movedHost.reason, "secret_required");

      // Same host, new path: the saved secret follows.
      yield* services.saveLocal({ ...withoutSecret, baseUrl: "https://openrouter.ai/api/v2" });
      yield* services.request({ service: "local/openrouter", method: "GET", path: "/keys" });
      assert.strictEqual(world.requests.at(-1)?.url, "https://openrouter.ai/api/v2/keys");
      assert.strictEqual(
        world.requests.at(-1)?.headers.authorization,
        `Bearer ${OPENROUTER_SECRET}`,
      );
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("sends local requests with the secret, under the connection's policy", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal({
        ...openrouter,
        allowedMethods: ["GET", "PATCH"],
        allowedPathPrefixes: ["/keys", "/credits"],
      });

      const result = yield* services.request({
        service: "openrouter",
        method: "GET",
        path: "/keys",
        query: { include_disabled: true, tag: ["a", "b"] },
      });
      assert.deepStrictEqual(result, {
        service: "local/openrouter",
        status: 200,
        headers: { "content-type": "application/json" },
        body: { data: [] },
        bodyFormat: "json",
        truncated: false,
      });
      assert.strictEqual(
        world.requests[0]?.url,
        "https://openrouter.ai/api/v1/keys?include_disabled=true&tag=a&tag=b",
      );

      yield* services.request({
        service: "local/openrouter",
        method: "PATCH",
        path: "/keys/abc",
        body: { disabled: true },
      });
      assert.deepStrictEqual(world.requests[1]?.body, { disabled: true });

      const sent = world.requests.length;
      const post = yield* failureOf(
        services.request({ service: "local/openrouter", method: "POST", path: "/keys" }),
      );
      assert.strictEqual(post.reason, "method_not_allowed");
      assert.include(post.message, "Allowed: GET, PATCH.");
      const outsidePrefix = yield* failureOf(
        services.request({ service: "local/openrouter", method: "GET", path: "/activity" }),
      );
      assert.strictEqual(outsidePrefix.reason, "path_not_allowed");
      const climbing = yield* failureOf(
        services.request({ service: "local/openrouter", method: "GET", path: "/keys/../../../x" }),
      );
      assert.strictEqual(climbing.reason, "invalid_request");
      const encodedClimb = yield* failureOf(
        services.request({
          service: "local/openrouter",
          method: "GET",
          path: "/keys/..%2Factivity",
        }),
      );
      assert.strictEqual(encodedClimb.reason, "invalid_request");
      const otherHost = yield* failureOf(
        services.request({
          service: "local/openrouter",
          method: "GET",
          path: "//evil.example.com/keys",
        }),
      );
      assert.strictEqual(otherHost.reason, "invalid_request");
      const getWithBody = yield* failureOf(
        services.request({ service: "local/openrouter", method: "GET", path: "/keys", body: {} }),
      );
      assert.strictEqual(getWithBody.reason, "invalid_request");
      assert.strictEqual(world.requests.length, sent, "refused requests never leave the server");
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("redacts every known secret and drops unsafe headers from responses", () => {
    const world = makeServicesWorld({
      route: (request) =>
        request.url.startsWith("https://openrouter.ai")
          ? {
              status: 200,
              body: {
                echoed: request.headers.authorization,
                other: BILLING_SECRET,
                note: `billing ${BILLING_SECRET}`,
              },
              headers: {
                "set-cookie": `session=${OPENROUTER_SECRET}`,
                "x-ratelimit-remaining": "41",
              },
            }
          : ok({ data: [] }),
    });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal(openrouter);
      yield* services.saveLocal({
        name: "billing",
        kind: "http",
        baseUrl: "https://billing.example.com",
        authHeader: "X-Api-Key",
        secret: BILLING_SECRET,
      });
      const result = yield* services.request({
        service: "local/openrouter",
        method: "GET",
        path: "/key",
      });
      assert.deepStrictEqual(result.body, {
        echoed: `Bearer ${REDACTED}`,
        other: REDACTED,
        note: `billing ${REDACTED}`,
      });
      assert.deepStrictEqual(result.headers, {
        "content-type": "application/json",
        "x-ratelimit-remaining": "41",
      });
    }).pipe(Effect.provide(world.layer));
  });

  // The fake network follows redirects unless the request asks fetch not to, as fetch does.
  it.effect("returns redirects instead of following them, and cuts large bodies", () => {
    const world = makeServicesWorld({
      route: (request) =>
        request.url.endsWith("/moved")
          ? { status: 302, headers: { location: "https://elsewhere.example.com/keys" } }
          : { status: 200, body: "x".repeat(SERVICE_RESPONSE_MAX_BYTES + 10) },
    });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal(openrouter);
      const moved = yield* services.request({
        service: "local/openrouter",
        method: "GET",
        path: "/moved",
      });
      assert.strictEqual(moved.status, 302);
      assert.strictEqual(moved.headers.location, "https://elsewhere.example.com/keys");
      assert.strictEqual(world.requests.length, 1);

      const large = yield* services.request({
        service: "local/openrouter",
        method: "GET",
        path: "/large",
      });
      assert.isTrue(large.truncated);
      assert.strictEqual(large.bodyFormat, "text");
      assert.strictEqual((large.body as string).length, SERVICE_RESPONSE_MAX_BYTES);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("lists local connections under namespaced ids", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal(openrouter);
      const connections = yield* services.list;
      assert.deepStrictEqual(
        connections.map((connection) => connection.id),
        ["local/openrouter"],
      );
      assert.notProperty(connections[0], "authHeader");
      const resolved = yield* services.resolveKind("openrouter", undefined);
      assert.strictEqual(resolved.id, "local/openrouter");
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("explains what is missing when nothing can serve a request", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      const none = yield* failureOf(services.resolveKind("cloudflare", undefined));
      assert.strictEqual(none.reason, "not_configured");
      assert.include(none.message, "No Cloudflare service connection is configured");
      assert.include(none.message, "Settings → Integrations → Service connections");
      const unknown = yield* failureOf(
        services.request({ service: "billing", method: "GET", path: "/" }),
      );
      assert.strictEqual(unknown.reason, "not_found");
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("resolves a local id without sending a request", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal(openrouter);
      const sent = world.requests.length;
      const resolved = yield* services.resolveKind("openrouter", "local/openrouter");
      assert.strictEqual(resolved.id, "local/openrouter");
      assert.notProperty(resolved, "authHeader");
      const wrongKind = yield* failureOf(services.resolveKind("cloudflare", "local/openrouter"));
      assert.strictEqual(wrongKind.reason, "not_found");
      assert.strictEqual(world.requests.length, sent);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("skips saved connections it cannot read instead of failing every call", () => {
    const world = makeServicesWorld({ route: () => ok({ data: [] }) });
    const stored = (value: string) =>
      world.secrets.set("tempo-service-connections", new TextEncoder().encode(value));
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal(openrouter);
      const saved = JSON.parse(
        new TextDecoder().decode(world.secrets.get("tempo-service-connections")),
      ) as { connections: ReadonlyArray<object> };
      stored(
        JSON.stringify({
          version: 2,
          connections: [
            ...saved.connections,
            { ...saved.connections[0], name: "billing", kind: "stripe" },
          ],
        }),
      );
      const connections = yield* services.list;
      assert.deepStrictEqual(
        connections.map((connection) => connection.id),
        ["local/openrouter"],
      );

      stored("not json");
      assert.deepStrictEqual(yield* services.list, []);
      // Saving again replaces what could not be read.
      const snapshot = yield* services.saveLocal(openrouter);
      assert.deepStrictEqual(
        snapshot.local.map((connection) => connection.id),
        ["local/openrouter"],
      );
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("verifies an account-owned Cloudflare token by listing zones", () => {
    let zones = 200;
    const world = makeServicesWorld({
      route: (request) =>
        request.url.endsWith("/user/tokens/verify")
          ? { status: 401, body: { success: false } }
          : { status: zones, body: { result: [], success: zones === 200 } },
    });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal({
        name: "cloudflare",
        kind: "cloudflare",
        baseUrl: "https://api.cloudflare.com/client/v4",
        authHeader: "Authorization",
        authScheme: "Bearer",
        secret: "cf-token-0123456789abcdef",
      });
      const accountToken = yield* services.test("local/cloudflare");
      assert.isTrue(accountToken.ok);
      assert.strictEqual(
        world.requests.at(-1)?.url,
        "https://api.cloudflare.com/client/v4/zones?per_page=5",
      );
      zones = 403;
      const refused = yield* services.test("local/cloudflare");
      assert.isFalse(refused.ok);
      assert.include(refused.message, "refused the credential (HTTP 403)");
    }).pipe(Effect.provide(world.layer));
  });

  it.effect("tests a connection with one read that ignores its path policy", () => {
    const world = makeServicesWorld({
      route: (request) =>
        request.url === "https://openrouter.ai/api/v1/key" ? ok({ data: {} }) : { status: 401 },
    });
    return Effect.gen(function* () {
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal({ ...openrouter, allowedPathPrefixes: ["/keys"] });
      const passed = yield* services.test("local/openrouter");
      assert.deepStrictEqual(passed, {
        ok: true,
        status: 200,
        message: "local/openrouter answered HTTP 200.",
      });
      yield* services.saveLocal({ ...openrouter, kind: "http", allowedPathPrefixes: ["/keys"] });
      const refused = yield* services.test("local/openrouter");
      assert.strictEqual(refused.ok, false);
      assert.strictEqual(world.requests.at(-1)?.url, "https://openrouter.ai/api/v1/keys");

      yield* services.removeLocal("openrouter");
      const gone = yield* failureOf(services.test("local/openrouter"));
      assert.strictEqual(gone.reason, "not_found");
    }).pipe(Effect.provide(world.layer));
  });
});
