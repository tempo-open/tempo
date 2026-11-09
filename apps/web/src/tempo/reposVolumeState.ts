import { TEMPO_REPOS_VOLUME_WS_METHODS } from "@t3tools/contracts";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "@t3tools/client-runtime/state/runtime";

import { connectionAtomRuntime } from "../connection/runtime";

/** tempo: whether an environment has the repos volume mounted at ~/repos. */
export const reposVolumeStatus = createEnvironmentRpcQueryAtomFamily(connectionAtomRuntime, {
  label: "environment-data:tempo:repos-volume-status",
  tag: TEMPO_REPOS_VOLUME_WS_METHODS.status,
});

/** tempo: writes the setup script on the environment, for its setup terminal to run. */
export const reposVolumePrepare = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "environment-command:tempo:repos-volume-prepare",
  tag: TEMPO_REPOS_VOLUME_WS_METHODS.prepare,
});
