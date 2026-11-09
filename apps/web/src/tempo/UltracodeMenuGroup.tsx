import {
  MenuGroup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
} from "../components/ui/menu";
import { isUltracodeToggleAvailable, requestUltracodeToggle } from "./ultracodeToggleBus";

/**
 * Ultracode in the traits menu and the compact controls menu. It flips the
 * composer's own toggle, so it is never remembered for new threads, and it only
 * shows while that toggle can flip (the model offers it and workflows are on).
 */
export function UltracodeMenuGroup(props: {
  readonly enabled: boolean;
  readonly withDivider: boolean;
}) {
  if (!isUltracodeToggleAvailable()) return null;
  return (
    <div>
      {props.withDivider ? <MenuDivider /> : null}
      <MenuGroup>
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Ultracode</div>
        <MenuRadioGroup
          value={props.enabled ? "on" : "off"}
          onValueChange={(value) => {
            if ((value === "on") !== props.enabled) requestUltracodeToggle();
          }}
        >
          {(["on", "off"] as const).map((value) => (
            <MenuRadioItem key={value} value={value} hideIndicator closeOnClick>
              {value === "on" ? "On" : "Off"}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuGroup>
    </div>
  );
}
