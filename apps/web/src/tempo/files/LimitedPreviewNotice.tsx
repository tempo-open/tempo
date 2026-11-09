import {
  type FullFileRequest,
  limitedPreviewState,
} from "@t3tools/client-runtime/tempo/full-file-preview";
import {
  AuthOrchestrationOperateScope,
  TEMPO_FULL_FILE_READ_MAX_BYTES,
  type EnvironmentId,
} from "@t3tools/contracts";
import { FILE_TEXT_PREVIEW_MAX_BYTES } from "@t3tools/shared/filePreview";

import { APP_BASE_NAME } from "~/branding";
import { FileSurfaceNotice } from "~/components/files/fileSurfaceChrome";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useFileContextMenu } from "~/fileContextMenu";
import { useEnvironmentScope } from "~/state/session";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * tempo: the bar over a preview cut at its first MiB. It loads the whole file
 * up to TEMPO_FULL_FILE_READ_MAX_BYTES and, for a file on the environment's disk,
 * reveals it in the file manager, which is where a file too large to load opens.
 * The owner renders it only while the read on screen is cut.
 */
export function LimitedPreviewNotice(props: {
  /** The whole file's size, or null when unknown. */
  readonly byteLength: number | null;
  readonly request: FullFileRequest;
  /** Why the full read failed. */
  readonly failure?: string | null;
  /** Added when the file is too large to load, such as where else to read it. */
  readonly tooLargeHint?: string;
  readonly onLoadFull: () => void;
  readonly reveal?: { readonly environmentId: EnvironmentId; readonly absolutePath: string };
}) {
  const state = limitedPreviewState({
    truncated: true,
    byteLength: props.byteLength,
    request: props.request,
  });
  // Only a full read that hit the cap shows more than a preview's first MiB.
  const limit =
    state === "too-large" && props.request === "loaded"
      ? TEMPO_FULL_FILE_READ_MAX_BYTES
      : FILE_TEXT_PREVIEW_MAX_BYTES;
  const detail =
    state === "too-large"
      ? `Only files up to ${megabytes(TEMPO_FULL_FILE_READ_MAX_BYTES)} load in full.${props.tooLargeHint ? ` ${props.tooLargeHint}` : ""}`
      : state === "unsupported"
        ? `Update ${APP_BASE_NAME} on this environment to load the full file.`
        : state === "failed"
          ? (props.failure ?? "The full file could not be loaded.")
          : null;
  return (
    <FileSurfaceNotice>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <p className="min-w-0 flex-1">
          Preview limited to the first {megabytes(limit)}
          {props.byteLength === null ? "" : ` of a ${props.byteLength.toLocaleString()} byte file`}.
          {detail ? ` ${detail}` : null}
        </p>
        <div className="flex shrink-0 items-center gap-1.5">
          {state === "offer" || state === "loading" || state === "failed" ? (
            <Button
              variant="warning-outline"
              size="micro"
              disabled={state === "loading"}
              onClick={props.onLoadFull}
            >
              {state === "loading"
                ? "Loading full file…"
                : state === "failed"
                  ? "Try again"
                  : "Load full file"}
            </Button>
          ) : null}
          {props.reveal ? <RevealFileButton {...props.reveal} /> : null}
        </div>
      </div>
    </FileSurfaceNotice>
  );
}

/**
 * The file context menu's reveal, with its wording and availability. It runs on
 * the environment's machine, so for a remote environment the file manager opens
 * there, as it does from the context menu.
 */
function RevealFileButton(props: {
  readonly environmentId: EnvironmentId;
  readonly absolutePath: string;
}) {
  const { revealLabel } = useFileContextMenu(props.environmentId).capabilities;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  if (revealLabel === undefined || !canOperate) return null;
  return (
    <Button
      variant="warning-outline"
      size="micro"
      onClick={() => {
        void openInEditor({
          environmentId: props.environmentId,
          input: { cwd: props.absolutePath, editor: "file-manager", reveal: true },
        }).then((result) => {
          if (result._tag !== "Failure") return;
          toastManager.add({
            type: "error",
            title: "Unable to reveal file",
            description: props.absolutePath,
          });
        });
      }}
    >
      {revealLabel}
    </Button>
  );
}
