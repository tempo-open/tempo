import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";
import * as Electron from "electron";

import { laptopToolDisplayText } from "../laptopTools/laptopToolConfig.ts";
import type {
  DesktopTabPasskeyAnswer,
  DesktopTabPasskeyCeremony,
} from "./DesktopTabPasskeyGate.ts";

/**
 * tempo: asks before the first passkey request for a site from a tab an agent drove
 * (`DesktopTabPasskeyGate`), as a sheet on the tab's window. The system sheet that follows names
 * only the site, so this says an agent was involved. Deny is the default so a stray Enter allows
 * nothing, and `signal` closes the sheet when the request gives up.
 */
export async function askDesktopTabPasskey(
  owner: Electron.BrowserWindow,
  prompt: { readonly rpId: string; readonly ceremony: DesktopTabPasskeyCeremony },
  signal: AbortSignal,
): Promise<DesktopTabPasskeyAnswer> {
  if (signal.aborted || owner.isDestroyed()) return "dismissed";
  const { response } = await Electron.dialog.showMessageBox(owner, {
    type: "warning",
    title: "Passkey request",
    message: `A tab an agent drove wants to ${
      prompt.ceremony === "create" ? "create a passkey for" : "sign in to"
    } ${laptopToolDisplayText(prompt.rpId, 80)} with this Mac's passkeys.`,
    detail: [
      "An agent opened this tab or acted in it. Deny this request if you did not just start this sign-in yourself.",
      `Continue opens the passkey sheet, and later requests for this site go straight to it until ${TEMPO_APP_BASE_NAME} quits. Deny, or leaving this unanswered, refuses it; after Deny, this site does not ask again for a minute.`,
    ].join("\n\n"),
    buttons: ["Deny", "Continue"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    signal,
  });
  if (signal.aborted) return "dismissed";
  return response === 1 ? "allow" : "deny";
}
