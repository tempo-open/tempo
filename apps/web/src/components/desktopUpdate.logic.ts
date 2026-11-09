import type { DesktopUpdateActionResult, DesktopUpdateState } from "@t3tools/contracts";
import {
  TEMPO_APP_BASE_NAME,
  TEMPO_RELEASE_REPOSITORY_URL,
  TEMPO_RELEASE_TAG_PREFIX,
} from "@t3tools/shared/tempoBrand";

export type DesktopUpdateButtonAction = "download" | "install" | "none";

const GITHUB_REPOSITORY_SEGMENT = /^[A-Za-z0-9._-]+$/u;

function isValidRepositorySegment(value: string | undefined): value is string {
  return (
    value !== undefined && value !== "." && value !== ".." && GITHUB_REPOSITORY_SEGMENT.test(value)
  );
}

/**
 * tempo: history is the whole releases page: GitHub's release search matches loosely, so no URL
 * lists Tempo's releases alone. Null when neither the build nor this app names a repository.
 */
function desktopReleaseRepositoryUrl(repository: string | undefined): string | null {
  const configuredRepository = repository?.trim() ?? "";
  const [owner, name, ...extra] = configuredRepository.split("/");
  const repositoryUrl =
    isValidRepositorySegment(owner) && isValidRepositorySegment(name) && extra.length === 0
      ? `https://github.com/${configuredRepository}`
      : TEMPO_RELEASE_REPOSITORY_URL;
  return repositoryUrl === null ? null : `${repositoryUrl}/releases`;
}

/** The download RPC can beat the updater's downloadedVersion event; fall back to the requested version. */
export function getDesktopUpdateDownloadedVersion(state: DesktopUpdateState): string | null {
  return state.downloadedVersion ?? state.availableVersion;
}

export function getDesktopUpdateReleaseUrl(
  version: string | null,
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  const normalizedVersion = version?.trim();
  const releasesUrl = desktopReleaseRepositoryUrl(repository);
  if (!normalizedVersion || releasesUrl === null) return null;
  return `${releasesUrl}/tag/${TEMPO_RELEASE_TAG_PREFIX}${encodeURIComponent(normalizedVersion)}`;
}

export function getDesktopUpdateReleaseHistoryUrl(
  repository: string | undefined = import.meta.env.T3CODE_DESKTOP_UPDATE_REPOSITORY,
): string | null {
  return desktopReleaseRepositoryUrl(repository);
}

export function resolveDesktopUpdateButtonAction(
  state: DesktopUpdateState,
): DesktopUpdateButtonAction {
  if (
    state.downloadedVersion &&
    (state.status === "downloaded" ||
      (state.status === "error" &&
        (state.errorContext === null || state.errorContext === "install")))
  ) {
    return "install";
  }
  if (state.status === "available") {
    return "download";
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return "download";
    }
  }
  return "none";
}

export function shouldShowArm64IntelBuildWarning(state: DesktopUpdateState | null): boolean {
  return state?.hostArch === "arm64" && state.appArch === "x64";
}

export function isDesktopUpdateButtonDisabled(state: DesktopUpdateState | null): boolean {
  return state?.status === "downloading";
}

export function getArm64IntelBuildWarningDescription(state: DesktopUpdateState): string {
  if (!shouldShowArm64IntelBuildWarning(state)) {
    return "This install is using the correct architecture.";
  }

  const action = resolveDesktopUpdateButtonAction(state);
  if (action === "download") {
    return `This Mac has Apple Silicon, but ${TEMPO_APP_BASE_NAME} is still running the Intel build under Rosetta. Download the available update to switch to the native Apple Silicon build.`;
  }
  if (action === "install") {
    return `This Mac has Apple Silicon, but ${TEMPO_APP_BASE_NAME} is still running the Intel build under Rosetta. Restart to install the downloaded Apple Silicon build.`;
  }
  return `This Mac has Apple Silicon, but ${TEMPO_APP_BASE_NAME} is still running the Intel build under Rosetta. The next app update will replace it with the native Apple Silicon build.`;
}

/**
 * Why a quiet update state has nothing to offer, when the desktop gave a reason:
 * for example a build that gets no updates at all.
 */
export function getDesktopUpdateNotice(
  state: Pick<DesktopUpdateState, "status" | "message"> | null,
): string | null {
  if (
    state === null ||
    (state.status !== "idle" && state.status !== "up-to-date" && state.status !== "disabled")
  ) {
    return null;
  }
  const message = state.message?.trim();
  return message ? message : null;
}

export function getDesktopUpdateButtonTooltip(state: DesktopUpdateState): string {
  if (
    state.notAppliedVersion !== undefined &&
    (state.status === "available" || state.status === "downloaded") &&
    getDesktopUpdateDownloadedVersion(state) === state.notAppliedVersion
  ) {
    return `Update ${state.notAppliedVersion} did not apply. Click to retry.`;
  }
  if (state.status === "available") {
    return `Update ${state.availableVersion ?? "available"} ready to download`;
  }
  if (state.status === "downloading") {
    const progress =
      typeof state.downloadPercent === "number" ? ` (${Math.floor(state.downloadPercent)}%)` : "";
    return `Downloading update${progress}`;
  }
  if (state.status === "downloaded") {
    return `Update ${state.downloadedVersion ?? state.availableVersion ?? "ready"} downloaded. Click to restart and install.`;
  }
  if (state.status === "error") {
    if (state.errorContext === "download" && state.availableVersion) {
      return `Download failed for ${state.availableVersion}. Click to retry.`;
    }
    if (state.errorContext === "install" && state.downloadedVersion) {
      return `Install failed for ${state.downloadedVersion}. Click to retry.`;
    }
    if (state.downloadedVersion) {
      return `Update ${state.downloadedVersion} downloaded. Click to restart and install.`;
    }
    return state.message ?? "Update failed";
  }
  return getDesktopUpdateNotice(state) ?? "Up to date";
}

export function getDesktopUpdateActionError(result: DesktopUpdateActionResult): string | null {
  if (!result.accepted || result.completed) return null;
  if (typeof result.state.message !== "string") return null;
  const message = result.state.message.trim();
  return message.length > 0 ? message : null;
}

export function shouldToastDesktopUpdateActionResult(result: DesktopUpdateActionResult): boolean {
  return getDesktopUpdateActionError(result) !== null;
}

export function canCheckForUpdate(state: DesktopUpdateState | null): boolean {
  if (!state || !state.enabled) return false;
  return (
    state.status !== "checking" && state.status !== "downloading" && state.status !== "disabled"
  );
}

export function getDesktopUpdateDisabledReason(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
): string | null {
  if (!state || (state.enabled && state.status !== "disabled")) return null;
  return state.message?.trim() || "Automatic updates are not available in this build.";
}

export function getDesktopUpdateIdleTooltip(
  state: Pick<DesktopUpdateState, "enabled" | "status" | "message"> | null,
) {
  const disabledReason = getDesktopUpdateDisabledReason(state);
  return disabledReason
    ? { title: "Updates unavailable", detail: disabledReason }
    : // tempo: a skipped check says why, such as a build that gets no updates.
      { title: "Check for updates", detail: getDesktopUpdateNotice(state) };
}
