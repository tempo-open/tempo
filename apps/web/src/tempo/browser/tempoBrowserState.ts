import { createTempoBrowserEnvironmentAtoms } from "@t3tools/client-runtime/state/tempo-browser";

import { connectionAtomRuntime } from "../../connection/runtime";

/** tempo: each environment's server browser extensions and saved passkeys, per profile. */
export const tempoBrowserEnvironment = createTempoBrowserEnvironmentAtoms(connectionAtomRuntime);
