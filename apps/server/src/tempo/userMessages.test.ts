import { MessageId, type OrchestrationV2ConversationMessage, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "@effect/vitest";

import { selectUserMessages } from "./userMessages.ts";

const THREAD = ThreadId.make("thread-1");

const message = (
  id: string,
  minute: number,
  text: string,
  overrides: Partial<OrchestrationV2ConversationMessage> = {},
): OrchestrationV2ConversationMessage => {
  const at = DateTime.makeUnsafe(Date.UTC(2026, 9, 23, 7, minute));
  return {
    id: MessageId.make(id),
    threadId: THREAD,
    runId: null,
    nodeId: null,
    role: "user",
    text,
    attachments: [],
    streaming: false,
    createdAt: at,
    updatedAt: at,
    createdBy: "user",
    creationSource: "web",
    ...overrides,
  };
};

// Stored out of order, with an agent's message, a watcher's wake and a reply mixed in.
const MESSAGES = [
  message("m3", 30, "Also update the docs", {
    attachments: [
      { type: "image", id: "a1", name: "banner.png", mimeType: "image/png", sizeBytes: 10 },
    ],
  }),
  message("m1", 10, "Rename the settings tab"),
  message("agent", 15, "Please review #9051", { createdBy: "agent", creationSource: "mcp" }),
  message("wake", 20, "Pull request #9051 merged", {
    createdBy: "system",
    creationSource: "server",
  }),
  message("reply", 25, "Done.", {
    role: "assistant",
    createdBy: "agent",
    creationSource: "provider",
  }),
  message("m2", 40, "And keep the save button on the right"),
];

describe("selectUserMessages", () => {
  it("returns only what the person wrote, oldest first and numbered", () => {
    const result = selectUserMessages(THREAD, MESSAGES, {});
    expect(result).toMatchObject({ threadId: THREAD, total: 3, matches: 3, nextCursor: null });
    expect(result.messages.map(({ number, text }) => [number, text])).toEqual([
      [1, "Rename the settings tab"],
      [2, "Also update the docs"],
      [3, "And keep the save button on the right"],
    ]);
    expect(result.messages[1]).toMatchObject({
      messageId: "m3",
      sentAt: "2026-10-23T07:30:00.000Z",
      attachments: ["banner.png"],
    });
  });

  it("keeps the messages with every word of the query, whatever their case", () => {
    const result = selectUserMessages(THREAD, MESSAGES, { query: "SAVE  button" });
    expect(result.total).toBe(3);
    expect(result.matches).toBe(1);
    expect(result.messages.map(({ number }) => number)).toEqual([3]);
  });

  it("pages with a cursor and marks cut texts", () => {
    const first = selectUserMessages(THREAD, MESSAGES, { limit: 2, maxCharsPerMessage: 200 });
    expect(first.messages.map(({ number }) => number)).toEqual([1, 2]);
    expect(first.nextCursor).toBe(2);
    const rest = selectUserMessages(THREAD, MESSAGES, { limit: 2, cursor: first.nextCursor ?? 0 });
    expect(rest.messages.map(({ number }) => number)).toEqual([3]);
    expect(rest.nextCursor).toBeNull();

    const long = selectUserMessages(THREAD, [message("long", 1, "x".repeat(300))], {
      maxCharsPerMessage: 200,
    });
    expect(long.messages[0]?.text).toHaveLength(200);
    expect(long.messages[0]?.textTruncated).toBe(true);
  });
});
