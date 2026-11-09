import type { TempoLook } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

import {
  __resetClientSettingsPersistenceForTests,
  __setClientSettingsForTests,
} from "~/hooks/useSettings";

/** tempo: the look one test renders, saved as the settings: `using _look = withLook("classic")`. */
export function withLook(look: TempoLook): Disposable {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, tempoLook: look });
  return { [Symbol.dispose]: () => __resetClientSettingsPersistenceForTests() };
}
