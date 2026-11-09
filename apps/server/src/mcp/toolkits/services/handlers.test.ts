import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, type RuntimeMode, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { McpSchema, McpServer, Tool } from "effect/ai";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import * as ServiceConnections from "../../../tempo/ServiceConnections.ts";
import {
  makeServicesWorld,
  type SentServiceRequest,
  type ServiceReply,
} from "../../../tempo/ServiceConnections.testkit.ts";
import {
  TEMPO_SERVICE_APPROVAL_TOOL_NAMES,
  TEMPO_SERVICE_READ_TOOL_NAMES,
} from "@t3tools/shared/tempoServiceToolNames";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { SERVICE_APPROVAL_TIMEOUT_MS } from "./serviceWriteApproval.ts";
import { makeApprovalWorld, type UserAnswer } from "./serviceWriteApproval.testkit.ts";
import { ServicesToolkit } from "./tools.ts";

const CLOUDFLARE_TOKEN = "cf-token-0123456789abcdef";

const OUTSIDE_CLIENT: McpInvocationContext.McpClientCaller = {
  sessionId: "outside-session",
  label: "Outside agent",
  access: "full-access",
};

const scope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
  outside = false,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("services-environment"),
  requestNamespace: "services-session",
  thread: outside
    ? undefined
    : {
        threadId: ThreadId.make("services-thread"),
        providerSessionId: "services-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
  client: outside ? OUTSIDE_CLIENT : undefined,
  issuedAt: 0,
  capabilities: new Set(capabilities),
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "services-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "services-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/**
 * The production registration over a network that answers with `route`, in a
 * thread in `runtimeMode` whose user answers every approval card with `answer`.
 */
const withServicesTools = (
  route: (request: SentServiceRequest) => ServiceReply,
  answer: UserAnswer = "approve",
  askBeforeServiceWrites = true,
  runtimeMode: RuntimeMode = "auto-accept-edits",
) => {
  const world = makeServicesWorld({ route });
  const approvals = makeApprovalWorld({ answer, runtimeMode });
  const layer = McpHttpServer.layerServicesToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(approvals.layer),
    Layer.provide(ServerSettings.layerTest({ askBeforeServiceWrites })),
    Layer.provideMerge(world.layer),
  );
  const call = (
    name: string,
    args: Record<string, unknown>,
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["orchestration", "services"],
    outside = false,
  ) =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      return yield* server
        .callTool({ name, arguments: args })
        .pipe(
          Effect.provideService(
            McpInvocationContext.McpInvocationContext,
            scope(capabilities, outside),
          ),
          Effect.provideService(McpSchema.McpServerClient, client),
        );
    });
  return { world, layer, call, approvals };
};

// A declared failure with a message comes back as `isError` with that message as its text.
const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text" ? text.text : undefined;
};

const saveCloudflare = Effect.gen(function* () {
  const services = yield* ServiceConnections.ServiceConnections;
  yield* services.saveLocal({
    name: "cloudflare",
    kind: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    authHeader: "Authorization",
    authScheme: "Bearer",
    secret: CLOUDFLARE_TOKEN,
    allowedMethods: ["GET", "POST", "PATCH"],
  });
});

describe("services toolkit", () => {
  it("names its read and approval tools from their annotations", () => {
    const tools = Object.values(ServicesToolkit.tools);
    assert.deepStrictEqual(
      tools
        .filter((tool) => Context.get(tool.annotations, Tool.Readonly))
        .map((tool) => tool.name)
        .toSorted(),
      [...TEMPO_SERVICE_READ_TOOL_NAMES].toSorted(),
    );
    assert.deepStrictEqual(
      tools
        .filter((tool) => !Context.get(tool.annotations, Tool.Readonly))
        .map((tool) => tool.name)
        .toSorted(),
      [...TEMPO_SERVICE_APPROVAL_TOOL_NAMES].toSorted(),
    );
  });

  it.effect("hides every tool when agent service access is off", () => {
    const { layer, call, world } = withServicesTools(() => ({ status: 200, body: {} }));
    return Effect.gen(function* () {
      yield* saveCloudflare;
      for (const [name, args] of [
        ["services_list", {}],
        ["cloudflare_zones_list", {}],
        ["service_request", { service: "local/cloudflare", method: "GET", path: "/zones" }],
      ] as const) {
        const error = yield* call(name, args, ["orchestration"]).pipe(Effect.flip);
        assert.equal(error.message, `Tool '${name}' not found`);
      }
      const outside = yield* call("services_list", {}, ["orchestration"], true).pipe(Effect.flip);
      assert.equal(outside.message, "Tool 'services_list' not found");
      assert.strictEqual(world.requests.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("writes a created OpenRouter key to a new file and keeps it out of the result", () => {
    const NEW_KEY = "sk-or-v1-created-0123456789abcdef";
    const { layer, call, world } = withServicesTools((request) =>
      request.method === "POST"
        ? {
            status: 201,
            body: {
              data: { hash: "hash1", name: "ci", label: "sk-or-v1-cre...def" },
              key: NEW_KEY,
            },
          }
        : { status: 200, body: {} },
    );
    return Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const saveTo = path.join(yield* fileSystem.makeTempDirectoryScoped(), "keys", "ci.key");
      const services = yield* ServiceConnections.ServiceConnections;
      yield* services.saveLocal({
        name: "openrouter",
        kind: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        authHeader: "Authorization",
        authScheme: "Bearer",
        secret: "sk-or-v1-management-0123456789",
        allowedMethods: ["GET", "POST"],
      });
      const created = yield* call("openrouter_key_create", { name: "ci", saveTo });
      assert.notInclude(JSON.stringify(created), NEW_KEY);
      assert.deepInclude(created.structuredContent, {
        status: 201,
        body: {
          data: { hash: "hash1", name: "ci", label: "sk-or-v1-cre...def" },
          key: `[saved to ${saveTo}]`,
        },
      });
      assert.strictEqual(yield* fileSystem.readFileString(saveTo), `${NEW_KEY}\n`);
      assert.strictEqual((yield* fileSystem.stat(saveTo)).mode & 0o777, 0o600);

      // An existing file is refused before a second key is created.
      const posts = world.requests.filter((request) => request.method === "POST").length;
      const again = yield* call("openrouter_key_create", { name: "ci", saveTo });
      assert.include(failureOf(again), "already exists");
      const relative = yield* call("openrouter_key_create", { name: "ci", saveTo: "ci.key" });
      assert.include(failureOf(relative), "absolute file path");
      assert.strictEqual(
        world.requests.filter((request) => request.method === "POST").length,
        posts,
      );
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect(
    "lists connections and calls typed helpers against the connection of their kind",
    () => {
      const { layer, call, world } = withServicesTools((request) =>
        request.url.startsWith("https://api.cloudflare.com")
          ? { status: 200, body: { result: [{ id: "zone1", name: "example.com" }], success: true } }
          : { status: 404, body: { error: "Not found" } },
      );
      return Effect.gen(function* () {
        yield* saveCloudflare;
        const listed = yield* call("services_list", { kind: "cloudflare" });
        assert.deepStrictEqual(
          (
            listed.structuredContent as { readonly connections: ReadonlyArray<{ id: string }> }
          ).connections.map((connection) => connection.id),
          ["local/cloudflare"],
        );

        const zones = yield* call("cloudflare_zones_list", { name: "example.com", perPage: 50 });
        assert.deepInclude(zones.structuredContent, { service: "local/cloudflare", status: 200 });
        const sent = world.requests.at(-1);
        assert.strictEqual(
          sent?.url,
          "https://api.cloudflare.com/client/v4/zones?name=example.com&per_page=50",
        );
        assert.strictEqual(sent?.headers.authorization, `Bearer ${CLOUDFLARE_TOKEN}`);

        const noOpenRouter = yield* call("openrouter_credits", {});
        assert.include(failureOf(noOpenRouter), "No OpenRouter service connection is configured");
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("upserts a DNS record by updating its one match or creating it", () => {
    let existing: ReadonlyArray<{ readonly id: string }> = [{ id: "rec1" }];
    const { layer, call, world } = withServicesTools((request) =>
      request.method === "GET"
        ? { status: 200, body: { result: existing, success: true } }
        : { status: 200, body: { result: { id: "rec-new" }, success: true } },
    );
    const record = {
      zoneId: "zone1",
      type: "CNAME",
      name: "app.example.com",
      content: "example.pages.dev",
      proxied: true,
    };
    return Effect.gen(function* () {
      yield* saveCloudflare;
      yield* call("cloudflare_dns_record_upsert", record);
      assert.deepStrictEqual(
        world.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
        ["GET /client/v4/zones/zone1/dns_records", "PATCH /client/v4/zones/zone1/dns_records/rec1"],
      );
      assert.deepStrictEqual(world.requests[1]?.body, {
        type: "CNAME",
        name: "app.example.com",
        content: "example.pages.dev",
        proxied: true,
      });

      existing = [];
      yield* call("cloudflare_dns_record_upsert", record);
      assert.strictEqual(world.requests.at(-1)?.method, "POST");

      existing = [{ id: "a" }, { id: "b" }];
      const several = yield* call("cloudflare_dns_record_upsert", record);
      assert.include(failureOf(several), "(a, b); pass recordId");

      const sent = world.requests.length;
      // Ids become path segments, so one that could climb the path is refused before anything is sent.
      const injected = yield* call("cloudflare_dns_record_upsert", {
        ...record,
        zoneId: "../accounts",
      }).pipe(Effect.flip);
      assert.include(injected.message, "Invalid parameters");
      assert.strictEqual(world.requests.length, sent);
    }).pipe(Effect.provide(layer));
  });

  it.effect("returns the connection's refusal for a write it does not allow", () => {
    const { layer, call, world } = withServicesTools(() => ({ status: 200, body: {} }));
    return Effect.gen(function* () {
      yield* saveCloudflare;
      const result = yield* call("service_request", {
        service: "cloudflare",
        method: "DELETE",
        path: "/zones/zone1",
      });
      assert.strictEqual(
        failureOf(result),
        "local/cloudflare does not allow DELETE requests. Allowed: GET, POST, PATCH. Ask the user to allow it in Settings → Integrations → Service connections.",
      );
      assert.strictEqual(world.requests.length, 0);
    }).pipe(Effect.provide(layer));
  });
  // One call per tool that is not annotated read-only, so a new write tool must ask too.
  const WRITES: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    ["service_request", { service: "cloudflare", method: "PATCH", path: "/zones/zone1" }],
    ["openrouter_key_create", { service: "local/cloudflare", name: "ci", saveTo: "/tmp/x.key" }],
    ["openrouter_key_update", { service: "local/cloudflare", hash: "hash1", disabled: true }],
    ["openrouter_key_delete", { service: "local/cloudflare", hash: "hash1" }],
    [
      "cloudflare_dns_record_upsert",
      { zoneId: "zone1", type: "A", name: "app.example.com", content: "192.0.2.1" },
    ],
  ];

  it("covers every write tool in the approval tests", () => {
    assert.deepStrictEqual(
      WRITES.map(([name]) => name).toSorted(),
      [...TEMPO_SERVICE_APPROVAL_TOOL_NAMES].toSorted(),
    );
  });

  it.effect("asks before every write and sends nothing when the user denies", () => {
    const { layer, call, world, approvals } = withServicesTools(
      () => ({ status: 200, body: {} }),
      "deny",
    );
    return Effect.gen(function* () {
      yield* saveCloudflare;
      for (const [name, args] of WRITES) {
        const result = yield* call(name, args);
        assert.include(failureOf(result), "The user denied this service write", name);
      }
      assert.strictEqual(world.requests.length, 0);
      assert.deepStrictEqual(
        [...approvals.cards.values()].map((card) => card.name).toSorted(),
        WRITES.map(([name]) => `mcp__t3-code__${name}`).toSorted(),
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect(
    "full access skips the card for Cloudflare, and keeps it for mail and other APIs",
    () => {
      const { layer, call, world, approvals } = withServicesTools(
        () => ({ status: 200, body: { result: { id: "zone1" } } }),
        "deny",
        true,
        "full-access",
      );
      return Effect.gen(function* () {
        yield* saveCloudflare;
        const dns = yield* call("service_request", {
          service: "cloudflare",
          method: "PATCH",
          path: "/zones/zone1",
          body: { paused: true },
        });
        assert.strictEqual(failureOf(dns), undefined);
        assert.strictEqual(approvals.cards.size, 0);

        const mail = yield* call("service_request", {
          service: "cloudflare",
          method: "POST",
          path: "/accounts/account1/email/sending/send",
        });
        assert.include(failureOf(mail), "The user denied this service write");

        const services = yield* ServiceConnections.ServiceConnections;
        yield* services.saveLocal({
          name: "crm",
          kind: "http",
          baseUrl: "https://crm.example.com",
          authHeader: "Authorization",
          authScheme: "Bearer",
          secret: "crm-secret-0123456789abcdef",
          allowedMethods: ["GET", "POST"],
        });
        const crm = yield* call("service_request", {
          service: "crm",
          method: "POST",
          path: "/messages",
        });
        assert.include(failureOf(crm), "The user denied this service write");

        assert.deepStrictEqual(
          world.requests.map((request) => request.method),
          ["PATCH"],
        );
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("runs a write without a card when Ask before service writes is off", () => {
    const { layer, call, world, approvals } = withServicesTools(
      () => ({ status: 200, body: { result: { id: "zone1" } } }),
      "deny",
      false,
    );
    return Effect.gen(function* () {
      yield* saveCloudflare;
      const result = yield* call("service_request", {
        service: "cloudflare",
        method: "PATCH",
        path: "/zones/zone1",
        body: { paused: true },
      });
      assert.strictEqual(failureOf(result), undefined);
      assert.deepStrictEqual(
        world.requests.map((request) => `${request.method} ${new URL(request.url).pathname}`),
        ["PATCH /client/v4/zones/zone1"],
      );
      assert.strictEqual(approvals.cards.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs a write once the user approves, on a card that names it", () => {
    const { layer, call, world, approvals } = withServicesTools(() => ({
      status: 200,
      body: { result: { id: "rec-new" }, success: true },
    }));
    return Effect.gen(function* () {
      yield* saveCloudflare;
      const result = yield* call("service_request", {
        service: "cloudflare",
        method: "POST",
        path: "/zones/zone1/dns_records",
        body: { type: "TXT", name: "example.com", content: "v=1", api_token: CLOUDFLARE_TOKEN },
      });
      assert.deepInclude(result.structuredContent, { status: 200 });
      assert.deepStrictEqual(
        world.requests.map((request) => request.method),
        ["POST"],
      );
      const [card] = [...approvals.cards.values()];
      assert.strictEqual(card?.subtitle, "cloudflare · POST /zones/zone1/dns_records");
      assert.include(card?.input, '"api_token":"[redacted]"');
      assert.notInclude(card?.input, CLOUDFLARE_TOKEN);
    }).pipe(Effect.provide(layer));
  });

  it.effect("never asks for a read", () => {
    const { layer, call, world, approvals } = withServicesTools(
      () => ({ status: 200, body: { result: [], success: true } }),
      "deny",
    );
    return Effect.gen(function* () {
      yield* saveCloudflare;
      yield* call("cloudflare_zones_list", {});
      yield* call("cloudflare_dns_records_list", { zoneId: "zone1" });
      const read = yield* call("service_request", {
        service: "cloudflare",
        method: "GET",
        path: "/zones",
      });
      assert.deepInclude(read.structuredContent, { status: 200 });
      assert.strictEqual(world.requests.length, 3);
      assert.strictEqual(approvals.cards.size, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("closes the card and sends nothing when the user does not answer", () => {
    const { layer, call, world, approvals } = withServicesTools(
      () => ({ status: 200, body: {} }),
      "ignore",
    );
    return Effect.gen(function* () {
      yield* saveCloudflare;
      const pending = yield* call("cloudflare_dns_record_upsert", {
        zoneId: "zone1",
        type: "A",
        name: "app.example.com",
        content: "192.0.2.1",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(SERVICE_APPROVAL_TIMEOUT_MS);
      const result = yield* Fiber.join(pending);
      assert.include(failureOf(result), "did not answer");
      assert.strictEqual(world.requests.length, 0);
      assert.deepStrictEqual(
        [...approvals.requests.values()].map((request) => request.status),
        ["cancelled"],
      );
      assert.strictEqual(approvals.closes.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs the write when Allow once lands as the wait times out", () => {
    const { layer, call, world, approvals } = withServicesTools(
      () => ({ status: 200, body: { result: { id: "rec-new" }, success: true } }),
      "late",
    );
    return Effect.gen(function* () {
      yield* saveCloudflare;
      const pending = yield* call("service_request", {
        service: "cloudflare",
        method: "POST",
        path: "/zones/zone1/dns_records",
      }).pipe(Effect.forkChild);
      yield* TestClock.adjust(SERVICE_APPROVAL_TIMEOUT_MS);
      const result = yield* Fiber.join(pending);
      // The card says Allowed, so the write must run.
      assert.deepStrictEqual(
        [...approvals.requests.values()].map((request) => request.decision),
        ["accept"],
      );
      assert.deepInclude(result.structuredContent, { status: 200 });
      assert.deepStrictEqual(
        world.requests.map((request) => request.method),
        ["POST"],
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("hides the connection's own secret on the card under any field name", () => {
    const { layer, call, world, approvals } = withServicesTools(
      () => ({ status: 200, body: {} }),
      "deny",
    );
    return Effect.gen(function* () {
      yield* saveCloudflare;
      // Cloudflare's Worker-secrets call sends the secret as `text`.
      yield* call("service_request", {
        service: "cloudflare",
        method: "PATCH",
        path: `/accounts/a/workers/scripts/s/secrets/${CLOUDFLARE_TOKEN}`,
        query: { note: CLOUDFLARE_TOKEN },
        body: { name: "UPSTREAM", text: CLOUDFLARE_TOKEN },
      });
      assert.strictEqual(world.requests.length, 0);
      const [card] = [...approvals.cards.values()];
      assert.include(card?.input, '"text":"[redacted]"');
      assert.notInclude(JSON.stringify(card), CLOUDFLARE_TOKEN);
    }).pipe(Effect.provide(layer));
  });
});
