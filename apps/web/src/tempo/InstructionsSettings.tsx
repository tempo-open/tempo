import { useAtomValue } from "@effect/atom-react";
import {
  type AgentFileSkipped,
  type AgentFileSkipReason,
  type EnvironmentId,
  type InstructionFileEntry,
  type ProjectId,
  type InstructionFileGroup,
  InstructionFileError,
  type InstructionProvider,
  type PersonalInstructionsState,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import * as Schema from "effect/Schema";
import { ArrowLeftIcon, FileTextIcon } from "lucide-react";
import { useState } from "react";

import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";
import { APP_BASE_NAME } from "../branding";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { Switch } from "../components/ui/switch";
import {
  type EnvironmentPresentation,
  useEnvironment,
  usePrimaryEnvironment,
} from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import {
  tempoAgentFilesEnvironment,
  tempoInstructionFilesEnvironment,
} from "./instructionFilesState";
import { useNewWorkEnvironmentId } from "./newWorkEnvironment";

const PROVIDER_LABELS: Record<InstructionProvider, string> = { claude: "Claude", codex: "Codex" };

const isInstructionFileError = Schema.is(InstructionFileError);

/**
 * Settings → Instructions: every CLAUDE.md, AGENTS.md, rule, and auto memory
 * file the selected environment's Claude and Codex sessions load, with an editor.
 * Files live on that environment's machine, so a Mac mini shows its own. A
 * project scope narrows the list to that project (global files stay).
 */
export function InstructionsSettings() {
  const { environment, scope, target } = useSettingsScope();
  if (!environment) {
    return (
      <SettingsPageContainer>
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <FileTextIcon />
            </EmptyMedia>
            <EmptyTitle>No environment selected</EmptyTitle>
            <EmptyDescription>
              {scope.kind === "unavailable"
                ? scope.message
                : "Connect an environment to see the instructions its agents load."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </SettingsPageContainer>
    );
  }
  const projectId =
    scope.kind === "project" || scope.kind === "checkout" ? (target?.projectId ?? null) : null;
  return (
    <EnvironmentInstructions
      key={`${environment.environmentId}:${projectId ?? ""}`}
      environment={environment}
      projectId={projectId}
    />
  );
}

interface OpenFile {
  readonly path: string;
  readonly displayPath: string;
  readonly create: boolean;
  /** The file that imports this one, when it was opened through an import. */
  readonly via?: string;
}

function EnvironmentInstructions({
  environment,
  projectId,
}: {
  readonly environment: EnvironmentPresentation;
  readonly projectId: ProjectId | null;
}) {
  const { environmentId } = environment;
  const connected =
    environment.connection.phase === "connected" && environment.serverConfig !== null;
  const supported =
    environment.serverConfig?.environment.capabilities.tempoInstructionFiles === true;
  const listAtom =
    connected && supported
      ? tempoInstructionFilesEnvironment.list({
          environmentId,
          input: projectId === null ? {} : { projectId },
        })
      : null;
  const listQuery = useEnvironmentQuery(listAtom);
  const canWrite = useAtomValue(
    tempoInstructionFilesEnvironment.write.permissionAtom(environmentId),
  );
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "update instructions setting",
  );
  const [togglingPersonal, setTogglingPersonal] = useState(false);
  // Opened files, newest last: following an import pushes, Back pops.
  const [openFiles, setOpenFiles] = useState<ReadonlyArray<OpenFile>>([]);
  const data = listQuery.data;
  const open = openFiles.at(-1);
  // The setting only matters where Tempo runs a provider from its own home.
  const managesHomes =
    data?.groups.some(
      (group) => group.personal !== undefined && group.personal.state !== "direct",
    ) === true;

  const setUsePersonal = async (enabled: boolean) => {
    setTogglingPersonal(true);
    await updateSettings({
      environmentId,
      input: { patch: { tempoUsePersonalInstructions: enabled } },
    }).finally(() => setTogglingPersonal(false));
    listQuery.refresh();
  };

  return (
    <SettingsPageContainer>
      <SettingsSection
        title={`Instructions · ${environment.label}`}
        id={searchableSetting("instructions").id}
      >
        {managesHomes ? (
          <SettingsRow
            id={searchableSetting("instructions-personal").id}
            title="Use my personal instructions"
            description={`${APP_BASE_NAME} runs Claude and Codex from its own homes on this environment. Also load your own ~/.claude/CLAUDE.md and rules, and ~/.codex/AGENTS.md, there. Your settings and credentials are never shared.`}
            control={
              <Switch
                aria-label="Use my personal instructions"
                checked={data?.usePersonalInstructions ?? true}
                disabled={!canWrite || togglingPersonal}
                onCheckedChange={(enabled) => void setUsePersonal(enabled)}
              />
            }
          />
        ) : data?.groups.some((group) => group.personal?.state === "direct") ? (
          <SettingsRow
            id={searchableSetting("instructions-personal").id}
            title="Your personal instructions"
            description="Claude and Codex here use your own ~/.claude and ~/.codex, so your personal instructions always load."
          />
        ) : null}
        <AgentFilesSyncRow
          environmentId={environmentId}
          onSynced={(hostId) => {
            if (hostId === environmentId) listQuery.refresh();
          }}
        />
        <SettingsRow
          title="When edits apply"
          description="Claude and Codex read these files when a session starts, so edits apply to new sessions. Threads in a worktree read that checkout's copy of committed files."
        />
        {!connected ? (
          <SettingsRow title={`Reconnect ${environment.label} to see its instruction files.`} />
        ) : !supported ? (
          <SettingsRow
            title="Update this environment"
            description={`${environment.label} runs a server that does not list instruction files yet.`}
          />
        ) : listQuery.error && data === null ? (
          <SettingsRow title="Could not list instruction files" description={listQuery.error} />
        ) : data === null ? (
          <SettingsRow title="Looking for instruction files…" />
        ) : null}
      </SettingsSection>
      {data?.groups.map((group) => (
        <InstructionGroupSection
          key={group.id}
          group={group}
          canWrite={canWrite}
          usePersonal={data.usePersonalInstructions}
          onOpen={(file) => setOpenFiles([file])}
        />
      ))}
      {open ? (
        <InstructionFileSheet
          // Each file gets a fresh editor; the sheet asks before dropping unsaved edits.
          key={`${openFiles.length}:${open.path}`}
          environmentId={environmentId}
          file={open}
          previous={openFiles.at(-2)}
          canWrite={canWrite}
          onOpen={(file) => setOpenFiles((files) => [...files, file])}
          onBack={() => setOpenFiles((files) => files.slice(0, -1))}
          onClose={() => setOpenFiles([])}
        />
      ) : null}
    </SettingsPageContainer>
  );
}

/** Whether an environment can take part in a sync right now. */
const syncsAgentFiles = (
  environment: EnvironmentPresentation | null,
): environment is EnvironmentPresentation =>
  environment !== null &&
  environment.connection.phase === "connected" &&
  environment.serverConfig?.environment.capabilities.tempoAgentFiles === true;

/** Follows a count: "3 symlinks", or alone when every skipped file has that reason. */
const SKIP_REASON_LABELS: Record<AgentFileSkipReason, (count: number) => string> = {
  symlink: (count) => (count === 1 ? "symlink" : "symlinks"),
  "too-large": () => "over 1 MB",
  "total-limit": () => "past the 20 MB limit",
  "ignored-folder": (count) =>
    count === 1 ? "node_modules or .git folder" : "node_modules or .git folders",
  "not-allowed": () => "not allowed",
  "not-a-file": () => "not a regular file",
  io: () => "could not be read or written",
};

/** "Synced 12 files to Build host. 3 unchanged, 1 skipped: over 1 MB." */
function syncSummary(input: {
  readonly from: string;
  readonly to: string;
  readonly written: number;
  readonly unchanged: number;
  readonly skipped: ReadonlyArray<AgentFileSkipped>;
}): string {
  const { written, unchanged, skipped } = input;
  if (written + unchanged + skipped.length === 0)
    return `${input.from} has no agent files to sync.`;
  const counts = new Map<AgentFileSkipReason, number>();
  for (const entry of skipped) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
  const reasons = [...counts].map(([reason, count]) =>
    counts.size === 1
      ? SKIP_REASON_LABELS[reason](count)
      : `${count} ${SKIP_REASON_LABELS[reason](count)}`,
  );
  const tail = [
    ...(unchanged > 0 ? [`${unchanged} unchanged`] : []),
    ...(skipped.length > 0 ? [`${skipped.length} skipped: ${reasons.join(", ")}`] : []),
  ];
  const head =
    written === 0 && unchanged > 0
      ? `${input.to} already has your agent files.`
      : `Synced ${written} ${written === 1 ? "file" : "files"} to ${input.to}.`;
  return tail.length === 0 ? head : `${head} ${tail.join(", ")}.`;
}

/** Skipped files listed under the summary; the rest are counted. */
const SKIPPED_SHOWN = 5;

type SyncOutcome =
  | {
      readonly kind: "synced";
      readonly message: string;
      readonly skipped: ReadonlyArray<AgentFileSkipped>;
    }
  | { readonly kind: "failed"; readonly message: string };

/**
 * "Sync to <host>": copies this device's agent files to another environment, so agents there follow
 * the same instructions and skills. The host is the environment this page shows, or, on this
 * device's own page, the one that runs its new work. Shown only when the two differ, both are
 * connected and can sync, and the host lets this connection change its settings.
 */
function AgentFilesSyncRow({
  environmentId,
  onSynced,
}: {
  readonly environmentId: EnvironmentId;
  readonly onSynced: (hostId: EnvironmentId) => void;
}) {
  const local = usePrimaryEnvironment();
  const newWorkHostId = useNewWorkEnvironmentId();
  const hostId = environmentId === local?.environmentId ? newWorkHostId : environmentId;
  const host = useEnvironment(hostId);
  const canImport = useAtomValue(tempoAgentFilesEnvironment.importFiles.permissionAtom(hostId));
  const exportFiles = useAtomCommand(tempoAgentFilesEnvironment.exportFiles, {
    label: "read agent files to sync",
    reportFailure: false,
  });
  const importFiles = useAtomCommand(tempoAgentFilesEnvironment.importFiles, {
    label: "sync agent files",
    reportFailure: false,
  });
  const [syncing, setSyncing] = useState(false);
  const [outcome, setOutcome] = useState<SyncOutcome | null>(null);
  if (
    !syncsAgentFiles(local) ||
    !syncsAgentFiles(host) ||
    host.environmentId === local.environmentId ||
    !canImport
  ) {
    return null;
  }

  const copyToHost = async () => {
    const exported = await exportFiles({ environmentId: local.environmentId, input: {} });
    if (exported._tag !== "Success") {
      const failure = failureOf(exported);
      if (failure) {
        setOutcome({
          kind: "failed",
          message: `Could not read your agent files on ${local.label}. ${failure.message}`,
        });
      }
      return;
    }
    const imported = await importFiles({
      environmentId: host.environmentId,
      input: { files: exported.value.files, links: exported.value.links },
    });
    if (imported._tag !== "Success") {
      const failure = failureOf(imported);
      if (failure) {
        setOutcome({
          kind: "failed",
          message: `Could not sync to ${host.label}. ${failure.message}`,
        });
      }
      return;
    }
    const skipped = [...exported.value.skipped, ...imported.value.skipped];
    setOutcome({
      kind: "synced",
      message: syncSummary({
        from: local.label,
        to: host.label,
        written: imported.value.written.length,
        unchanged: imported.value.unchanged.length,
        skipped,
      }),
      skipped,
    });
    onSynced(host.environmentId);
  };

  const sync = async () => {
    setSyncing(true);
    setOutcome(null);
    await copyToHost().finally(() => setSyncing(false));
  };

  return (
    <SettingsRow
      title="Sync your agent files"
      description={
        <>
          Copies your personal CLAUDE.md and AGENTS.md, your Claude skills, commands, agents,
          workflows, rules and output styles, and your Codex and ~/.agents skills, from{" "}
          {local.label} to {host.label}. Files there are replaced only when they differ, and none
          are deleted. Settings and credentials are never copied.
          {outcome?.kind === "failed" ? (
            <span role="alert" className="block text-destructive-foreground">
              {outcome.message}
            </span>
          ) : null}
          {outcome?.kind === "synced" ? (
            <span role="status" className="block text-foreground">
              {outcome.message}
            </span>
          ) : null}
          {outcome?.kind === "synced"
            ? outcome.skipped.slice(0, SKIPPED_SHOWN).map((entry) => (
                <span key={`${entry.path}:${entry.reason}`} className="block font-mono text-xs">
                  {entry.path} ({SKIP_REASON_LABELS[entry.reason](1)})
                </span>
              ))
            : null}
          {outcome?.kind === "synced" && outcome.skipped.length > SKIPPED_SHOWN ? (
            <span className="block">and {outcome.skipped.length - SKIPPED_SHOWN} more skipped</span>
          ) : null}
        </>
      }
      control={
        <Button size="xs" variant="outline" disabled={syncing} onClick={() => void sync()}>
          {syncing ? "Syncing…" : `Sync to ${host.label}`}
        </Button>
      }
    />
  );
}

const GROUP_TITLES: Record<InstructionFileGroup["scope"], (group: InstructionFileGroup) => string> =
  {
    global: (group) => `${group.title} · every project`,
    project: (group) => group.title,
    memory: (group) => `Claude auto memory · ${group.title}`,
  };

function personalSentence(
  provider: InstructionProvider,
  state: PersonalInstructionsState,
  usePersonal: boolean,
  path: string,
): string | null {
  const name = PROVIDER_LABELS[provider];
  switch (state) {
    case "direct":
      return null;
    case "included":
      return `New ${name} sessions here also load your ${path}.`;
    case "missing":
      return `You have no ${path} yet, so there is nothing personal to load.`;
    case "blocked":
      return `${APP_BASE_NAME}'s ${name} home has its own global instructions file, so your ${path} does not load here.`;
    case "excluded":
      return usePersonal
        ? `This ${name} home is separate from yours and not managed by ${APP_BASE_NAME}, so ${path} does not load here.`
        : `Turned off: new ${name} sessions here do not load your ${path}.`;
  }
}

function InstructionGroupSection({
  group,
  canWrite,
  usePersonal,
  onOpen,
}: {
  readonly group: InstructionFileGroup;
  readonly canWrite: boolean;
  readonly usePersonal: boolean;
  readonly onOpen: (file: OpenFile) => void;
}) {
  const personalProvider = group.providers[0];
  const personal =
    group.personal && personalProvider
      ? personalSentence(personalProvider, group.personal.state, usePersonal, group.personal.path)
      : null;
  return (
    <SettingsSection title={GROUP_TITLES[group.scope](group)}>
      <SettingsRow
        title={<span className="font-mono text-xs text-muted-foreground">{group.root}</span>}
        description={
          group.truncated
            ? "Some folders were not searched: the walk stops at 6 folders deep and 200 files. Folders git ignores are skipped."
            : undefined
        }
      />
      {group.personal && personal ? (
        <SettingsRow
          title="Your personal instructions"
          description={personal}
          control={
            group.personal.state === "included" ? (
              <Button
                size="xs"
                variant="outline"
                onClick={() =>
                  onOpen({
                    path: group.personal!.path,
                    displayPath: group.personal!.path,
                    create: false,
                  })
                }
              >
                Open
              </Button>
            ) : null
          }
        />
      ) : null}
      {group.entries.map((entry) => (
        <InstructionEntryRow key={entry.path} entry={entry} canWrite={canWrite} onOpen={onOpen} />
      ))}
    </SettingsSection>
  );
}

function ProviderBadges({ providers }: { readonly providers: ReadonlyArray<InstructionProvider> }) {
  if (providers.length === 0) {
    return (
      <Badge variant="outline" size="sm">
        Not loaded
      </Badge>
    );
  }
  return providers.map((provider) => (
    <Badge key={provider} variant="secondary" size="sm">
      {PROVIDER_LABELS[provider]}
    </Badge>
  ));
}

function InstructionEntryRow({
  entry,
  canWrite,
  onOpen,
}: {
  readonly entry: InstructionFileEntry;
  readonly canWrite: boolean;
  readonly onOpen: (file: OpenFile) => void;
}) {
  const action =
    entry.unopenable !== undefined
      ? null
      : entry.exists
        ? canWrite
          ? "Edit"
          : "View"
        : canWrite
          ? "Create"
          : null;
  return (
    <SettingsRow
      title={<span className="font-mono text-xs">{entry.displayPath}</span>}
      description={
        <>
          {entry.exists ? entry.loadedBy : `Not created yet. ${entry.loadedBy}`}
          {entry.linkTarget && !entry.unopenable ? ` Links to ${entry.linkTarget}.` : null}
          {entry.unopenable ? ` ${entry.unopenable}` : null}
          {entry.warning ? (
            <span className="block text-warning-foreground">{entry.warning}</span>
          ) : null}
        </>
      }
      control={
        <div className="flex items-center gap-1.5">
          <ProviderBadges providers={entry.providers} />
          {action ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                onOpen({
                  path: entry.path,
                  displayPath: entry.displayPath,
                  create: !entry.exists,
                  ...(entry.importedFrom === undefined ? {} : { via: entry.importedFrom }),
                })
              }
            >
              {action}
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

function failureOf(result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return {
    conflict: isInstructionFileError(error) && error.reason === "conflict",
    message:
      error instanceof Error && error.message.trim() !== ""
        ? error.message
        : "The environment could not complete the request.",
  };
}

/** A version of the file: what the editor shows when there is no draft, and what a save checks. */
interface Baseline {
  readonly content: string;
  readonly mtimeMs: number | null;
}

/**
 * The editor: plain monospace text, Save and Revert, and a conflict notice when
 * the file changed. A draft remembers the version it started from, so a save
 * after a conflict fails again until the person reloads.
 */
function InstructionFileSheet({
  environmentId,
  file,
  previous,
  canWrite,
  onOpen,
  onBack,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly file: OpenFile;
  readonly previous: OpenFile | undefined;
  readonly canWrite: boolean;
  readonly onOpen: (file: OpenFile) => void;
  readonly onBack: () => void;
  readonly onClose: () => void;
}) {
  const [created, setCreated] = useState(false);
  const isNew = file.create && !created;
  const target = { path: file.path, ...(file.via === undefined ? {} : { via: file.via }) };
  const fileQuery = useEnvironmentQuery(
    isNew ? null : tempoInstructionFilesEnvironment.file({ environmentId, input: target }),
  );
  const write = useAtomCommand(tempoInstructionFilesEnvironment.write, {
    label: "save instruction file",
    reportFailure: false,
  });
  const remove = useAtomCommand(tempoInstructionFilesEnvironment.remove, {
    label: "delete instruction file",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<Baseline | null>(null);
  // The last save, shown until the refreshed read catches up with it.
  const [saved, setSaved] = useState<Baseline | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<{ conflict: boolean; message: string } | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [pendingLeave, setPendingLeave] = useState<(() => void) | null>(null);
  const loaded = fileQuery.data;
  const latest: Baseline | null = isNew
    ? { content: "", mtimeMs: null }
    : saved !== null && (loaded === null || loaded.mtimeMs < (saved.mtimeMs ?? 0))
      ? saved
      : loaded === null
        ? null
        : { content: loaded.content, mtimeMs: loaded.mtimeMs };
  const ready = latest !== null;
  const startedFrom = base ?? latest;
  const content = draft ?? latest?.content ?? "";
  const dirty = draft !== null && draft !== startedFrom?.content;

  // Leaving drops the draft, so ask first when there is one.
  const leave = (action: () => void) => {
    if (dirty) setPendingLeave(() => action);
    else action();
  };

  const discardDraft = () => {
    setDraft(null);
    setBase(null);
    setFailure(null);
  };

  const save = async () => {
    setBusy(true);
    setFailure(null);
    const result = await write({
      environmentId,
      input: {
        ...target,
        content,
        expectedMtimeMs: isNew ? null : (startedFrom?.mtimeMs ?? null),
      },
    }).finally(() => setBusy(false));
    const failed = failureOf(result);
    setFailure(failed);
    if (result._tag === "Success") {
      setSaved({ content, mtimeMs: result.value.mtimeMs });
      setDraft(null);
      setBase(null);
      setCreated(true);
    }
  };

  const reload = () => {
    discardDraft();
    setSaved(null);
    fileQuery.refresh();
  };

  const confirmDelete = async () => {
    const mtimeMs = latest?.mtimeMs;
    if (mtimeMs === null || mtimeMs === undefined) return;
    setConfirmingDelete(false);
    setBusy(true);
    const result = await remove({
      environmentId,
      input: { ...target, expectedMtimeMs: mtimeMs },
    }).finally(() => setBusy(false));
    const failed = failureOf(result);
    setFailure(failed);
    if (failed === null) onClose();
  };

  return (
    <Sheet open onOpenChange={(next) => (next ? undefined : leave(onClose))}>
      <SheetPopup side="right" className="max-w-3xl">
        <SheetHeader>
          {previous ? (
            <div>
              <Button size="xs" variant="ghost" onClick={() => leave(onBack)}>
                <ArrowLeftIcon />
                Back to {previous.displayPath}
              </Button>
            </div>
          ) : null}
          <SheetTitle>
            <span className="font-mono">{file.displayPath}</span>
          </SheetTitle>
          <SheetDescription>
            {file.path}. Changes apply to new Claude and Codex sessions.
          </SheetDescription>
        </SheetHeader>
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-6 pb-6">
          {fileQuery.error && !loaded ? (
            <p role="alert" className="text-sm text-destructive-foreground">
              {fileQuery.error}
            </p>
          ) : null}
          <textarea
            aria-label={`Contents of ${file.displayPath}`}
            className="min-h-64 w-full flex-1 resize-none rounded-lg border border-input bg-background p-3 font-mono text-xs leading-relaxed text-foreground outline-none focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/24 dark:bg-input/32"
            spellCheck={false}
            readOnly={!canWrite || !ready || busy}
            value={ready ? content : ""}
            placeholder={ready ? (isNew ? "Write instructions in Markdown." : "") : "Loading…"}
            onChange={(event) => {
              if (draft === null) setBase(latest);
              setDraft(event.target.value);
            }}
          />
          {loaded && loaded.imports.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <span>Imports:</span>
              {loaded.imports.map((item) =>
                item.openable ? (
                  <Button
                    key={item.path}
                    size="micro"
                    variant="outline"
                    onClick={() =>
                      leave(() =>
                        onOpen({
                          path: item.path,
                          displayPath: `@${item.token}`,
                          create: false,
                          via: file.path,
                        }),
                      )
                    }
                  >
                    @{item.token}
                  </Button>
                ) : (
                  <span key={item.path}>
                    @{item.token}
                    {item.exists ? " (not opened here)" : " (missing)"}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {failure ? (
            <div
              role="alert"
              className="flex items-center justify-between gap-3 text-sm text-destructive-foreground"
            >
              <span>{failure.message}</span>
              {failure.conflict ? (
                <Button size="xs" variant="outline" onClick={reload}>
                  Reload and discard my edits
                </Button>
              ) : null}
            </div>
          ) : null}
          {canWrite ? (
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                disabled={!ready || busy || (!dirty && !isNew)}
                onClick={() => void save()}
              >
                {isNew ? "Create" : "Save"}
              </Button>
              <Button size="sm" variant="outline" disabled={!dirty || busy} onClick={discardDraft}>
                Revert
              </Button>
              {!isNew && typeof latest?.mtimeMs === "number" ? (
                <Button
                  size="sm"
                  variant="ghost-destructive"
                  disabled={busy}
                  onClick={() => setConfirmingDelete(true)}
                >
                  Delete
                </Button>
              ) : null}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              This connection can read these files but lacks permission to change settings here.
            </p>
          )}
        </div>
      </SheetPopup>
      <AlertDialog open={confirmingDelete} onOpenChange={setConfirmingDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {file.displayPath}?</AlertDialogTitle>
            <AlertDialogDescription>
              New Claude and Codex sessions stop loading it. If it is a symlink, only the link is
              removed. If it changed since you opened it, nothing is deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Delete file
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      <AlertDialog
        open={pendingLeave !== null}
        onOpenChange={(next) => (next ? undefined : setPendingLeave(null))}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes to {file.displayPath}?</AlertDialogTitle>
            <AlertDialogDescription>Your unsaved edits will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const action = pendingLeave;
                setPendingLeave(null);
                action?.();
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </Sheet>
  );
}
