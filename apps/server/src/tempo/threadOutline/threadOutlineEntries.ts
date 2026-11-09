/**
 * tempo: the outline entries (tempoThreadOutline.ts) of a thread's visible timeline, from the rows
 * ProjectionStore.getThreadOutline reads. A bare `/compact` prompt shows as a compaction row,
 * not a message, so it gets no entry.
 */
import {
  TEMPO_THREAD_OUTLINE_TEXT_LIMIT,
  isCompactionCommandMessage,
  type TempoThreadOutlineEntry,
  type MessageId,
} from "@t3tools/contracts";

/** How much of a message the store reads, so collapsing its whitespace still fills an entry. */
export const THREAD_OUTLINE_READ_LIMIT = TEMPO_THREAD_OUTLINE_TEXT_LIMIT * 4;

export interface ThreadOutlineUserRow {
  readonly sourceThreadId: string;
  readonly sourceItemId: string;
  readonly item: { readonly messageId?: MessageId };
}

export interface ThreadOutlineTextRow {
  readonly thread_id: string;
  readonly turn_item_id: string;
  readonly text: string | null;
  readonly attachment_count: number | null;
  readonly created_at: string | null;
}

/** One entry per user row, in timeline order; rows without a stored message are skipped. */
export function threadOutlineEntries(
  users: ReadonlyArray<ThreadOutlineUserRow>,
  texts: ReadonlyArray<ThreadOutlineTextRow>,
): TempoThreadOutlineEntry[] {
  const byItem = new Map(texts.map((row) => [`${row.thread_id}:${row.turn_item_id}`, row]));
  return users.flatMap((user) => {
    const row = byItem.get(`${user.sourceThreadId}:${user.sourceItemId}`);
    const id = user.item.messageId;
    if (row === undefined || id === undefined || row.created_at === null) return [];
    const text = row.text ?? "";
    // Attachments make a `/compact` prompt an ordinary message.
    if ((row.attachment_count ?? 0) === 0 && isCompactionCommandMessage({ role: "user", text })) {
      return [];
    }
    return [{ id, text: outlineText(text), createdAt: row.created_at }];
  });
}

function outlineText(text: string): string {
  const compact = text.replace(/\s+/g, " ").trim();
  // By code point, so a cut never splits an emoji.
  const codePoints = Array.from(compact);
  return codePoints.length <= TEMPO_THREAD_OUTLINE_TEXT_LIMIT
    ? compact
    : codePoints.slice(0, TEMPO_THREAD_OUTLINE_TEXT_LIMIT).join("");
}
