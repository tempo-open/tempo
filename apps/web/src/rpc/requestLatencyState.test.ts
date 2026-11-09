import { TEMPO_ACTIVITY_WS_METHODS } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  acknowledgeRpcRequest,
  subscribeSlowRpcAckRequests,
  trackRpcRequestSent,
} from "./requestLatencyState";

describe("trackRpcRequestSent", () => {
  it("warns about a slow quick activity read but not about the read that waits on GitHub", () => {
    vi.useFakeTimers();
    let slow: ReadonlyArray<string> = [];
    const unsubscribe = subscribeSlowRpcAckRequests((requests) => {
      slow = requests.map((request) => request.requestId);
    });
    try {
      const timeZone = "America/New_York";
      trackRpcRequestSent("quick", TEMPO_ACTIVITY_WS_METHODS.read, { timeZone });
      trackRpcRequestSent("refresh", TEMPO_ACTIVITY_WS_METHODS.read, {
        timeZone,
        awaitRefresh: true,
      });
      vi.advanceTimersByTime(15_000);

      expect(slow).toEqual(["quick"]);
    } finally {
      acknowledgeRpcRequest("quick");
      acknowledgeRpcRequest("refresh");
      unsubscribe();
      vi.useRealTimers();
    }
  });
});
