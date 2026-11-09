import {
  TEMPO_SERVICE_READ_METHODS,
  type TempoServiceError,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Effect from "effect/Effect";

import * as CompanyServiceApis from "../../../tempo/CompanyServiceApis.ts";
import * as ServiceConnections from "../../../tempo/ServiceConnections.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ServiceWriteApproval from "./serviceWriteApproval.ts";
import { ServicesToolkit, ServiceToolFailure } from "./tools.ts";

// Outside MCP clients are never granted "services": service secrets stay with agents Tempo starts.
const requireServiceAccess = McpInvocationContext.McpInvocationContext.pipe(
  Effect.flatMap((scope) =>
    scope.capabilities.has("services")
      ? Effect.void
      : Effect.fail(
          new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              scope.client === undefined
                ? "Service access is turned off for agents here. The user can turn on Agent service access in Settings → Browser, for the environment or this project."
                : `Service tools are only available to agents ${TEMPO_APP_BASE_NAME} starts, not to MCP clients signed in from outside.`,
          }),
        ),
  ),
);

// The service builds every message for agents; the cause stays in server logs.
const toToolFailure = (error: TempoServiceError) =>
  new ServiceToolFailure({ reason: error.reason, message: error.message });

/** Checks the capability, then runs one service call with its failure made public. */
const withServices = <A, R>(effect: Effect.Effect<A, TempoServiceError, R>) =>
  requireServiceAccess.pipe(Effect.andThen(effect.pipe(Effect.mapError(toToolFailure))));

const apis = <A>(
  use: (
    apis: CompanyServiceApis.CompanyServiceApis["Service"],
  ) => Effect.Effect<A, TempoServiceError>,
) =>
  withServices(
    Effect.gen(function* () {
      return yield* use(yield* CompanyServiceApis.CompanyServiceApis);
    }),
  );

const makeHandlers = Effect.gen(function* () {
  const askUser = yield* ServiceWriteApproval.make;

  // A saved secret can sit under any field name, so it is hidden before the card,
  // the event store and every client see the write.
  const ask = (write: ServiceWriteApproval.ServiceWrite) =>
    ServiceConnections.ServiceConnections.pipe(
      Effect.flatMap((services) => services.redactKnown(write)),
      Effect.mapError(toToolFailure),
      Effect.flatMap(askUser),
    );

  /** Checks the capability, asks the user, and runs the write only on their approval. */
  const asksFirst = <A>(
    write: ServiceWriteApproval.ServiceWrite,
    use: (
      apis: CompanyServiceApis.CompanyServiceApis["Service"],
    ) => Effect.Effect<A, TempoServiceError>,
  ) => requireServiceAccess.pipe(Effect.andThen(ask(write)), Effect.andThen(apis(use)));

  return {
    services_list: McpToolAccess.reads((input) =>
      withServices(
        Effect.gen(function* () {
          const services = yield* ServiceConnections.ServiceConnections;
          const connections = yield* services.list;
          return {
            connections:
              input.kind === undefined
                ? connections
                : connections.filter((connection) => connection.kind === input.kind),
          };
        }),
      ),
    ),
    // Generic, so it may write: the caller must be live and not read-only.
    service_request: McpToolAccess.writesWithCapability((input) =>
      requireServiceAccess.pipe(
        Effect.andThen(
          // Only reads leave a service unchanged; every other method asks the user first.
          TEMPO_SERVICE_READ_METHODS.has(input.method)
            ? Effect.void
            : ServiceConnections.ServiceConnections.pipe(
                Effect.flatMap((services) => services.list),
                Effect.map((connections) => {
                  const named = connections.filter(
                    ({ id, name }) => id === input.service || name === input.service,
                  );
                  return named.length === 1 ? named[0]?.kind : undefined;
                }),
                Effect.mapError(toToolFailure),
                Effect.flatMap((kind) =>
                  ask({
                    tool: "service_request",
                    service: input.service,
                    kind,
                    operation: input.method,
                    target: input.path,
                    payload: { query: input.query, body: input.body },
                  }),
                ),
              ),
        ),
        Effect.andThen(
          withServices(
            Effect.gen(function* () {
              const services = yield* ServiceConnections.ServiceConnections;
              return yield* services.request(input);
            }),
          ),
        ),
      ),
    ),
    openrouter_keys_list: McpToolAccess.reads((input) =>
      apis((service) => service.openrouterKeysList(input)),
    ),
    openrouter_key_create: McpToolAccess.writesWithCapability(({ service, ...fields }) =>
      asksFirst(
        {
          tool: "openrouter_key_create",
          kind: "openrouter",
          service: service ?? "openrouter",
          operation: "Create key",
          target: fields.name,
          payload: fields,
        },
        (apis) => apis.openrouterKeyCreate({ service, ...fields }),
      ),
    ),
    openrouter_key_update: McpToolAccess.writesWithCapability(({ service, ...fields }) =>
      asksFirst(
        {
          tool: "openrouter_key_update",
          kind: "openrouter",
          service: service ?? "openrouter",
          operation: "Update key",
          target: fields.hash,
          payload: fields,
        },
        (apis) => apis.openrouterKeyUpdate({ service, ...fields }),
      ),
    ),
    openrouter_key_delete: McpToolAccess.writesWithCapability((input) =>
      asksFirst(
        {
          tool: "openrouter_key_delete",
          kind: "openrouter",
          service: input.service ?? "openrouter",
          operation: "Delete key",
          target: input.hash,
        },
        (apis) => apis.openrouterKeyDelete(input),
      ),
    ),
    openrouter_credits: McpToolAccess.reads((input) =>
      apis((service) => service.openrouterCredits(input)),
    ),
    openrouter_activity: McpToolAccess.reads((input) =>
      apis((service) => service.openrouterActivity(input)),
    ),
    cloudflare_zones_list: McpToolAccess.reads((input) =>
      apis((service) => service.cloudflareZonesList(input)),
    ),
    cloudflare_dns_records_list: McpToolAccess.reads((input) =>
      apis((service) => service.cloudflareDnsRecordsList(input)),
    ),
    cloudflare_dns_record_upsert: McpToolAccess.writesWithCapability(({ service, ...fields }) =>
      asksFirst(
        {
          tool: "cloudflare_dns_record_upsert",
          kind: "cloudflare",
          service: service ?? "cloudflare",
          operation: "Create or update DNS record",
          target: `${fields.type} ${fields.name}`,
          payload: fields,
        },
        (apis) => apis.cloudflareDnsRecordUpsert({ service, ...fields }),
      ),
    ),
    cloudflare_workers_list: McpToolAccess.reads((input) =>
      apis((service) => service.cloudflareWorkersList(input)),
    ),
  } satisfies McpToolAccess.Handlers<typeof ServicesToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(ServicesToolkit, makeHandlers);
