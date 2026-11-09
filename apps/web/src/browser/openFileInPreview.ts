import type {
  AssetCreateUrlResult,
  AssetResource,
  EnvironmentId,
  PreviewOpenInput,
  PreviewSessionSnapshot,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { mediaFileReference } from "@t3tools/client-runtime/media-reference";
import {
  type AtomCommandResult,
  mapAtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import { AsyncResult } from "effect/reactivity";

import { resolveAssetUrl } from "~/assets/assetUrls";
import { isPreviewAvailableFor, previewRuntimeFor } from "~/browser/previewRuntime";
import { makeRoomForPage } from "~/tempo/browser/pageRoom";
import { readLocalApi } from "~/localApi";
import {
  applyPreviewServerSnapshot,
  readThreadPreviewState,
  rememberPreviewUrl,
  setActivePreviewTab,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { selectSelectedRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

import { resolveBrowserDefaults } from "./browserDefaults";
import {
  type LinkOrigin,
  resolveBrowserLinkTargetPreference,
  resolveLinkTarget,
} from "./browserLinkTarget";

export const isBrowserPreviewFile = (path: string): boolean =>
  /\.(?:html?|pdf)$/i.test(path.split(/[?#]/, 1)[0] ?? "");

export class BrowserPreviewUnavailableError extends Data.TaggedError(
  "BrowserPreviewUnavailableError",
)<{
  readonly message: string;
}> {}

export class BrowserSettingsReadError extends Data.TaggedError("BrowserSettingsReadError")<{
  readonly cause: unknown;
}> {
  override get message(): string {
    return "Saved browser settings could not be loaded.";
  }
}

export type OpenPreviewMutation<E = unknown> = (input: {
  readonly environmentId: EnvironmentId;
  readonly input: PreviewOpenInput;
}) => Promise<AtomCommandResult<PreviewSessionSnapshot, E>>;

export async function openUrlInPreview<E>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly url: string;
  readonly openPreview: OpenPreviewMutation<E>;
  readonly profileId?: PreviewOpenInput["profileId"];
  readonly background?: boolean;
  /** tempo: false for what is not a page, such as an image, which keeps the panel's width. */
  readonly page?: boolean;
}): Promise<AtomCommandResult<void, E | BrowserSettingsReadError>> {
  const defaults = await resolveBrowserDefaults().catch(
    (cause: unknown) => new BrowserSettingsReadError({ cause }),
  );
  if (defaults instanceof BrowserSettingsReadError) {
    return AsyncResult.failure(Cause.fail(defaults));
  }
  const runtime = previewRuntimeFor(input.threadRef.environmentId);
  const previousActiveTabId = readThreadPreviewState(input.threadRef).activeTabId;
  // The server changes the active tab, not panel selection; selection changes come from the user.
  const selectedSurface = () =>
    selectSelectedRightPanelSurface(useRightPanelStore.getState().byThreadKey, input.threadRef)
      ?.id ?? null;
  const surfaceBeforeOpen = selectedSurface();
  const result = await input.openPreview({
    environmentId: input.threadRef.environmentId,
    input: {
      threadId: input.threadRef.threadId,
      url: input.url,
      viewport: defaults.viewport,
      profileId: input.profileId ?? defaults.profileId,
      ...(runtime === undefined ? {} : { runtime }),
    },
  });
  return mapAtomCommandResult(result, (snapshot) => {
    rememberPreviewUrl(input.threadRef, input.url);
    if (input.background) {
      updatePreviewServerSnapshot(input.threadRef, snapshot);
      // Restore focus unless the user picked a tab while opening this one.
      if (
        previousActiveTabId &&
        readThreadPreviewState(input.threadRef).activeTabId === snapshot.tabId &&
        selectedSurface() === surfaceBeforeOpen
      ) {
        setActivePreviewTab(input.threadRef, previousActiveTabId);
      }
      return;
    }
    applyPreviewServerSnapshot(input.threadRef, snapshot);
    // tempo: a page opened from a click gets room in the tempo look.
    if (input.page !== false) makeRoomForPage(input.threadRef, snapshot.tabId);
    useRightPanelStore.getState().openBrowser(input.threadRef, snapshot.tabId);
  });
}

export async function openFileInPreview<AssetError, PreviewError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
  readonly openPreview: OpenPreviewMutation<PreviewError>;
}): Promise<
  AtomCommandResult<
    void,
    AssetError | PreviewError | BrowserPreviewUnavailableError | BrowserSettingsReadError
  >
> {
  if (!isPreviewAvailableFor(input.threadRef.environmentId)) {
    return AsyncResult.failure(
      Cause.fail(
        new BrowserPreviewUnavailableError({
          message: "The integrated browser is unavailable in this runtime.",
        }),
      ),
    );
  }
  const assetUrl = await createFileAssetUrl(input);
  if (assetUrl._tag === "Failure") return AsyncResult.failure(assetUrl.cause);
  return openUrlInPreview({
    threadRef: input.threadRef,
    url: assetUrl.value,
    openPreview: input.openPreview,
  });
}

/**
 * tempo: opens a file at its asset address, where a link to that address opens. The address carries
 * its own token, so any browser on this Mac can load it.
 */
export async function openFileInLinkTarget<AssetError, PreviewError>(
  input: Parameters<typeof openFileInPreview<AssetError, PreviewError>>[0] & {
    readonly origin: LinkOrigin;
  },
): ReturnType<typeof openFileInPreview<AssetError, PreviewError>> {
  const assetUrl = await createFileAssetUrl(input);
  if (assetUrl._tag === "Failure") return AsyncResult.failure(assetUrl.cause);
  const target = resolveLinkTarget({
    url: assetUrl.value,
    origin: input.origin,
    preference: await resolveBrowserLinkTargetPreference(),
    canOpenInApp: isPreviewAvailableFor(input.threadRef.environmentId),
  });
  if (target === "app") {
    return openUrlInPreview({
      threadRef: input.threadRef,
      url: assetUrl.value,
      openPreview: input.openPreview,
    });
  }
  const api = readLocalApi();
  if (!api) throw new Error("Link opening is unavailable.");
  await api.shell.openExternal(assetUrl.value);
  return AsyncResult.success(undefined);
}

async function createFileAssetUrl<AssetError>(input: {
  readonly threadRef: ScopedThreadRef;
  readonly filePath: string;
  readonly workspaceRoot: string | undefined;
  readonly httpBaseUrl: string;
  readonly createAssetUrl: (input: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly resource: AssetResource };
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, AssetError>>;
}): Promise<AtomCommandResult<string, AssetError>> {
  const insideWorkspace =
    mediaFileReference(input.filePath, input.workspaceRoot).relativePath !== undefined;
  const assetResult = await input.createAssetUrl({
    environmentId: input.threadRef.environmentId,
    input: {
      resource: {
        _tag: insideWorkspace ? "workspace-file" : "media-file",
        threadId: input.threadRef.threadId,
        path: input.filePath,
      },
    },
  });
  if (assetResult._tag === "Failure") return AsyncResult.failure(assetResult.cause);
  const assetUrl = resolveAssetUrl(input.httpBaseUrl, assetResult.value.relativeUrl);
  return assetUrl === null
    ? AsyncResult.failure(Cause.die(new Error("The environment returned an invalid asset URL.")))
    : AsyncResult.success(assetUrl);
}
