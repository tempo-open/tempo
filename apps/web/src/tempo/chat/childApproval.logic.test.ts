import { EnvironmentId, RuntimeRequestId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { childApprovalResponse, inlineChildApprovalThread } from "./childApproval.logic";

const environmentId = EnvironmentId.make("environment");
const child = (id: string, hasPendingApprovals: boolean) => ({
  environmentId,
  id: ThreadId.make(id),
  hasPendingApprovals,
});

describe("inlineChildApprovalThread", () => {
  it("takes the first child asking for approval and leaves questions to the banner", () => {
    const question = child("question", false);
    const approval = child("approval", true);
    expect(inlineChildApprovalThread([question, approval, child("later", true)])).toBe(approval);
    expect(inlineChildApprovalThread([question])).toBeNull();
  });
});

describe("childApprovalResponse", () => {
  it("answers the sub chat that asked", () => {
    const requestId = RuntimeRequestId.make("request");
    expect(
      childApprovalResponse(
        { environmentId, threadId: ThreadId.make("sub-chat") },
        requestId,
        "accept",
      ),
    ).toEqual({
      environmentId,
      input: { threadId: ThreadId.make("sub-chat"), requestId, decision: "accept" },
    });
  });
});
