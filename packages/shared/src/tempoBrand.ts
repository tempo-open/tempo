/**
 * Tempo's identity. It installs beside T3 Code, so every name, id, scheme, data home, port and
 * release feed that could collide with T3's comes from here; `.mjs` launchers and native config
 * repeat the values they need.
 */

/** Product name shown in titles, menus, and settings. */
export const TEMPO_APP_BASE_NAME = "Tempo";
/**
 * Renames upstream's agent-facing "T3" and "T3 Code" to Tempo in MCP tool text, provider
 * instructions and work-log labels. Identifiers (`t3-code`, `t3_thread_launch`) and T3 Connect,
 * upstream's relay, keep their names. User-data text (a pull request update) keeps its "T3".
 */
export const tempoAgentText = (text: string): string =>
  text.replaceAll(/\bT3(?: Code)?\b(?! Connect\b)/g, TEMPO_APP_BASE_NAME);

/** Desktop app id and mobile bundle id. Variants append `.dev`, `.preview`, `.nightly`. */
export const TEMPO_APP_ID = "local.tempo.app";
/** launchd label and service id of the background server, distinct from the app id. */
export const TEMPO_SERVICE_ID = `${TEMPO_APP_ID}.service`;

/** Deep-link and desktop renderer schemes. */
export const TEMPO_URL_SCHEME = "tempo";
export const TEMPO_DEV_URL_SCHEME = "tempo-dev";

/**
 * Linux desktop identity: the per-user URL-handler entry (`local.tempo.Tempo.desktop`, also the
 * Wayland app id and SnapShot bus name prefix) and the window class / packaged executable
 * (`tempo`). Sharing T3 Code's (`com.t3tools.T3Code`, `t3code`) would route one app's deep links
 * and sign-in callbacks to the other. Development builds append `.Development` and `-dev`.
 */
export const TEMPO_LINUX_DESKTOP_ID = "local.tempo.Tempo";
export const TEMPO_LINUX_WM_CLASS = "tempo";

/** The CLI binary. Tempo never installs a `t3` command. */
export const TEMPO_CLI_NAME = "tempo";

/** Default data home under the user's home directory (`~/.tempo`). */
export const TEMPO_HOME_DIR_NAME = ".tempo";
/** Tempo's own home override. `T3CODE_HOME` is still honoured when this is unset. */
export const TEMPO_HOME_ENV = "TEMPO_HOME";
/** Official T3 Code's default data home. Tempo never writes there, but dev tooling may read from it. */
export const T3_HOME_DIR_NAME = ".t3";

/**
 * The live installs on this machine: Tempo's home first, then T3 Code's. Dev tooling refuses to
 * write to either and seeds from the first one that has data.
 */
export const liveHomeDirs = (userHomeDir: string): ReadonlyArray<string> => [
  `${userHomeDir}/${TEMPO_HOME_DIR_NAME}`,
  `${userHomeDir}/${T3_HOME_DIR_NAME}`,
];

/**
 * GitHub repository (`owner/name`) whose releases feed desktop updates and server self-updates.
 * Empty: this build gets no updates, and nothing links to releases or issues.
 */
export const TEMPO_RELEASE_REPOSITORY: string = "";
/** The release repository's page, or null when this build has no release feed. */
export const TEMPO_RELEASE_REPOSITORY_URL: string | null =
  TEMPO_RELEASE_REPOSITORY === "" ? null : `https://github.com/${TEMPO_RELEASE_REPOSITORY}`;
/** Tempo's release tags are `tempo-v<version>`, apart from upstream T3 Code's `v<version>` tags. */
export const TEMPO_RELEASE_TAG_PREFIX = "tempo-v";

/**
 * Default server port. T3 Code defaults to 3773 and scans upward, so Tempo starts 100 higher to
 * keep the two installs on stable, distinct ports when both run at once.
 */
export const TEMPO_DEFAULT_SERVER_PORT = 3873;

/**
 * Default Tailscale Serve HTTPS port. T3 Code serves on 443, and starting or stopping one app's
 * mapping would take over or remove the other's, so Tempo uses 8443 (Serve allows 443, 8443, 10000).
 */
export const TEMPO_DEFAULT_TAILSCALE_SERVE_PORT = 8443;

/**
 * Lets `TEMPO_HOME` stand in for `T3CODE_HOME`. Every reader of the data home (CLI, server,
 * desktop, service units) uses `T3CODE_HOME`, so entry points copy `TEMPO_HOME` over it once at
 * startup; children inherit the result. `TEMPO_HOME` wins when both are set.
 */
export function applyTempoHomeEnv(env: Record<string, string | undefined>): void {
  const tempoHome = env[TEMPO_HOME_ENV]?.trim();
  if (tempoHome) env["T3CODE_HOME"] = tempoHome;
}
