import { TEMPO_T3_IMPORT_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

/**
 * tempo: what importing an environment's T3 Code would bring. Read only when the
 * user asks, and dropped once nothing shows it, so every scan is a fresh read.
 */
export const t3ImportScan = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:tempo:t3-import-scan",
  tag: TEMPO_T3_IMPORT_WS_METHODS.scan,
  idleTtlMs: 0,
});

/** tempo: copies the environment's T3 Code threads into Tempo, then rescans with the same input. */
export const t3ImportRun = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:tempo:t3-import-run",
  tag: TEMPO_T3_IMPORT_WS_METHODS.run,
  onSettled: (target, registry) => Effect.sync(() => registry.refresh(t3ImportScan(target))),
});
