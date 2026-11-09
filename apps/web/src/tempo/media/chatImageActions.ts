import type { MediaActionId } from "@t3tools/client-runtime/media-actions";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerConfig,
} from "@t3tools/contracts";
import { isWindowsAbsolutePath } from "@t3tools/shared/path";

import { canOpenLinksInApp, resolveLinkTarget } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import type { MediaActionSource } from "~/components/media/MediaActions";
import { readMediaBlob } from "~/components/media/mediaContent";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "~/components/preview/fileExplorerLabel";
import { useComposerDraftStore } from "~/composerDraftStore";
import { getClientSettings } from "~/hooks/useSettings";
import { prepareImageForAttachment } from "~/lib/imageCompression";
import { randomUUID } from "~/lib/utils";
import { readLocalApi } from "~/localApi";
import { remoteOpenResolutionAtom } from "~/remoteOpen";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { readEnvironmentScope, readPreparedConnection } from "~/state/session";
import { shellEnvironment } from "~/state/shell";

import { chatImageFile, newTabTarget } from "./chatImageRules";

export type ChatImageActionId = Extract<
  MediaActionId,
  "open-in-new-tab" | "add-to-chat" | "reveal-in-folder"
>;

export function isChatImageAction(action: MediaActionId): action is ChatImageActionId {
  return action === "open-in-new-tab" || action === "add-to-chat" || action === "reveal-in-folder";
}

export interface ChatImageMenu {
  readonly threadRef: ScopedThreadRef | null;
  readonly canOpenInNewTab: boolean;
  /** The thread's in-app browser; otherwise the system browser, which keeps links in its history. */
  readonly opensInPreview: boolean;
  readonly canAddToChat: boolean;
  readonly revealLabel: string | undefined;
}

function sourceThreadRef(source: MediaActionSource): ScopedThreadRef | null {
  if (source.threadRef !== undefined) return source.threadRef;
  const asset = source.asset;
  if (asset === undefined || !("threadId" in asset.resource)) return null;
  return { environmentId: asset.environmentId, threadId: asset.resource.threadId };
}

function revealLabelFor(config: ServerConfig | null): string | undefined {
  if (
    config?.shellRevealInFileManager !== true ||
    !config.availableEditors.includes("file-manager")
  )
    return undefined;
  return config.shellRevealInFileManagerKind === undefined
    ? revealInFileExplorerLabelForOs(config.environment.platform.os)
    : revealInFileExplorerLabelForKind(config.shellRevealInFileManagerKind);
}

// The reveal runs on the server's machine, so it is offered only when that is this machine.
function readRevealLabel(source: MediaActionSource): string | undefined {
  const reference = source.reference;
  const environmentId = source.asset?.environmentId;
  if (
    reference?.kind !== "file" ||
    environmentId === undefined ||
    !(reference.path.startsWith("/") || isWindowsAbsolutePath(reference.path)) ||
    !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)
  )
    return undefined;
  const remoteOpen = appAtomRegistry.get(remoteOpenResolutionAtom(environmentId));
  if (!remoteOpen.isResolved || remoteOpen.state.mode !== "local-exec") return undefined;
  return revealLabelFor(appAtomRegistry.get(serverEnvironment.configValueAtom(environmentId)));
}

/** Where the image opens: its own address, or for a server asset the server's. */
function imageAddress(source: MediaActionSource): string | null {
  const target = newTabTarget(source, true);
  if (target?.kind === "url") return target.url;
  if (source.asset === undefined) return null;
  return readPreparedConnection(source.asset.environmentId)?.httpBaseUrl ?? null;
}

/** Read when the menu opens, so the images in a chat subscribe to nothing extra. */
export function readChatImageMenu(source: MediaActionSource): ChatImageMenu {
  const threadRef = sourceThreadRef(source);
  if (source.kind !== "image") {
    return {
      threadRef,
      canOpenInNewTab: false,
      opensInPreview: false,
      canAddToChat: false,
      revealLabel: undefined,
    };
  }
  const hasBytes = source.asset !== undefined || source.src !== null;
  const address = imageAddress(source);
  const opensInPreview =
    threadRef !== null &&
    address !== null &&
    resolveLinkTarget({
      url: address,
      origin: "chat",
      preference: getClientSettings().browserLinkTarget,
      canOpenInApp: canOpenLinksInApp(threadRef),
    }) === "app";
  return {
    threadRef,
    canOpenInNewTab: newTabTarget(source, opensInPreview) !== null,
    opensInPreview,
    canAddToChat: threadRef !== null && hasBytes,
    revealLabel: readRevealLabel(source),
  };
}

/** A sent message's image is a server attachment; while its preview is a blob: or data: URL it is still local. */
export function userImageMediaSource(
  image: { readonly id: string; readonly name: string; readonly previewUrl: string },
  environmentId: EnvironmentId,
  threadRef: ScopedThreadRef | null,
): MediaActionSource {
  return {
    kind: "image",
    name: image.name,
    src: image.previewUrl,
    ...(/^(?:blob|data):/i.test(image.previewUrl)
      ? {}
      : { asset: { environmentId, resource: { _tag: "attachment", attachmentId: image.id } } }),
    ...(threadRef === null ? {} : { threadRef }),
  };
}

async function openImageInNewTab(
  source: MediaActionSource,
  menu: ChatImageMenu,
  actionUrl: () => Promise<string>,
): Promise<void> {
  const target = newTabTarget(source, menu.opensInPreview);
  if (target === null) throw new Error("This image has no public address to open in a browser.");
  const url = target.kind === "url" ? target.url : await actionUrl();
  const { threadRef } = menu;
  if (menu.opensInPreview && threadRef !== null) {
    const result = await openUrlInPreview({
      threadRef,
      url,
      openPreview: (input) =>
        runAtomCommand(appAtomRegistry, previewEnvironment.open, input, { reportFailure: false }),
      page: false,
    });
    if (result._tag === "Failure") throw squashAtomCommandFailure(result);
    return;
  }
  const api = readLocalApi();
  if (api === undefined) throw new Error("Opening links is unavailable here.");
  await api.shell.openExternal(url);
}

async function addImageToChat(
  url: string,
  name: string,
  threadRef: ScopedThreadRef,
): Promise<void> {
  const image = chatImageFile(await readMediaBlob(url), name);
  if (typeof image === "string") throw new Error(image);
  const prepared = await prepareImageForAttachment(image, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
  if (!prepared.ok) {
    throw new Error(
      prepared.reason === "unreadable"
        ? "The image could not be read."
        : "The image is too large to attach, even after compression.",
    );
  }
  const file = prepared.file;
  const previewUrl = URL.createObjectURL(file);
  const isAdded = useComposerDraftStore.getState().addImage(threadRef, {
    type: "image",
    id: randomUUID(),
    name: file.name || name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl,
    file,
  });
  if (!isAdded) {
    URL.revokeObjectURL(previewUrl);
    throw new Error("The draft rejected this image (duplicate or attachment limit reached).");
  }
}

async function revealImage(source: MediaActionSource): Promise<void> {
  const reference = source.reference;
  const environmentId = source.asset?.environmentId;
  if (reference?.kind !== "file" || environmentId === undefined) return;
  if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) {
    throw new Error("This connection cannot reveal files on this environment.");
  }
  const result = await runAtomCommand(
    appAtomRegistry,
    shellEnvironment.openInEditor,
    { environmentId, input: { cwd: reference.path, editor: "file-manager", reveal: true } },
    { reportFailure: false },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
}

export async function runChatImageAction(
  action: ChatImageActionId,
  input: {
    readonly source: MediaActionSource;
    readonly menu: ChatImageMenu;
    readonly fileName: string;
    readonly actionUrl: () => Promise<string>;
  },
): Promise<void> {
  if (action === "reveal-in-folder") return revealImage(input.source);
  if (action === "open-in-new-tab")
    return openImageInNewTab(input.source, input.menu, input.actionUrl);
  if (input.menu.threadRef === null) return;
  return addImageToChat(await input.actionUrl(), input.fileName, input.menu.threadRef);
}
