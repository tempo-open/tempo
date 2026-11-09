import {
  TEMPO_CLAUDE_ULTRACODE_OPTION_ID,
  isTempoClaudeUltracodeSelected,
  type ModelSelection,
} from "@t3tools/contracts";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
  getProviderOptionDescriptors,
  resolvePromptInjectedEffort,
} from "@t3tools/shared/model";

import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  getClaudeCatalogModelCapabilities,
  isClaudeCatalogUltracodeEffort,
  normalizeClaudeCatalogEffort,
  resolveClaudeCatalogApiModelId,
  resolveClaudeCatalogEffort,
  type ClaudeModelCatalog,
} from "./provider/ClaudeModelCatalog.ts";

export interface CompiledClaudeModelSelection {
  readonly apiModelId: string;
  readonly effort: string | undefined;
  readonly promptEffort: string | undefined;
  readonly settings: Readonly<Record<string, boolean>>;
  readonly ultracode: boolean;
  readonly queryIdentity: string;
}

export function compileClaudeModelSelection(
  selection: ModelSelection,
  catalog: ClaudeModelCatalog = BUNDLED_CLAUDE_MODEL_CATALOG,
): CompiledClaudeModelSelection {
  const capabilities = getClaudeCatalogModelCapabilities(catalog, selection.model);
  const descriptors = getProviderOptionDescriptors({ caps: capabilities });
  const supportsBoolean = (id: string) =>
    descriptors.some((descriptor) => descriptor.type === "boolean" && descriptor.id === id);
  const rawEffort = getModelSelectionStringOptionValue(selection, "effort");
  // Tempo: ultracode is a toggle on the models that offered it as an effort; a
  // saved legacy "ultracode" effort there keeps its xhigh.
  const supportsUltracode = supportsBoolean(TEMPO_CLAUDE_ULTRACODE_OPTION_ID);
  const legacyUltracodeEffort = supportsUltracode && isClaudeCatalogUltracodeEffort(rawEffort);
  const resolvedEffort = legacyUltracodeEffort
    ? rawEffort
    : resolveClaudeCatalogEffort(catalog, selection.model, rawEffort);
  const normalizedEffort = normalizeClaudeCatalogEffort(catalog, resolvedEffort, selection.model);
  // "ultracode" is never an SDK effort level.
  const effort = isClaudeCatalogUltracodeEffort(normalizedEffort) ? undefined : normalizedEffort;
  const ultracode = supportsUltracode && isTempoClaudeUltracodeSelected(selection.options);
  const fastMode = supportsBoolean("fastMode")
    ? (getModelSelectionBooleanOptionValue(selection, "fastMode") ?? false)
    : undefined;
  const thinking = supportsBoolean("thinking")
    ? getModelSelectionBooleanOptionValue(selection, "thinking")
    : undefined;
  const settings = {
    ...(typeof thinking === "boolean" ? { alwaysThinkingEnabled: thinking } : {}),
    ...(typeof fastMode === "boolean" ? { fastMode } : {}),
    ...(ultracode ? { ultracode: true } : {}),
  };
  const apiModelId = resolveClaudeCatalogApiModelId(catalog, selection);
  const promptEffort = resolvePromptInjectedEffort(capabilities, rawEffort) ?? undefined;
  // Ultracode is applied to a live process with applyFlagSettings, so toggling
  // it must not count as a new selection that replaces the process.
  const { ultracode: _ultracode, ...identitySettings } = settings;
  return {
    apiModelId,
    effort,
    promptEffort,
    settings,
    ultracode,
    queryIdentity: JSON.stringify({
      apiModelId,
      effort: effort ?? null,
      settings: identitySettings,
    }),
  };
}
