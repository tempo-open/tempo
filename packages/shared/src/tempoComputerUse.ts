/**
 * tempo: computer use never controls Tempo itself. Open Computer Use can move the app it drives
 * onto a hidden display (`window_placement: agent_display`), which would take the person's chat
 * with the agent off their screen. Computer use on the server's own machine and on the person's
 * laptop both refuse it here and leave it out of `list_apps`.
 */
import type { LaptopToolCallResult } from "@t3tools/contracts";

import { TEMPO_APP_BASE_NAME, TEMPO_APP_ID } from "./tempoBrand.ts";

const BUNDLE_ID = TEMPO_APP_ID.toLowerCase();
/** A development build's bundle id names its checkout (apps/desktop/scripts/electron-launcher.mjs). */
const DEV_BUNDLE_ID_PREFIX = `${BUNDLE_ID}.dev.`;
const APP_NAME = TEMPO_APP_BASE_NAME.toLowerCase();

/** One `list_apps` line: `<name> — <bundle id> [<markers>]`, with `--` off macOS. */
const LISTED_APP = /^(.*?)\s+(?:—|--)\s+(.+?)\s+\[[^\]]*\]$/u;

const REFUSAL = `${TEMPO_APP_BASE_NAME} is the app the user talks to you in, so computer use does not control it: that would move its window onto a hidden display, off the user's screen. For anything in ${TEMPO_APP_BASE_NAME}, such as threads, settings or browser panels, use ${TEMPO_APP_BASE_NAME}'s own tools, or ask the user.`;

/**
 * Whether an Open Computer Use `app` (an app name, bundle id or path) is Tempo, ignoring case
 * and whitespace as Open Computer Use does. Stable and nightly share one bundle id; the name is
 * "Tempo", bare or staged ("Tempo (Dev)"); a path counts by its innermost
 * `.app`. The helpers ("Tempo Helper", `<id>.helper`) own no windows, so they are left alone.
 */
export function isOwnApp(app: string): boolean {
  const target = app.trim().toLowerCase();
  if (target === BUNDLE_ID) return true;
  if (target.startsWith(DEV_BUNDLE_ID_PREFIX)) {
    return /^[a-z0-9]+$/u.test(target.slice(DEV_BUNDLE_ID_PREFIX.length));
  }
  const bundle = target.split("/").findLast((segment) => segment.endsWith(".app"));
  const name = bundle === undefined ? target : bundle.slice(0, -".app".length);
  return name === APP_NAME || (name.startsWith(`${APP_NAME} (`) && name.endsWith(")"));
}

/** What computer use tells an agent whose call targets Tempo; undefined for any other call. */
export function ownAppComputerUseRefusal(
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  const app = args["app"];
  return typeof app === "string" && isOwnApp(app) ? REFUSAL : undefined;
}

const listsOwnApp = (line: string): boolean => {
  const listed = LISTED_APP.exec(line.trim());
  if (listed === null) return false;
  const [, name = "", bundleId = ""] = listed;
  return isOwnApp(name) || isOwnApp(bundleId);
};

/** A `list_apps` result without Tempo, so agents do not pick it; other tools' results as they are. */
export function withoutOwnApps(tool: string, result: LaptopToolCallResult): LaptopToolCallResult {
  if (tool !== "list_apps") return result;
  return {
    ...result,
    content: result.content.map((block) =>
      block.type === "text"
        ? {
            ...block,
            text: block.text
              .split("\n")
              .filter((line) => !listsOwnApp(line))
              .join("\n"),
          }
        : block,
    ),
  };
}
