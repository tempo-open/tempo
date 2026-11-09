import type { RuntimeMode } from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import { ShieldIcon } from "lucide-react";

import { shortcutLabelForCommand } from "../keybindings";
import { useTempoLook } from "../tempo/look/useTempoLook";
import { primaryServerKeybindingsAtom } from "../state/server";
import { ComposerControl } from "./chat/ComposerControl";
import { runtimeModeConfig } from "./chat/runtimeModeConfig";
import { ComposerContextLabel } from "./ComposerContextLabel";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/** The new-thread strip names the permissions the first send will use; clicking opens them. */
export function ComposerContextPermissions(props: {
  runtimeMode: RuntimeMode;
  onOpen: () => void;
}) {
  const shortcutLabel = shortcutLabelForCommand(
    useAtomValue(primaryServerKeybindingsAtom),
    "composer.mode",
  );
  const look = useTempoLook();
  const { icon, label } = runtimeModeConfig[props.runtimeMode];
  // tempo: the tempo look draws Full access with a plain shield.
  const Icon = look === "tempo" && props.runtimeMode === "full-access" ? ShieldIcon : icon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size="xs"
            className="ms-auto min-w-0 shrink-0"
            aria-label={`Permissions: ${label}`}
            data-composer-context-control
            onClick={props.onOpen}
          />
        }
      >
        <Icon aria-hidden="true" className="size-3" />
        <ComposerContextLabel>{label}</ComposerContextLabel>
      </TooltipTrigger>
      <TooltipPopup>Permissions{shortcutLabel ? ` · ${shortcutLabel}` : null}</TooltipPopup>
    </Tooltip>
  );
}
