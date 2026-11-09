import { createTempoServicesEnvironmentAtoms } from "@t3tools/client-runtime/state/tempo-services";

import { connectionAtomRuntime } from "../connection/runtime";

/** tempo: each environment's service connections. */
export const tempoServicesEnvironment = createTempoServicesEnvironmentAtoms(connectionAtomRuntime);
