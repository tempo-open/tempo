/**
 * tempo: the repos volume setup terminal. It opens in the home folder of the chosen
 * environment and types the setup script's command, so the person only answers
 * macOS's password prompt there. Closing ends that terminal and its history.
 */
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthTerminalOperateScope,
  ThreadId,
  type EnvironmentId,
  type ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ExternalLinkIcon } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { TYPOGRAPHY_ADVANCED_STORAGE_KEY } from "../appearanceFonts";
import { APP_BASE_NAME } from "../branding";
import { TerminalViewport } from "../components/ThreadTerminalDrawer";
import { InlineButton } from "../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { randomUUID } from "../lib/utils";
import { readEnvironmentScope } from "../state/session";
import { terminalEnvironment } from "../state/terminal";
import { useAtomCommand } from "../state/use-atom-command";
import { REPOS_VOLUME_README_URL, reposVolumeSetupCommand } from "./reposVolume.logic";
import { reposVolumePrepare } from "./reposVolumeState";

/** Not a thread: the setup terminal lives under this id, so no thread ever lists it. */
const SETUP_THREAD_ID = ThreadId.make("tempo-repos-volume-setup");

type Setup =
  | { readonly phase: "preparing" }
  | { readonly phase: "failed"; readonly message: string }
  | {
      readonly phase: "open";
      readonly cwd: string;
      readonly command: string;
      /** False when typing the command failed, so the person types it. */
      readonly typed: boolean;
    };

export default function ReposVolumeSetupDialog({
  environmentId,
  environmentLabel,
  keybindings,
  onClose,
  onClosed,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly keybindings: ResolvedKeybindingsConfig;
  /** Asks the owner to close the dialog. */
  readonly onClose: () => void;
  /** Runs once the terminal is gone, when the volume may have changed. */
  readonly onClosed: () => void;
}) {
  const [advancedTypography] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const prepare = useAtomCommand(reposVolumePrepare, { reportFailure: false });
  const openTerminal = useAtomCommand(terminalEnvironment.open, { reportFailure: false });
  const writeTerminal = useAtomCommand(terminalEnvironment.write, { reportFailure: false });
  const closeTerminal = useAtomCommand(terminalEnvironment.close, { reportFailure: false });
  // Each dialog gets its own terminal, so a second window never types into this one's prompt.
  const [terminalId] = useState(() => `repos-volume-${randomUUID()}`);
  const [setup, setSetup] = useState<Setup>({ phase: "preparing" });
  const setupQueueRef = useRef(Promise.resolve());
  const setupGenerationRef = useRef(0);
  const activeSetupGenerationRef = useRef<number | null>(null);
  const handleClosed = useEffectEvent(onClosed);

  // In Strict Mode a canceled setup can finish after its replacement starts; it must not
  // type into, or close, the replacement's terminal, which shares this terminal id.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the setup terminal session on the environment while the dialog is mounted and closes it, with its history, on unmount
  useEffect(() => {
    const generation = setupGenerationRef.current + 1;
    setupGenerationRef.current = generation;
    activeSetupGenerationRef.current = generation;
    const isCurrent = () => activeSetupGenerationRef.current === generation;
    const fail = (message: string) => {
      if (isCurrent()) setSetup({ phase: "failed", message });
    };

    setupQueueRef.current = setupQueueRef.current.then(async () => {
      if (!isCurrent()) return;
      if (!readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
        fail("This connection can't open a terminal on this machine.");
        return;
      }
      const prepared = await prepare({ environmentId, input: {} });
      if (!isCurrent()) return;
      if (prepared._tag !== "Success") {
        fail("Could not write the setup script on this machine.");
        return;
      }
      const { scriptPath, cwd } = prepared.value;
      const opened = await openTerminal({
        environmentId,
        input: { threadId: SETUP_THREAD_ID, terminalId, cwd },
      });
      if (!isCurrent()) return;
      if (opened._tag !== "Success") {
        fail("Could not open the setup terminal.");
        return;
      }
      const command = reposVolumeSetupCommand(scriptPath);
      const typed = await writeTerminal({
        environmentId,
        input: { threadId: SETUP_THREAD_ID, terminalId, data: `${command}\r` },
      });
      if (isCurrent()) setSetup({ phase: "open", cwd, command, typed: typed._tag === "Success" });
    });

    return () => {
      if (isCurrent()) activeSetupGenerationRef.current = null;
      setupQueueRef.current = setupQueueRef.current.then(async () => {
        // A connection that lost terminal access leaves the session running.
        if (readEnvironmentScope(environmentId, AuthTerminalOperateScope)) {
          await closeTerminal({
            environmentId,
            input: { threadId: SETUP_THREAD_ID, terminalId, deleteHistory: true },
          });
        }
        handleClosed();
      });
    };
  }, [closeTerminal, environmentId, openTerminal, prepare, terminalId, writeTerminal]);

  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(open, event) => {
        if (open) return;
        // Escape belongs to the terminal, and closing would stop the setup mid-way.
        if (event.reason === "escape-key") {
          event.cancel();
          return;
        }
        onClose();
      }}
    >
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Set up the repos volume</DialogTitle>
          <DialogDescription>
            The setup script runs below on {environmentLabel} and asks for your password on that
            Mac. It goes to macOS, and {APP_BASE_NAME} doesn't keep it. Closing stops a setup that
            hasn't finished; the script's{" "}
            <InlineButton
              tone="muted"
              render={
                <a href={REPOS_VOLUME_README_URL} target="_blank" rel="noreferrer noopener" />
              }
            >
              README
              <ExternalLinkIcon aria-hidden className="size-3" />
            </InlineButton>{" "}
            explains how to recover.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {setup.phase === "open" && !setup.typed ? (
            <p className="text-xs text-muted-foreground">
              Run <code className="rounded bg-muted px-1 font-mono">{setup.command}</code> in this
              terminal.
            </p>
          ) : null}
          <div
            data-thread-terminal-drawer
            className="h-80 overflow-hidden rounded-lg border border-border/70 bg-background text-foreground"
          >
            {setup.phase === "open" ? (
              <TerminalViewport
                threadRef={scopeThreadRef(environmentId, SETUP_THREAD_ID)}
                threadId={SETUP_THREAD_ID}
                terminalId={terminalId}
                terminalLabel="Repos volume setup"
                cwd={setup.cwd}
                advancedTypography={advancedTypography}
                onSessionExited={onClose}
                autoFocus
                visible
                keybindings={keybindings}
              />
            ) : (
              <p
                role={setup.phase === "failed" ? "alert" : "status"}
                className="p-4 text-xs text-muted-foreground"
              >
                {setup.phase === "failed" ? setup.message : "Preparing setup…"}
              </p>
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
