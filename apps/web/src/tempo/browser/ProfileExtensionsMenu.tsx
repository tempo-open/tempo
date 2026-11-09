import { useAtomValue } from "@effect/atom-react";
import {
  DEFAULT_BROWSER_PROFILE_ID,
  INCOGNITO_BROWSER_PROFILE_ID,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { showPreviewPopup } from "../../components/preview/showPreviewPopup";
import {
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../../components/ui/menu";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { tempoBrowserEnvironment } from "./tempoBrowserState";
import { requestProfileExtras } from "./profileExtrasRequest";

/**
 * The browser panel's More menu, profile group: the tab's profile's extensions, each opening its
 * popup or options page as a server tab the panel switches to. Tabs the desktop app draws itself
 * (Electron) say they cannot run them; incognito and an agent's throwaway tabs keep none.
 */
export function ProfileExtensionsMenu({
  threadRef,
  profileId,
  agentTab,
  serverTab,
}: {
  readonly threadRef: ScopedThreadRef;
  /** The tab's own profile; none means the default, or a throwaway one for an agent's tab. */
  readonly profileId: string | undefined;
  readonly agentTab: boolean;
  /** Whether the environment's server browser runs this tab. */
  readonly serverTab: boolean;
}) {
  const navigate = useNavigate();
  const { environmentId, threadId } = threadRef;
  const keepsData =
    profileId !== INCOGNITO_BROWSER_PROFILE_ID && !(profileId === undefined && agentTab);
  const resolvedProfileId = profileId ?? DEFAULT_BROWSER_PROFILE_ID;
  const query = useEnvironmentQuery(
    serverTab && keepsData
      ? tempoBrowserEnvironment.profile({ environmentId, input: { profileId: resolvedProfileId } })
      : null,
  );
  const canOpen = useAtomValue(
    tempoBrowserEnvironment.openExtensionPage.permissionAtom(environmentId),
  );
  const openPage = useAtomCommand(tempoBrowserEnvironment.openExtensionPage, "open extension page");
  if (!keepsData) return null;
  if (!serverTab) {
    return <MenuItem disabled>Tabs this app draws can't run extensions</MenuItem>;
  }
  const extensions = (query.data?.extensions ?? []).filter((extension) => extension.enabled);
  const open = async (extensionId: string, page: "popup" | "options") => {
    const result = await openPage({
      environmentId,
      input: { threadId, profileId: resolvedProfileId, extensionId, page },
    });
    if (result._tag === "Success") showPreviewPopup(threadRef, result.value.tabId, "panel");
  };
  return (
    <MenuSub>
      <MenuSubTrigger>Extensions</MenuSubTrigger>
      <MenuSubPopup>
        {extensions.length === 0 ? (
          <MenuItem disabled>No extensions in this profile</MenuItem>
        ) : (
          extensions.flatMap((extension) =>
            extension.popupPage === undefined && extension.optionsPage === undefined
              ? [
                  <MenuItem key={extension.id} disabled>
                    {extension.name} (no pages)
                  </MenuItem>,
                ]
              : [
                  extension.popupPage === undefined ? null : (
                    <MenuItem
                      key={`${extension.id}:popup`}
                      disabled={!canOpen}
                      onClick={() => void open(extension.id, "popup")}
                    >
                      {extension.name}
                    </MenuItem>
                  ),
                  extension.optionsPage === undefined ? null : (
                    <MenuItem
                      key={`${extension.id}:options`}
                      disabled={!canOpen}
                      onClick={() => void open(extension.id, "options")}
                    >
                      {extension.name} options
                    </MenuItem>
                  ),
                ],
          )
        )}
        <MenuSeparator />
        <MenuItem
          onClick={() => {
            requestProfileExtras(resolvedProfileId);
            void navigate({ to: "/settings/browser" });
          }}
        >
          Manage extensions and passkeys…
        </MenuItem>
      </MenuSubPopup>
    </MenuSub>
  );
}
