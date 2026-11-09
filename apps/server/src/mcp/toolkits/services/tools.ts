import {
  TempoServiceConnection,
  TempoServiceFailureReason,
  TempoServiceKind,
  TempoServiceMethod,
  TempoServiceRequestResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as CompanyServiceApis from "../../../tempo/CompanyServiceApis.ts";
import * as ServiceConnections from "../../../tempo/ServiceConnections.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

/** A service call failed; `message` says what to do next. */
export class ServiceToolFailure extends Schema.TaggedError<ServiceToolFailure>()(
  "ServiceToolFailure",
  { reason: TempoServiceFailureReason, message: Schema.String },
) {}

const ServicesToolError = Schema.Union([ServiceToolFailure, OrchestratorMcpFailure]);

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ServiceConnections.ServiceConnections,
  CompanyServiceApis.CompanyServiceApis,
];

const NO_KEYS =
  "Service secrets are injected on the server; you never see or pass them, and responses have them redacted.";

const viaService = (kind: string) =>
  Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: `Connection id from services_list, such as local/${kind}. Omit when only one ${kind} connection exists.`,
    }),
  );

const Id = (label: string, description: string) =>
  Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_-]{1,128}$/)).annotate({
    description: `${label}: ${description}`,
  });

const PageNumber = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));

const QueryValue = Schema.Union([Schema.String, Schema.Number, Schema.Boolean]);

const ServicesListResult = Schema.Struct({
  connections: Schema.Array(TempoServiceConnection),
});

const ServicesListTool = Tool.make("services_list", {
  description: `List the service connections you can call: the ones the user saved on this environment. Each has an id (local/<name>), a kind, a base URL, the HTTP methods it allows, and its allowed path prefixes. ${NO_KEYS}`,
  parameters: Schema.Struct({
    kind: Schema.optional(
      TempoServiceKind.annotate({ description: "Only connections of this kind." }),
    ),
  }),
  success: ServicesListResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "List services")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const ServiceRequestTool = Tool.make("service_request", {
  description: `Send one HTTP request through a service connection from services_list. The path is relative to the connection's base URL; put query parameters in query and a JSON body in body. The connection's policy decides which methods and paths are allowed, and the user may be asked to approve the call. Non-2xx answers come back as results with their status. Bodies over 1 MB are cut and returned as text. Prefer the openrouter_* and cloudflare_* tools for those services. ${NO_KEYS}`,
  parameters: Schema.Struct({
    service: TrimmedNonEmptyString.annotate({
      description:
        "Connection id from services_list, such as local/openrouter or local/billing. A bare name works when only one connection has it.",
    }),
    method: TempoServiceMethod,
    path: Schema.String.check(Schema.isMaxLength(2_048)).annotate({
      description: "Path below the base URL, such as /keys. No query string or fragment.",
    }),
    query: Schema.optional(
      Schema.Record(Schema.String, Schema.Union([QueryValue, Schema.Array(QueryValue)])).annotate({
        description: "Query parameters; an array repeats the parameter.",
      }),
    ),
    body: Schema.optional(
      Schema.Unknown.annotate({ description: "JSON body. Not allowed with GET or HEAD." }),
    ),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Call a service")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const OpenRouterLimit = {
  limit: Schema.optional(
    Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0))).annotate({
      description: "Spending limit in USD; null removes it.",
    }),
  ),
  limitReset: Schema.optional(
    Schema.NullOr(Schema.Literals(["daily", "weekly", "monthly"])).annotate({
      description: "When the limit resets (midnight UTC); null never resets it.",
    }),
  ),
};

const OPENROUTER_MANAGEMENT =
  "Needs an OpenRouter management (provisioning) key on the connection.";

const OpenRouterKeysListTool = Tool.make("openrouter_keys_list", {
  description: `List the API keys on the connected OpenRouter account with their names, hashes, limits, usage, and whether they are disabled. Never returns key values. ${OPENROUTER_MANAGEMENT}`,
  parameters: Schema.Struct({
    service: viaService("openrouter"),
    offset: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    includeDisabled: Schema.optional(Schema.Boolean),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "List OpenRouter keys")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const OpenRouterKeyCreateTool = Tool.make("openrouter_key_create", {
  description: `Create an OpenRouter API key on the connected account. The server writes the new key to saveTo, a new file only this machine's user can read, and the result shows that path where the key would be: tool results are kept in thread history, so the key never appears in them. Do not print the file; feed it to what needs the key (for example \`wrangler secret put NAME < file\`), then delete it. ${OPENROUTER_MANAGEMENT}`,
  parameters: Schema.Struct({
    service: viaService("openrouter"),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    saveTo: TrimmedNonEmptyString.check(Schema.isMaxLength(1_024)).annotate({
      description:
        "Absolute path of a file that does not exist yet, outside git, such as /tmp/openrouter-ci.key. Missing directories are created.",
    }),
    ...OpenRouterLimit,
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create OpenRouter key")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

const OpenRouterKeyUpdateTool = Tool.make("openrouter_key_update", {
  description: `Rename, disable or re-enable, or change the spending limit of an OpenRouter API key, by its hash from openrouter_keys_list. ${OPENROUTER_MANAGEMENT}`,
  parameters: Schema.Struct({
    service: viaService("openrouter"),
    hash: Id("hash", "the key's hash from openrouter_keys_list."),
    name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
    disabled: Schema.optional(Schema.Boolean),
    ...OpenRouterLimit,
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Update OpenRouter key")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const OpenRouterKeyDeleteTool = Tool.make("openrouter_key_delete", {
  description: `Delete an OpenRouter API key by its hash from openrouter_keys_list. Anything using the key stops working. ${OPENROUTER_MANAGEMENT}`,
  parameters: Schema.Struct({
    service: viaService("openrouter"),
    hash: Id("hash", "the key's hash from openrouter_keys_list."),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Delete OpenRouter key")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const OpenRouterCreditsTool = Tool.make("openrouter_credits", {
  description:
    "Read the connected OpenRouter account's credits: total purchased and total used, in USD. Remaining is the difference.",
  parameters: Schema.Struct({ service: viaService("openrouter") }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read OpenRouter credits")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const OpenRouterActivityTool = Tool.make("openrouter_activity", {
  description: `Read OpenRouter usage for the last 30 completed UTC days, grouped by day, model, and endpoint, or for one day. ${OPENROUTER_MANAGEMENT}`,
  parameters: Schema.Struct({
    service: viaService("openrouter"),
    date: Schema.optional(
      Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/)).annotate({
        description: "One UTC day, YYYY-MM-DD.",
      }),
    ),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read OpenRouter activity")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CloudflareZonesListTool = Tool.make("cloudflare_zones_list", {
  description:
    "List the Cloudflare zones (domains) the connection's token can see, with their ids, names, status, and account. Use a zone id with cloudflare_dns_records_list.",
  parameters: Schema.Struct({
    service: viaService("cloudflare"),
    name: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Only this domain, such as example.com." }),
    ),
    accountId: Schema.optional(Id("accountId", "only zones in this Cloudflare account.")),
    page: Schema.optional(PageNumber),
    perPage: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 50 }))),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Cloudflare zones")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CloudflareDnsRecordsListTool = Tool.make("cloudflare_dns_records_list", {
  description: "List a Cloudflare zone's DNS records, optionally of one type or name.",
  parameters: Schema.Struct({
    service: viaService("cloudflare"),
    zoneId: Id("zoneId", "the zone id from cloudflare_zones_list."),
    type: Schema.optional(
      TrimmedNonEmptyString.annotate({ description: "Record type, such as A, CNAME, or TXT." }),
    ),
    name: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description: "Full record name, such as www.example.com.",
      }),
    ),
    page: Schema.optional(PageNumber),
    perPage: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 5000 }))),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Cloudflare DNS records")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CloudflareDnsRecordUpsertTool = Tool.make("cloudflare_dns_record_upsert", {
  description:
    "Create or update one DNS record in a Cloudflare zone. With recordId it updates that record; otherwise it updates the record with the same type and name, or creates one when none exists. Several matches is an error that lists their ids.",
  parameters: Schema.Struct({
    service: viaService("cloudflare"),
    zoneId: Id("zoneId", "the zone id from cloudflare_zones_list."),
    recordId: Schema.optional(Id("recordId", "the record to update.")),
    type: TrimmedNonEmptyString.annotate({ description: "Record type, such as A, CNAME, or TXT." }),
    name: TrimmedNonEmptyString.annotate({
      description: "Full record name, such as www.example.com.",
    }),
    content: Schema.String.annotate({
      description: "Record content, such as an IP address or target host.",
    }),
    ttl: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)).annotate({
        description: "Seconds; 1 means automatic.",
      }),
    ),
    proxied: Schema.optional(Schema.Boolean),
    comment: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "Create or update Cloudflare DNS record")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

const CloudflareWorkersListTool = Tool.make("cloudflare_workers_list", {
  description: "List the Workers scripts in a Cloudflare account.",
  parameters: Schema.Struct({
    service: viaService("cloudflare"),
    accountId: Id("accountId", "the Cloudflare account id, as cloudflare_zones_list shows it."),
  }),
  success: TempoServiceRequestResult,
  failure: ServicesToolError,
  dependencies,
})
  .annotate(Tool.Title, "List Cloudflare Workers")
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutCapability("services"))
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true);

export const ServicesToolkit = Toolkit.make(
  ServicesListTool,
  ServiceRequestTool,
  OpenRouterKeysListTool,
  OpenRouterKeyCreateTool,
  OpenRouterKeyUpdateTool,
  OpenRouterKeyDeleteTool,
  OpenRouterCreditsTool,
  OpenRouterActivityTool,
  CloudflareZonesListTool,
  CloudflareDnsRecordsListTool,
  CloudflareDnsRecordUpsertTool,
  CloudflareWorkersListTool,
);
