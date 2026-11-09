/**
 * tempo: the person's own messages in a thread, so an agent can check it did everything they
 * asked (`tempo/userMessages.ts`). It calls `OrchestratorMcpService.readUserMessages`.
 */
import {
  TempoUserMessagesInput,
  TempoUserMessagesResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";

const UserMessagesTool = Tool.make("t3_user_messages", {
  description:
    "List or search the messages the user sent in this thread, oldest first, in full. In a long thread, or after the conversation was compacted or summarized, reread them before you report work as done and check that each request is handled. Omit threadId for this thread. query keeps the messages that contain every one of its words, ignoring case. Messages from agents, watchers, pull request watches, scheduled tasks and restarts are left out. number counts from the user's first message in the thread. Continue with cursor=nextCursor; texts longer than maxCharsPerMessage (default 8000) are cut, and textTruncated says so.",
  parameters: TempoUserMessagesInput,
  success: TempoUserMessagesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    OrchestratorMcpService.OrchestratorMcpService,
  ],
})
  .annotate(Tool.Title, "Read the user's messages")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const TempoUserMessagesToolkit = Toolkit.make(UserMessagesTool);
