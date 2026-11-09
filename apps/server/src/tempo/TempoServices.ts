/**
 * Tempo's own services for the server's layer graph. server.ts merges it into
 * `layerRuntimeDependencies` right above `layerRuntimeCoreDependencies`, so the core runtime and
 * routes can yield these and layers merged after it cannot.
 */
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CompanyServiceApis from "./CompanyServiceApis.ts";
import * as ReposVolume from "./reposVolume/ReposVolume.ts";
import * as ServiceConnections from "./ServiceConnections.ts";

export const layer = Layer.mergeAll(
  CompanyServiceApis.layer.pipe(Layer.provideMerge(ServiceConnections.layer)),
  ReposVolume.layer,
).pipe(Layer.provide(ServerSecretStore.layer));
