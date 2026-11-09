import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";

import { useAtomCommand } from "../../state/use-atom-command";
import { tempoBrowserEnvironment } from "./tempoBrowserState";

/**
 * tempo: deletes a removed browser profile's extensions and saved passkeys from
 * every environment with a server browser. Rejects if any environment fails,
 * so the profile stays listed and the removal can be tried again.
 */
export function useForgetTempoBrowserProfile() {
  const forget = useAtomCommand(tempoBrowserEnvironment.forgetProfile, { reportFailure: false });
  return async (environmentIds: ReadonlyArray<EnvironmentId>, profileId: string) => {
    await Promise.all(
      environmentIds.map(async (environmentId) => {
        const result = await forget({ environmentId, input: { profileId } });
        if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      }),
    );
  };
}
