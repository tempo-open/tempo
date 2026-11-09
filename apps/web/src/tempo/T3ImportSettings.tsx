import { useAtomValue } from "@effect/atom-react";
import {
  tempoT3ImportIncompatibilityMessage,
  resolveEnvironmentMachineKind,
  type TempoT3ImportInput,
  type TempoT3ImportRunResult,
  type TempoT3ImportScanProject,
  type TempoT3ImportScanResult,
  type TempoT3ImportSkipReason,
  type TempoT3ImportSkipped,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { CircleAlertIcon } from "lucide-react";
import { useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { EnvironmentMachineIcon } from "../components/EnvironmentMachineIcon";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { useSettingsScope } from "../components/settings/SettingsScopeContext";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { formatBytes } from "../lib/formatBytes";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { t3ImportRun, t3ImportScan } from "./t3ImportState";

type SettingsEnvironment = ReturnType<typeof useSettingsScope>["connectedEnvironments"][number];

/** Each reads after a count: "2 still working in T3 Code". */
const SKIP_REASONS: Readonly<Record<TempoT3ImportSkipReason, string>> = {
  settled: "settled or archived",
  live: "still working in T3 Code",
  notHydrated: "waiting for T3 Code to load their history",
  unreadable: "unreadable",
  folderMissing: "in a folder that no longer exists",
  projectRemoved: `in a project you removed from ${APP_BASE_NAME}`,
  failed: "failed to copy",
};

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? "" : "s"}`;
}

function skippedText(skipped: ReadonlyArray<TempoT3ImportSkipped>): ReadonlyArray<string> {
  return skipped.map((entry) => `${entry.count.toLocaleString()} ${SKIP_REASONS[entry.reason]}`);
}

function projectSummary(project: TempoT3ImportScanProject): string {
  return [
    project.toImport > 0
      ? `${plural(project.toImport, "thread")} to import into ${project.tempoProject?.title ?? "a new project"}`
      : null,
    project.alreadyImported > 0
      ? `${project.alreadyImported.toLocaleString()} already imported`
      : null,
    ...skippedText(project.skipped),
  ]
    .filter((part) => part !== null)
    .join(" · ");
}

/** What a finished import did, a sentence per line. */
function resultLines(result: TempoT3ImportRunResult): ReadonlyArray<string> {
  const created = result.projects.filter((project) => project.createdProject).length;
  const skipped = new Map<TempoT3ImportSkipReason, number>();
  for (const entry of result.projects.flatMap((project) => project.skipped)) {
    skipped.set(entry.reason, (skipped.get(entry.reason) ?? 0) + entry.count);
  }
  const skippedSummary = skippedText(
    [...skipped].map(([reason, count]) => ({ reason, count })),
  ).join(", ");
  return [
    created > 0 ? `Created ${plural(created, "project")}.` : null,
    skippedSummary === "" ? null : `Skipped: ${skippedSummary}.`,
    result.missingAttachments > 0
      ? `${plural(result.missingAttachments, "attachment")} T3 Code no longer had on disk ${result.missingAttachments === 1 ? "was" : "were"} left out.`
      : null,
    result.needsModel > 0
      ? `${plural(result.needsModel, "thread")} used a provider this machine does not have. Pick a model before continuing ${result.needsModel === 1 ? "it" : "them"}.`
      : null,
  ].filter((line) => line !== null);
}

/** The sentence a failed command shows; the import's errors carry one for people. */
function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The environment could not complete the import.";
}

/**
 * tempo: Settings → Maintenance, "Import from T3 Code": one section for each selected
 * environment that can import. Nothing reads T3 Code's data until the user scans.
 */
export function T3ImportSettings() {
  const { connectedEnvironments } = useSettingsScope();
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.environment.capabilities.tempoT3Import === true,
  );
  return supported.map((environment, index) => (
    <T3ImportSection
      key={environment.environmentId}
      environment={environment}
      showEnvironmentLabel={supported.length > 1}
      // Search anchors must be unique, so only the first section carries one.
      anchored={index === 0}
    />
  ));
}

function T3ImportSection({
  environment,
  showEnvironmentLabel,
  anchored,
}: {
  readonly environment: SettingsEnvironment;
  readonly showEnvironmentLabel: boolean;
  readonly anchored: boolean;
}) {
  const { environmentId } = environment;
  const [scanRequested, setScanRequested] = useState(false);
  const [includeSettled, setIncludeSettled] = useState(false);
  // Scan and import read the same input, so the counts shown are what the import does.
  const input: TempoT3ImportInput = includeSettled ? { includeSettled: true } : {};
  const scan = useEnvironmentQuery(scanRequested ? t3ImportScan({ environmentId, input }) : null);
  const canImport = useAtomValue(t3ImportRun.permissionAtom(environmentId));
  const runImport = useAtomCommand(t3ImportRun, {
    label: "import from T3 Code",
    reportFailure: false,
  });
  const [importing, setImporting] = useState(false);
  const [outcome, setOutcome] = useState<
    { readonly result: TempoT3ImportRunResult } | { readonly failure: string } | null
  >(null);

  const data = scan.data;
  const ready = data !== null && data.found && data.incompatibility === null;
  const toImport = ready ? data.projects.reduce((sum, project) => sum + project.toImport, 0) : 0;

  const startImport = async () => {
    setImporting(true);
    setOutcome(null);
    const result = await runImport({ environmentId, input }).finally(() => setImporting(false));
    if (result._tag === "Success") setOutcome({ result: result.value });
    else {
      const failure = failureMessage(result);
      if (failure !== null) setOutcome({ failure });
    }
  };

  const title = searchableSetting("tempo-t3-import").title;
  return (
    <SettingsSection
      title={showEnvironmentLabel ? `${title} · ${environment.label}` : title}
      icon={
        showEnvironmentLabel ? (
          <EnvironmentMachineIcon
            kind={resolveEnvironmentMachineKind(environment.serverConfig)}
            className="size-3.5"
          />
        ) : undefined
      }
      {...(anchored ? { id: searchableSetting("tempo-t3-import").id } : {})}
    >
      <SettingsRow
        title="T3 Code"
        description={
          data === null
            ? scan.error !== null && !scan.isPending
              ? scan.error
              : `Copy the projects and threads of T3 Code on ${showEnvironmentLabel ? environment.label : "this machine"} into ${APP_BASE_NAME}. T3 Code's data is only read, never changed.`
            : scannedDescription(data)
        }
        // A failed rescan keeps the last result on screen, so its error shows beside it.
        status={data === null ? undefined : (scan.error ?? scannedStatus(data))}
        control={
          <>
            {data?.t3Running ? (
              <Badge variant="warning" role="status">
                <CircleAlertIcon />
                Running
              </Badge>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={scan.isPending || importing}
              onClick={() => (scanRequested ? scan.refresh() : setScanRequested(true))}
            >
              {scan.isPending ? "Scanning…" : data === null ? "Scan" : "Scan again"}
            </Button>
          </>
        }
      />
      {/* Stays on screen while a change rescans, which clears the counts below. */}
      {data === null || ready ? (
        <SettingsRow
          title="Also import settled threads"
          description="Settled and archived threads stay in T3 Code unless this is on; then they arrive settled or archived."
          control={
            <Checkbox
              aria-label="Also import settled threads"
              checked={includeSettled}
              disabled={importing}
              onCheckedChange={(checked) => setIncludeSettled(checked)}
            />
          }
        />
      ) : null}
      {ready
        ? data.projects.map((project) => (
            <SettingsRow
              key={project.t3ProjectId}
              title={project.title}
              description={<span className="wrap-anywhere">{project.workspaceRoot}</span>}
              status={projectSummary(project)}
            />
          ))
        : null}
      {ready ? (
        <SettingsRow
          title="Import"
          description={
            <>
              Brings the conversation only: messages, plans and their attachments. Tool activity and
              checkpoints stay in T3 Code. Imported threads keep working in T3 Code's worktrees, and
              each one's first new message picks up with a handoff of its history.
              {canImport
                ? null
                : " This connection lacks permission to import threads on this environment."}
            </>
          }
          control={
            <Button
              size="sm"
              disabled={!canImport || importing || scan.isPending || toImport === 0}
              onClick={() => void startImport()}
            >
              {importing
                ? "Importing…"
                : toImport === 0
                  ? "Nothing to import"
                  : `Import ${plural(toImport, "thread")}`}
            </Button>
          }
        />
      ) : null}
      {outcome === null ? null : "failure" in outcome ? (
        <SettingsRow
          title="Import stopped"
          description={
            <span role="alert" className="text-destructive-foreground">
              {outcome.failure}
            </span>
          }
        />
      ) : (
        <SettingsRow
          title={
            outcome.result.projects.some((project) => project.imported > 0)
              ? `Imported ${plural(
                  outcome.result.projects.reduce((sum, project) => sum + project.imported, 0),
                  "thread",
                )}`
              : "Nothing new to import"
          }
          description={
            <span className="block space-y-0.5">
              {resultLines(outcome.result).map((line) => (
                <span key={line} className="block">
                  {line}
                </span>
              ))}
            </span>
          }
        />
      )}
    </SettingsSection>
  );
}

function scannedDescription(scan: TempoT3ImportScanResult): string {
  if (!scan.found) return `No T3 Code data in ${scan.t3Home}.`;
  if (scan.incompatibility !== null)
    return tempoT3ImportIncompatibilityMessage(scan.incompatibility);
  return `${scan.t3Home} · ${formatBytes(scan.sizeBytes)}`;
}

function scannedStatus(scan: TempoT3ImportScanResult): string | undefined {
  if (!scan.found || scan.incompatibility !== null) return undefined;
  if (scan.projects.length === 0) return "T3 Code has no threads to import.";
  return scan.t3Running
    ? "T3 Code is running, so threads it is working on are left for later. Quit it first to bring everything."
    : undefined;
}
