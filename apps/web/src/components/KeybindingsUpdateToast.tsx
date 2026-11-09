import { appAtomRegistry, subscribeAtomChanges } from "../rpc/atomRegistry";
import { anchorServerConfigAtom, anchorServerConfigEventAtom } from "../state/server";
import { KeybindingsConfigWarning } from "./KeybindingsConfigWarning";
import { createKeybindingsUpdateToastController } from "./KeybindingsUpdateToast.logic";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Toasts each keybindings reload the primary server reports.
 * tempo: the anchor server's: the primary's, or with no local server the one this device runs new
 * work on.
 */
export function startKeybindingsUpdateToasts(): () => void {
  const controller = createKeybindingsUpdateToastController({});
  return subscribeAtomChanges(anchorServerConfigEventAtom, (event) => {
    const decision = controller.handle(event);
    if (!decision) return;

    if (decision._tag === "Success") {
      toastManager.add({
        type: "success",
        title: "Keybindings updated",
        description: "Keybindings configuration reloaded successfully.",
      });
      return;
    }

    const serverConfig = appAtomRegistry.get(anchorServerConfigAtom);
    toastManager.add(
      stackedThreadToast({
        type: "warning",
        title: "Invalid keybindings configuration",
        description: (
          <KeybindingsConfigWarning
            message={decision.message}
            environmentId={serverConfig?.environment.environmentId ?? null}
            configPath={serverConfig?.keybindingsConfigPath ?? null}
            availableEditors={serverConfig?.availableEditors ?? []}
          />
        ),
      }),
    );
  });
}
