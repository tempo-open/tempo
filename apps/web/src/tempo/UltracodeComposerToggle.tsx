import {
  claudeWorkflowInstanceSettings,
  resolveUltracodeToggle,
  type ClaudeWorkflowInstanceSettings,
  shouldShowUltracodeKeywordHint,
  toggleUltracodeOptions,
} from "@t3tools/client-runtime/tempo/claude-workflows";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ServerProviderModel,
} from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { WorkflowIcon } from "lucide-react";
import { useEffect } from "react";

import { type ComposerThreadTarget, useComposerDraftStore } from "../composerDraftStore";
import {
  ComposerControl,
  ComposerControlIcon,
  type ComposerControlSize,
} from "../components/chat/ComposerControl";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useStableCallback } from "../hooks/useStableCallback";
import { getProviderModelCapabilities } from "../providerModels";
import { subscribeUltracodeToggle } from "./ultracodeToggleBus";

/** The Claude instance's workflow switches from the settings the composer already holds. */
export function claudeWorkflowSettingsFor(
  providerInstances: Readonly<Record<string, { readonly config?: unknown }>> | undefined,
  instanceId: ProviderInstanceId | undefined,
): ClaudeWorkflowInstanceSettings {
  return claudeWorkflowInstanceSettings(
    instanceId === undefined ? undefined : providerInstances?.[instanceId]?.config,
  );
}

/**
 * The composer's Ultracode toggle for Claude models that support it. It sits
 * beside the effort picker and leaves the effort alone; the server applies it
 * to a running Claude process without restarting it.
 */
export function UltracodeComposerToggle(props: {
  readonly provider: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId | undefined;
  readonly model: string | null | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly target: ComposerThreadTarget | null;
  readonly prompt: string;
  readonly workflowSettings: ClaudeWorkflowInstanceSettings;
  readonly size?: ComposerControlSize;
}) {
  const { provider, instanceId, model, models, modelOptions, target } = props;
  const toggle = resolveUltracodeToggle({
    descriptors: getProviderOptionDescriptors({
      caps: getProviderModelCapabilities(models, model, provider),
      selections: modelOptions,
    }),
    options: modelOptions,
  });
  // Ultracode runs as a workflow, so it goes when workflows are off.
  const available = toggle.available && props.workflowSettings.workflowsEnabled && target !== null;
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  // Stable, so the subscription below only changes with `available`.
  const flip = useStableCallback(() => {
    if (!available || target === null) return;
    // Not sticky: a new thread starts without ultracode, which costs more.
    setProviderModelOptions(target, provider, toggleUltracodeOptions(modelOptions), {
      ...(instanceId === undefined ? {} : { instanceId }),
      model,
      persistSticky: false,
    });
  });

  // The keybinding and the command palette reach the one mounted composer.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes this toggle to the ultracode toggle bus while it is available
  useEffect(() => (available ? subscribeUltracodeToggle(flip) : undefined), [available, flip]);

  if (!available) return null;
  const size = props.size ?? "sm";
  const keywordHint = shouldShowUltracodeKeywordHint({
    prompt: props.prompt,
    toggle,
    keywordTriggerEnabled: props.workflowSettings.keywordTriggerEnabled,
  });
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              size={size}
              aria-pressed={toggle.enabled}
              aria-label={toggle.enabled ? "Ultracode on" : "Ultracode off"}
              data-composer-shortcut="composer.ultracode"
              onClick={flip}
            />
          }
        >
          <ComposerControlIcon icon={WorkflowIcon} size={size} />
          <span className="max-sm:sr-only">Ultracode</span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-64">
          {toggle.enabled
            ? "Ultracode is on: Claude plans each turn as a multi-agent workflow at extra-high effort. It uses many more tokens."
            : "Turn on ultracode to have Claude plan each turn as a multi-agent workflow."}
        </TooltipPopup>
      </Tooltip>
      {keywordHint ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                className="shrink-0 text-warning text-xs"
                data-testid="ultracode-keyword-hint"
              />
            }
          >
            Runs as a workflow
          </TooltipTrigger>
          <TooltipPopup side="top" className="max-w-64">
            This message says "ultracode", so Claude will run this turn as a multi-agent workflow.
            Turn the keyword off in Settings, Providers, Claude.
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
