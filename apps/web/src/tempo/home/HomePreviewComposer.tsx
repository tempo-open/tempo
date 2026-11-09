import { resolveUltracodeToggle } from "@t3tools/client-runtime/tempo/claude-workflows";
import { pickNewWorkProject } from "@t3tools/client-runtime/tempo/new-work-environment";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  getDescriptorStringValue,
  REASONING_SELECT_DESCRIPTOR_IDS,
} from "@t3tools/client-runtime/model-traits";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/models";
import { ProviderDriverKind, type ProviderOptionDescriptor } from "@t3tools/contracts";
import { getProviderOptionDescriptors } from "@t3tools/shared/model";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { ArrowUpIcon, ChevronDownIcon, GitBranchIcon, PlusIcon, WorkflowIcon } from "lucide-react";
import { useShallow } from "zustand/react/shallow";

import { resolveBranchToolbarValue, resolveEnvModeLabel } from "~/components/BranchToolbar.logic";
import { ComposerContextLabel } from "~/components/ComposerContextLabel";
import { ProjectFavicon } from "~/components/ProjectFavicon";
import { sortScopedProjectsForSidebar } from "~/components/Sidebar.logic";
import { ComposerControl, ComposerControlIcon } from "~/components/chat/ComposerControl";
import { ComposerSurface } from "~/components/chat/ComposerSurface";
import { DraftProjectName } from "~/components/chat/DraftProjectName";
import { EffortGlyph, resolveEffortGlyph } from "~/components/chat/EffortGlyph";
import { getTriggerDisplayModelName } from "~/components/chat/providerIconUtils";
import { runtimeModeConfig } from "~/components/chat/runtimeModeConfig";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useEnvironmentSettings } from "~/hooks/useSettings";
import { getProviderModelCapabilities } from "~/providerModels";
import {
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "~/providerInstances";
import { useProjects } from "~/state/entities";
import { useEnvironmentProviders } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { claudeWorkflowSettingsFor } from "../UltracodeComposerToggle";
import { useNewWorkEnvironmentId } from "../newWorkEnvironment";
import { useQuietThreadShells } from "../quietThreadShells";
import chatGptLogoUrl from "../threadLogos/logos/chatgpt.png";
import claudeLogoUrl from "../threadLogos/logos/claude.png";

/** The composer names the model beside its app's logo (ProviderModelPicker). */
const APP_LOGO_URL: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("claudeAgent")]: claudeLogoUrl,
  [ProviderDriverKind.make("codex")]: chatGptLogoUrl,
};

type SelectDescriptor = Extract<ProviderOptionDescriptor, { type: "select" }>;

/** The project a new thread opens in: the home's own pick (routes/_chat.index.tsx). */
function useHomeProject(): EnvironmentProject | null {
  const projects = useProjects();
  const threads = useQuietThreadShells();
  const newWorkEnvironmentId = useNewWorkEnvironmentId();
  return pickNewWorkProject(
    sortScopedProjectsForSidebar(projects, threads, "updated_at"),
    newWorkEnvironmentId,
  );
}

/** The model, effort and Ultracode the project's next thread starts with, as the composer names them. */
function PreviewModelControls({ project }: { readonly project: EnvironmentProject }) {
  const settings = useEnvironmentSettings(project.environmentId);
  const providers = useEnvironmentProviders().get(project.environmentId) ?? [];
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  // The project's open draft holds the model its home shows; else a new thread's order of choice
  // (useHandleNewThread): the project's default, the last model used, the provider's default.
  const draftSelection = useComposerDraftStore((store) => {
    const session = store.getDraftSessionByProjectRef(projectRef);
    const draft = session === null ? null : store.getComposerDraft(session.draftId);
    const provider = draft?.activeProvider;
    return provider ? (draft?.modelSelectionByProvider[provider] ?? null) : null;
  });
  const stickySelection = useComposerDraftStore((store) =>
    store.stickyActiveProvider === null
      ? null
      : (store.stickyModelSelectionByProvider[store.stickyActiveProvider] ?? null),
  );
  const selection =
    draftSelection ??
    resolveProjectSettings(settings, project.id, project).settings.defaultModelSelection ??
    stickySelection ??
    resolveProjectDefaultProviderModelSelection(providers, settings, project.id);
  const entry = providerInstanceEntriesFor(providers, settings, project.id).find(
    (candidate) => candidate.instanceId === selection?.instanceId,
  );
  if (selection === null || entry === undefined) return null;
  const model = entry.models.find((candidate) => candidate.slug === selection.model);
  const descriptors = getProviderOptionDescriptors({
    caps: getProviderModelCapabilities(
      entry.models,
      selection.model,
      entry.driverKind,
      settings.planModeEnabled,
    ),
    selections: selection.options,
  });
  const effortDescriptor = descriptors.find(
    (descriptor): descriptor is SelectDescriptor => descriptor.type === "select",
  );
  const effort =
    effortDescriptor && REASONING_SELECT_DESCRIPTOR_IDS.has(effortDescriptor.id)
      ? resolveEffortGlyph(effortDescriptor, getDescriptorStringValue(effortDescriptor, selection))
      : null;
  const ultracode = resolveUltracodeToggle({ descriptors, options: selection.options });
  const workflows = claudeWorkflowSettingsFor(settings.providerInstances, entry.instanceId);
  const logo = APP_LOGO_URL[entry.driverKind];
  return (
    <>
      <ComposerControl size="sm" className="min-w-13 shrink justify-between pe-1 whitespace-nowrap">
        <span className="flex min-w-0 flex-1 items-center gap-1.5">
          {logo ? (
            <span className="inline-flex size-4 shrink-0 items-center justify-center">
              <img src={logo} alt="" className="size-3.75 rounded-sm object-cover" />
            </span>
          ) : null}
          <span className="min-w-0 flex-1 truncate" data-chat-provider-model-picker-label="">
            {model ? getTriggerDisplayModelName(model, entry.driverKind) : selection.model}
          </span>
        </span>
      </ComposerControl>
      <div className="flex w-max min-w-max shrink-0 items-center gap-1">
        {effort ? (
          <ComposerControl
            size="sm"
            data-composer-shortcut="composer.effort"
            className="-ms-1 ps-0 pe-1 text-muted-foreground"
          >
            {effort.special === null && settings.effortDisplay === "bars" ? (
              <EffortGlyph count={effort.count} filled={effort.filled} />
            ) : (
              <span data-composer-control-label="">{effort.special ?? effort.label}</span>
            )}
          </ComposerControl>
        ) : null}
        {ultracode.available && workflows.workflowsEnabled ? (
          <ComposerControl
            size="sm"
            aria-pressed={ultracode.enabled}
            data-composer-shortcut="composer.ultracode"
          >
            <ComposerControlIcon icon={WorkflowIcon} />
            <span>Ultracode</span>
          </ComposerControl>
        ) : null}
      </div>
    </>
  );
}

/** The strip under the card: the branch, the checkout and the permissions the thread starts with. */
function PreviewContextStrip({ project }: { readonly project: EnvironmentProject }) {
  const settings = useEnvironmentSettings(project.environmentId);
  const projectRef = scopeProjectRef(project.environmentId, project.id);
  const draft = useComposerDraftStore(
    useShallow((store) => {
      const session = store.getDraftSessionByProjectRef(projectRef);
      return {
        branch: session?.branch ?? null,
        worktreePath: session?.worktreePath ?? null,
        envMode: session?.envMode ?? null,
        runtimeMode: session === null ? null : store.getComposerDraft(session.draftId)?.runtimeMode,
      };
    }),
  );
  const projectSettings = resolveProjectSettings(settings, project.id).settings;
  const envMode = draft.envMode ?? projectSettings.defaultThreadEnvMode ?? "local";
  const status = useEnvironmentQuery(
    vcsEnvironment.status({
      environmentId: project.environmentId,
      input: { cwd: draft.worktreePath ?? project.workspaceRoot },
    }),
  );
  const branch = resolveBranchToolbarValue({
    envMode,
    activeWorktreePath: draft.worktreePath,
    activeThreadBranch: draft.branch,
    currentGitBranch: status.data?.refName ?? null,
  });
  const access = runtimeModeConfig[draft.runtimeMode ?? projectSettings.defaultRuntimeMode];
  return (
    <ComposerSurface.ContextStrip className="gap-1 text-xs font-normal text-muted-foreground">
      {branch === null ? null : (
        <div className="flex min-w-0 items-center gap-1" data-composer-branch="">
          <span className="flex min-w-0">
            <ComposerControl size="xs" className="min-w-0 max-w-full">
              <GitBranchIcon className="size-3 shrink-0" />
              <ComposerContextLabel>{branch}</ComposerContextLabel>
            </ComposerControl>
          </span>
        </div>
      )}
      <div className="flex min-h-6 flex-1 items-center gap-1">
        <ComposerControl size="xs" data-composer-context-control="">
          <ComposerContextLabel>
            {draft.worktreePath ? "Current worktree" : resolveEnvModeLabel(envMode)}
          </ComposerContextLabel>
        </ComposerControl>
      </div>
      <ComposerControl size="xs" className="ms-auto" data-composer-context-control="">
        <access.icon />
        <ComposerContextLabel>{access.label}</ComposerContextLabel>
      </ComposerControl>
    </ComposerSurface.ContextStrip>
  );
}

/**
 * The typing bar as the home shows it, in the Appearance preview: the card with its placeholder,
 * the project, model, effort and Ultracode a new thread starts with, and the strip under it.
 * Drawn from the same drafts and settings as the real one, which is not mounted twice.
 */
export function HomePreviewComposer() {
  const project = useHomeProject();
  return (
    <ComposerSurface.Shell contextRow={project !== null}>
      <ComposerSurface.Host>
        <ComposerSurface.Main>
          <div data-chat-composer-surface="true" className="rounded-2xl">
            <div data-chat-composer-body="true" className="relative px-4 pt-4 pb-2">
              <div
                data-composer-prompt=""
                className="relative flow-root font-(family-name:--font-composer,var(--font-sans)) text-(length:--font-size-prompt,var(--text-sm))"
              >
                <div className="composer-tiptap -m-1 block p-1 leading-relaxed text-placeholder">
                  Ask anything
                </div>
              </div>
            </div>
            <div data-chat-composer-footer="true" className="flex min-w-0 items-center px-2 pb-2">
              <div className="me-2" data-chat-composer-attach="true">
                <ComposerControl size="sm" aria-label="Attach files">
                  <PlusIcon />
                </ComposerControl>
              </div>
              <div
                data-chat-composer-actions="right"
                className="flex min-w-0 flex-1 items-center justify-end gap-2"
              >
                {project === null ? null : (
                  <div className="me-auto flex min-w-0">
                    <span data-tempo-home-project="" className="flex items-center">
                      <ProjectFavicon project={project} className="size-3.5 shrink-0" />
                      <DraftProjectName value={project.title} singleLine />
                      <ChevronDownIcon aria-hidden />
                    </span>
                  </div>
                )}
                <div
                  data-chat-composer-footer-controls="true"
                  className="relative flex min-w-0 flex-1 items-center justify-end gap-0.5"
                >
                  {project === null ? null : <PreviewModelControls project={project} />}
                </div>
                <span className="flex size-7.5 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground">
                  <ArrowUpIcon className="size-4" />
                </span>
              </div>
            </div>
          </div>
        </ComposerSurface.Main>
      </ComposerSurface.Host>
      {project === null ? null : <PreviewContextStrip project={project} />}
    </ComposerSurface.Shell>
  );
}
