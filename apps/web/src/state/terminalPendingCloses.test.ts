import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addTerminalPendingClose,
  removeTerminalPendingClose,
  terminalPendingCloseKey,
  useTerminalPendingCloses,
} from "./terminalPendingCloses";

describe("terminal pending closes", () => {
  it("tracks a terminal by its thread until the Undo window is over", () => {
    const key = terminalPendingCloseKey(
      EnvironmentId.make("env"),
      ThreadId.make("thread"),
      "term-1",
    );
    addTerminalPendingClose(key);
    expect(useTerminalPendingCloses.getState().keys.has(key)).toBe(true);
    expect(
      useTerminalPendingCloses
        .getState()
        .keys.has(
          terminalPendingCloseKey(EnvironmentId.make("env"), ThreadId.make("other"), "term-1"),
        ),
    ).toBe(false);
    removeTerminalPendingClose(key);
    expect(useTerminalPendingCloses.getState().keys.size).toBe(0);
  });
});
