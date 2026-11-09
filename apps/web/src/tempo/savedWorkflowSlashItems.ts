import {
  savedWorkflowCommandRows,
  savedWorkflowRowPrompt,
} from "@t3tools/client-runtime/tempo/claude-workflows";
import type { TempoClaudeSavedWorkflow, ProviderDriverKind } from "@t3tools/contracts";

import type { ComposerCommandItem } from "../components/chat/ComposerCommandMenu";

/** Saved Claude workflows as `/workflow:<name>` rows of the composer's provider commands. */
export function savedWorkflowSlashItems(
  provider: ProviderDriverKind,
  workflows: ReadonlyArray<TempoClaudeSavedWorkflow>,
): Array<Extract<ComposerCommandItem, { type: "provider-slash-command" }>> {
  return savedWorkflowCommandRows(workflows).map((row) => ({
    ...row,
    type: "provider-slash-command" as const,
    provider,
  }));
}

/** The prompt a saved-workflow row inserts, or null for a real provider command. */
export const savedWorkflowSlashPrompt = savedWorkflowRowPrompt;
