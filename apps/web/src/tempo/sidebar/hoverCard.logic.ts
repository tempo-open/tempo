import { formatModelSelectionEffort } from "@t3tools/client-runtime/state/thread-execution";
import type { ModelSelection } from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";

import { getTriggerDisplayModelName } from "../../components/chat/providerIconUtils";
import type { ProviderInstanceEntry } from "../../providerInstances";

/**
 * The hover card's Model line as the composer words it, "Opus 5.5 Max". Providers report dated ids
 * and aliases ("claude-haiku-4-5-20251001"), so the slug resolves through the catalog first.
 */
export function hoverCardModelLabel(
  entry: Pick<ProviderInstanceEntry, "driverKind" | "models">,
  selection: ModelSelection,
): string {
  const slug = resolveSelectableModel(entry.driverKind, selection.model, entry.models);
  const model = entry.models.find((candidate) => candidate.slug === slug);
  if (!model) return formatModelSlugName(selection.model);
  const name = getTriggerDisplayModelName(model, entry.driverKind);
  const effort = formatModelSelectionEffort({ ...selection, model: model.slug }, entry.models);
  return effort ? `${name} ${effort}` : name;
}
