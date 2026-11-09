import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CompanyServiceApis from "./CompanyServiceApis.ts";
import * as ServiceConnections from "./ServiceConnections.ts";

export interface SentServiceRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

export type ServiceReply =
  | {
      readonly status: number;
      readonly body?: string | object | undefined;
      readonly headers?: Readonly<Record<string, string>> | undefined;
    }
  | "unreachable";

/**
 * The service connection stack over an in-memory secret store and a network that
 * answers every request with `route`. `requests` records what was sent. Like
 * fetch, the network follows a redirect unless the request's
 * FetchHttpClient.RequestInit says `redirect: "manual"`.
 */
export const makeServicesWorld = (options: {
  readonly route: (request: SentServiceRequest) => ServiceReply;
}) => {
  const secrets = new Map<string, Uint8Array>();
  const requests: Array<SentServiceRequest> = [];

  const httpClient = HttpClient.make((request, url, _signal, fiber) => {
    const followsRedirects =
      Context.getOrUndefined(fiber.context, FetchHttpClient.RequestInit)?.redirect !== "manual";
    const body =
      request.body._tag === "Uint8Array"
        ? JSON.parse(new TextDecoder().decode(request.body.body))
        : undefined;
    const send = (target: string) => {
      const sent: SentServiceRequest = {
        method: request.method,
        url: target,
        headers: request.headers,
        body,
      };
      requests.push(sent);
      return options.route(sent);
    };
    const redirectTarget = (reply: ServiceReply, from: string) =>
      followsRedirects &&
      reply !== "unreachable" &&
      reply.status >= 300 &&
      reply.status < 400 &&
      reply.headers?.location !== undefined
        ? new URL(reply.headers.location, from).toString()
        : null;
    let current = url.toString();
    let reply = send(current);
    for (let hops = 0; hops < 5; hops++) {
      const next = redirectTarget(reply, current);
      if (next === null) break;
      current = next;
      reply = send(current);
    }
    if (reply === "unreachable") {
      return Effect.fail(
        new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request }),
        }),
      );
    }
    const replyBody =
      reply.body === undefined
        ? null
        : typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(replyBody, {
          status: reply.status,
          headers: {
            ...(typeof reply.body === "object" ? { "content-type": "application/json" } : {}),
            ...reply.headers,
          },
        }),
      ),
    );
  });

  const secretStore = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.sync(() => Option.fromUndefinedOr(secrets.get(name))),
    set: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    create: (name, value) => Effect.sync(() => void secrets.set(name, value)),
    getOrCreateRandom: () => Effect.die("not used by service connections"),
    remove: (name) => Effect.sync(() => void secrets.delete(name)),
  });

  const layer = CompanyServiceApis.layer.pipe(
    Layer.provideMerge(ServiceConnections.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provide(Layer.succeed(ServerSecretStore.ServerSecretStore, secretStore)),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, httpClient)),
  );

  return { layer, requests, secrets };
};
