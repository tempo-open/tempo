/**
 * tempo: the messages a person sent in a thread, as `t3_user_messages` returns them
 * (contracts tempoUserMessages.ts). Agents, watchers, pull request watches, scheduled tasks
 * and restarts post into a thread too; only what the person wrote counts.
 *
 * @module userMessages
 */
import type {
  TempoUserMessagesInput,
  TempoUserMessagesResult,
  OrchestrationV2ConversationMessage,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const DEFAULT_LIMIT = 50;
const DEFAULT_MAX_CHARS = 8_000;

/** One page of the person's messages, oldest first, numbered from the thread's first. */
export function selectUserMessages(
  threadId: ThreadId,
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  input: TempoUserMessagesInput,
): TempoUserMessagesResult {
  const sent = messages
    .filter((message) => message.role === "user" && message.createdBy === "user")
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(left.createdAt) - DateTime.toEpochMillis(right.createdAt),
    )
    .map((message, index) => ({ message, number: index + 1 }));
  const words = (input.query ?? "")
    .toLowerCase()
    .split(/\s+/)
    .filter((word) => word.length > 0);
  const matching =
    words.length === 0
      ? sent
      : sent.filter(({ message }) => {
          const text = message.text.toLowerCase();
          return words.every((word) => text.includes(word));
        });
  const start = input.cursor ?? 0;
  const end = start + (input.limit ?? DEFAULT_LIMIT);
  const maxChars = input.maxCharsPerMessage ?? DEFAULT_MAX_CHARS;
  return {
    threadId,
    total: sent.length,
    matches: matching.length,
    messages: matching.slice(start, end).map(({ message, number }) => ({
      number,
      messageId: message.id,
      sentAt: DateTime.formatIso(message.createdAt),
      text: message.text.slice(0, maxChars),
      textTruncated: message.text.length > maxChars,
      attachments: message.attachments.map((attachment) => attachment.name),
    })),
    nextCursor: end < matching.length ? end : null,
  };
}
