import type { TempoHomeBackground, TempoHomeWidget } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";
import { UploadIcon } from "lucide-react";
import { useRef, useState, type ChangeEvent } from "react";

import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import { SettingsGroup } from "~/components/settings/SettingsGroup";
import { Button } from "~/components/ui/button";
import { Switch } from "~/components/ui/switch";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { updateClientSettings, useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { SettingsSegmented } from "../settings/SettingsSegmented";

import { HomeArtCanvas } from "./HomeBackdrop";
import { resolveHomeArt, type HomeArt, type HomeTheme, type PaintedHomeArt } from "./homeArt";
import { toggleHomeWidget } from "./homeAppearance.logic";
import {
  ownPictureInBrowser,
  removeOwnPicture,
  saveOwnPicture,
  useOwnPicture,
} from "./homePicture";
import { HomePreview } from "./HomePreview";

type Background = Exclude<TempoHomeBackground, "auto">;

const BACKGROUNDS: ReadonlyArray<readonly [Background, string]> = [
  ["beam", "Tempo light"],
  ["crossing", "The crossing"],
  ["trefoil", "The Trefoil"],
  ["plain", "Plain"],
  ["picture", "Your own picture"],
];

const WIDGETS: ReadonlyArray<readonly [TempoHomeWidget, string]> = [
  ["limit", "Claude limit"],
  ["activity", "Activity"],
  ["pullRequests", "Pull requests"],
  ["month", "This month"],
];

const selectHomeSettings = (settings: ClientSettings) => ({
  tempoHomeBackground: settings.tempoHomeBackground,
  tempoHomeDots: settings.tempoHomeDots,
  tempoHomePictureEffect: settings.tempoHomePictureEffect,
  tempoHomePictureColors: settings.tempoHomePictureColors,
  tempoHomeWidgets: settings.tempoHomeWidgets,
  tempoHomePlace: settings.tempoHomePlace,
  tempoSidebarLight: settings.tempoSidebarLight,
});

/** The background the home shows: auto and a missing picture resolve to the light they paint. */
function shownBackground(art: HomeArt, background: TempoHomeBackground): Background {
  if (art.kind === "light") return art.light;
  if (art.kind === "picture") return "picture";
  return background === "picture" ? "picture" : "plain";
}

type HomeSettings = ReturnType<typeof selectHomeSettings>;

/** The row's reset button, shown while its setting differs from the default. */
function resetAction(settings: HomeSettings, key: keyof HomeSettings, label: string) {
  if (Equal.equals(settings[key], DEFAULT_CLIENT_SETTINGS[key])) return null;
  const patch = { [key]: DEFAULT_CLIENT_SETTINGS[key] } as Pick<ClientSettings, typeof key>;
  return <SettingResetButton label={label} onClick={() => void updateClientSettings(patch)} />;
}

/**
 * Settings, Appearance in the tempo look: every choice for the home, with the home drawn live
 * above them; none of them sit on the home itself.
 */
export function HomeAppearanceSection() {
  const { resolvedTheme } = useTheme();
  const [previewTheme, setPreviewTheme] = useState<HomeTheme | null>(null);
  const theme = previewTheme ?? resolvedTheme;
  const settings = useClientSettings(selectHomeSettings);
  const ownPicture = useOwnPicture();
  const art = resolveHomeArt(settings, theme, ownPicture);
  const shown = shownBackground(art, settings.tempoHomeBackground);
  const fileRef = useRef<HTMLInputElement>(null);
  const tileArt = (background: Background): PaintedHomeArt | null => {
    const picture = {
      kind: "picture",
      theme,
      colors: settings.tempoHomePictureColors,
      effect: "whole",
    } as const;
    switch (background) {
      case "beam":
      case "crossing":
      case "trefoil":
        return { kind: "light", light: background, theme, dots: settings.tempoHomeDots };
      case "picture":
        return typeof ownPicture === "object"
          ? { ...picture, picture: "own", url: ownPicture.url }
          : null;
      case "plain":
        return null;
    }
  };

  const choosePicture = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    saveOwnPicture(file).then(
      () => updateClientSettings({ tempoHomeBackground: "picture" }),
      () =>
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "This picture could not be used",
            description: "Choose a PNG, JPEG, WebP or GIF file.",
          }),
        ),
    );
  };

  const pickBackground = (background: Background) => {
    if (background === "picture" && ownPicture === "none") {
      fileRef.current?.click();
      return;
    }
    if (background !== settings.tempoHomeBackground) {
      void updateClientSettings({ tempoHomeBackground: background });
    }
  };

  return (
    <SettingsSection
      id="appearance-home"
      title="Home"
      variant="plain"
      titleAction={resetAction(settings, "tempoHomeBackground", "home background")}
      headerAction={<span data-tempo-settings-aside="">Shown on every new thread</span>}
    >
      <div data-tempo-home-settings="">
        <div className="relative">
          <HomePreview theme={theme} />
          <div data-tempo-home-preview-theme="">
            <SettingsSegmented
              label="Preview theme"
              value={theme}
              options={[
                ["dark", "Dark"],
                ["light", "Light"],
              ]}
              onChange={setPreviewTheme}
            />
          </div>
        </div>
        <div role="group" aria-label="Home background" data-tempo-home-tiles="">
          {BACKGROUNDS.map(([background, label]) => {
            const thumbnail = tileArt(background);
            return (
              <button
                key={background}
                type="button"
                aria-pressed={shown === background}
                data-tempo-home-tile={background}
                data-theme={theme}
                onClick={() => pickBackground(background)}
              >
                <span>
                  {thumbnail ? (
                    <HomeArtCanvas art={thumbnail} className="absolute inset-0" />
                  ) : background === "picture" ? (
                    <UploadIcon />
                  ) : null}
                </span>
                <span>{label}</span>
              </button>
            );
          })}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            tabIndex={-1}
            onChange={choosePicture}
          />
        </div>
        <SettingsGroup>
          {art.kind === "picture" && art.picture === "own" ? (
            <SettingsRow
              title="Your picture"
              description={ownPictureInBrowser ? "Kept in this browser" : "Kept on this Mac"}
              control={
                <>
                  <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()}>
                    Replace
                  </Button>
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() =>
                      removeOwnPicture().then(
                        () => updateClientSettings({ tempoHomeBackground: "auto" }),
                        () =>
                          toastManager.add(
                            stackedThreadToast({
                              type: "error",
                              title: "This picture could not be removed",
                            }),
                          ),
                      )
                    }
                  >
                    Remove
                  </Button>
                </>
              }
            />
          ) : null}
          {art.kind === "light" ? (
            <SettingsRow
              id={searchableSetting("home-dots").id}
              title="Dots"
              description="How many stray dots the light carries"
              resetAction={resetAction(settings, "tempoHomeDots", "dots")}
              control={
                <SettingsSegmented
                  label="Dots"
                  value={settings.tempoHomeDots}
                  options={[
                    ["many", "Many"],
                    ["few", "Few"],
                    ["none", "None"],
                    ["fine", "Fine"],
                  ]}
                  onChange={(tempoHomeDots) => void updateClientSettings({ tempoHomeDots })}
                />
              }
            />
          ) : null}
          {art.kind === "picture" ? (
            <>
              <SettingsRow
                id={searchableSetting("home-picture").id}
                title="Picture"
                description="How the picture meets the page under the typing bar"
                resetAction={resetAction(settings, "tempoHomePictureEffect", "picture")}
                control={
                  <SettingsSegmented
                    label="Picture"
                    value={settings.tempoHomePictureEffect}
                    options={[
                      ["fade", "Fade"],
                      ["dissolve", "Dissolve"],
                      ["whole", "Whole picture"],
                    ]}
                    onChange={(tempoHomePictureEffect) =>
                      void updateClientSettings({ tempoHomePictureEffect })
                    }
                  />
                }
              />
              <SettingsRow
                id={searchableSetting("home-colors").id}
                title="Colors"
                description="The picture's own colors, or redrawn in Tempo blue"
                resetAction={resetAction(settings, "tempoHomePictureColors", "colors")}
                control={
                  <SettingsSegmented
                    label="Colors"
                    value={settings.tempoHomePictureColors}
                    options={[
                      ["original", "Original"],
                      ["blue", "Tempo blue"],
                    ]}
                    onChange={(tempoHomePictureColors) =>
                      void updateClientSettings({ tempoHomePictureColors })
                    }
                  />
                }
              />
            </>
          ) : null}
          <SettingsRow
            id={searchableSetting("home-widgets").id}
            title="Widgets"
            description="Shown under the typing bar"
            resetAction={resetAction(settings, "tempoHomeWidgets", "widgets")}
            control={
              <div role="group" aria-label="Widgets" data-tempo-home-chips="">
                {WIDGETS.map(([widget, label]) => {
                  const next = toggleHomeWidget(settings.tempoHomeWidgets, widget);
                  return (
                    <button
                      key={widget}
                      type="button"
                      aria-pressed={settings.tempoHomeWidgets.includes(widget)}
                      aria-disabled={next === null}
                      onClick={() => {
                        if (next) void updateClientSettings({ tempoHomeWidgets: next });
                      }}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            }
          />
          <SettingsRow
            id={searchableSetting("home-place").id}
            title="Place"
            description="Where the widgets sit"
            resetAction={resetAction(settings, "tempoHomePlace", "place")}
            control={
              <SettingsSegmented
                label="Place"
                value={settings.tempoHomePlace}
                options={[
                  ["under", "Under the typing bar"],
                  ["bottom", "At the bottom"],
                ]}
                onChange={(tempoHomePlace) => void updateClientSettings({ tempoHomePlace })}
              />
            }
          />
          <SettingsRow
            {...searchableSetting("sidebar-light")}
            description="Blue light behind the top of the sidebar"
            resetAction={resetAction(settings, "tempoSidebarLight", "sidebar light")}
            control={
              <Switch
                checked={settings.tempoSidebarLight}
                onCheckedChange={(checked) =>
                  void updateClientSettings({ tempoSidebarLight: Boolean(checked) })
                }
                aria-label="Sidebar light"
              />
            }
          />
        </SettingsGroup>
      </div>
    </SettingsSection>
  );
}
