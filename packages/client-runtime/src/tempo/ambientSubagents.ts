/**
 * tempo: a provider's housekeeping tasks (Claude's `skip_transcript` ones) reach clients as
 * `ambient` subagents. Claude's SDK asks hosts to keep them out of the transcript and activity
 * indicators, so timeline rows, the agent roster, the lineage graph and the background-work banner
 * (`derivePendingBackgroundWork`) leave them out. The server still records them; Stop ends them.
 */
import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";

type Rows = OrchestrationV2ThreadProjection["visibleTurnItems"];

const isAmbientRow = (row: Rows[number]): boolean =>
  row.item.type === "subagent" && row.item.ambient === true;

/**
 * Drops ambient subagent rows. Returns the same array when there are none, and
 * the same result for the same input, so row identities stay stable.
 */
export function createAmbientSubagentRowFilter(): (rows: Rows) => Rows {
  let previousRows: Rows | undefined;
  let previousResult: Rows | undefined;
  return (rows) => {
    if (rows === previousRows && previousResult !== undefined) return previousResult;
    previousRows = rows;
    previousResult = rows.some(isAmbientRow) ? rows.filter((row) => !isAmbientRow(row)) : rows;
    return previousResult;
  };
}

/** The subagents worth listing: all of them unless some are ambient. */
export function withoutAmbientSubagents<S extends { readonly ambient?: boolean | undefined }>(
  subagents: ReadonlyArray<S>,
): ReadonlyArray<S> {
  return subagents.some((subagent) => subagent.ambient === true)
    ? subagents.filter((subagent) => subagent.ambient !== true)
    : subagents;
}

/** The child threads of ambient subagents, which lineage views leave out. */
export function ambientSubagentThreadIds(
  subagents: ReadonlyArray<{
    readonly ambient?: boolean | undefined;
    readonly childThreadId: ThreadId | null;
  }>,
): ReadonlySet<ThreadId> {
  const ids = new Set<ThreadId>();
  for (const subagent of subagents) {
    if (subagent.ambient === true && subagent.childThreadId !== null)
      ids.add(subagent.childThreadId);
  }
  return ids;
}
