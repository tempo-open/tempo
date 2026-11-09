import { DEFAULT_REASONING_EFFORT, type ServerProviderModel } from "@t3tools/contracts";

/** Tempo: High where a model offers it, otherwise the model's own default. */
export function startingReasoningEffort(
  offered: ReadonlyArray<string>,
  modelDefault: string | null | undefined,
): string | null | undefined {
  return offered.includes(DEFAULT_REASONING_EFFORT) ? DEFAULT_REASONING_EFFORT : modelDefault;
}

/**
 * Tempo: a model whose reasoning select offers High starts there, in place of the
 * catalog's own default (Medium for Claude). A model without High keeps its default.
 */
export function withDefaultReasoningEffort(
  model: ServerProviderModel,
  descriptorId = "effort",
): ServerProviderModel {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const effort = descriptors.find(
    (descriptor) => descriptor.id === descriptorId && descriptor.type === "select",
  );
  if (
    effort?.type !== "select" ||
    !effort.options.some((option) => option.id === DEFAULT_REASONING_EFFORT)
  ) {
    return model;
  }
  const options = effort.options.map(({ isDefault: _isDefault, ...option }) =>
    option.id === DEFAULT_REASONING_EFFORT ? { ...option, isDefault: true } : option,
  );
  return {
    ...model,
    capabilities: {
      ...model.capabilities,
      optionDescriptors: descriptors.map((descriptor) =>
        descriptor === effort ? { ...effort, options } : descriptor,
      ),
    },
  };
}
