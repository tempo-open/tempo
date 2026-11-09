import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { BrowserLinkTarget, DEFAULT_BROWSER_LINK_TARGET } from "@t3tools/contracts";
import { useId } from "react";

import { SettingsRow } from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { RadioGroup } from "~/components/ui/radio-group";
import { useClientSettings, useUpdatePrimarySettings } from "~/hooks/useSettings";

import { useDefaultBrowserName } from "../documentApps";

interface LinkTargetOption {
  readonly value: BrowserLinkTarget;
  readonly title: string;
  readonly description: string;
}

function options(browser: string): ReadonlyArray<LinkTargetOption> {
  return [
    {
      value: "work",
      title: `Side panel for your work, ${browser} for the rest`,
      description: `Pages a thread shares and previews running on this Mac open in a tab in the thread's side panel. Every other link opens in ${browser}.`,
    },
    {
      value: "system",
      title: browser.charAt(0).toUpperCase() + browser.slice(1),
      description: `Every link in the chat and the terminal opens in ${browser}. A page you click in the side panel still opens in the side panel.`,
    },
    {
      value: "app",
      title: "Side panel",
      description: "Every link opens in a new tab in the thread's side panel.",
    },
  ];
}

/**
 * Settings, Browser in the tempo look: where links open, as three choices in one radio group
 * (look/settings.css draws them).
 */
export function LinkTargetChoice({ disabled }: { readonly disabled: boolean }) {
  const linkTarget = useClientSettings((settings) => settings.browserLinkTarget);
  const updateSettings = useUpdatePrimarySettings();
  const browser = useDefaultBrowserName() ?? "your default browser";
  const id = useId();

  return (
    <SettingsRow
      {...searchableSetting("browser-link-target")}
      data-tempo-link-target=""
      control={<span data-tempo-settings-aside="">Where a link opens when you click it</span>}
    >
      <RadioGroup
        aria-label="Open links in"
        disabled={disabled}
        value={linkTarget}
        onValueChange={(value) => {
          const next = BrowserLinkTarget.literals.find((literal) => literal === value);
          if (next !== undefined) updateSettings({ browserLinkTarget: next });
        }}
        data-tempo-link-target-options=""
      >
        {options(browser).map((option) => (
          <RadioPrimitive.Root
            key={option.value}
            value={option.value}
            aria-labelledby={`${id}-${option.value}`}
            aria-describedby={`${id}-${option.value}-description`}
            data-tempo-link-target-option=""
          >
            <span aria-hidden data-tempo-link-target-dot="" />
            <span data-tempo-link-target-text="">
              <b id={`${id}-${option.value}`}>{option.title}</b>
              <span id={`${id}-${option.value}-description`}>{option.description}</span>
            </span>
            {option.value === DEFAULT_BROWSER_LINK_TARGET ? (
              <span data-tempo-link-target-tag="">Default</span>
            ) : null}
          </RadioPrimitive.Root>
        ))}
      </RadioGroup>
      <p data-tempo-link-target-key="">Hold ⌘ while you click a link to open it in {browser}.</p>
    </SettingsRow>
  );
}
