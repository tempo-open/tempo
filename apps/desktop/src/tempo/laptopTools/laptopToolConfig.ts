import {
  LAPTOP_BROWSER_SERVER_ID,
  LAPTOP_COMPUTER_USE_SERVER_ID,
  type DesktopLaptopToolServerConfig,
  type DesktopLaptopToolsConfig,
} from "@t3tools/contracts";

/**
 * Laptop tool configuration: the built-in servers, how a configured command
 * is checked and found on PATH, and the exact process a server launches as.
 */

const computerUse: DesktopLaptopToolServerConfig = {
  id: LAPTOP_COMPUTER_USE_SERVER_ID,
  name: "Computer use",
  command: "open-computer-use",
  args: ["mcp"],
  enabled: false,
};

/**
 * Pinned, so turning the laptop browser on runs the version this app was
 * tested with rather than whatever npm has newest that day.
 */
const CHROME_DEVTOOLS_MCP_PACKAGE = "chrome-devtools-mcp@1.10.1";

const laptopBrowser: DesktopLaptopToolServerConfig = {
  id: LAPTOP_BROWSER_SERVER_ID,
  name: "Laptop browser",
  command: "npx",
  args: ["-y", CHROME_DEVTOOLS_MCP_PACKAGE, "--no-usage-statistics"],
  enabled: false,
};

const BUILT_IN_LAPTOP_TOOL_SERVERS: ReadonlyArray<DesktopLaptopToolServerConfig> = [
  computerUse,
  laptopBrowser,
];

const builtInById = new Map(BUILT_IN_LAPTOP_TOOL_SERVERS.map((server) => [server.id, server]));

export const isBuiltInLaptopToolServer = (id: string): boolean => builtInById.has(id);

/** Everything is off until the person turns a tool on. */
export const DEFAULT_LAPTOP_TOOLS_CONFIG: DesktopLaptopToolsConfig = {
  servers: BUILT_IN_LAPTOP_TOOL_SERVERS,
  laptopBrowserUsesRealProfile: false,
};

/**
 * Built-ins always come first with the command this app ships; only their
 * on/off state is the person's. Custom servers follow in their saved order,
 * and a custom entry cannot take a built-in's id or repeat another's.
 */
export function normalizeLaptopToolsConfig(
  config: DesktopLaptopToolsConfig,
): DesktopLaptopToolsConfig {
  const saved = new Map(config.servers.map((server) => [server.id, server]));
  const servers: DesktopLaptopToolServerConfig[] = BUILT_IN_LAPTOP_TOOL_SERVERS.map((builtIn) => ({
    ...builtIn,
    enabled: saved.get(builtIn.id)?.enabled ?? false,
  }));
  const seen = new Set<string>(servers.map((server) => server.id));
  for (const server of config.servers) {
    if (seen.has(server.id)) continue;
    seen.add(server.id);
    servers.push(server);
  }
  return {
    servers,
    laptopBrowserUsesRealProfile: config.laptopBrowserUsesRealProfile,
    ...(config.answerPasskeys === undefined ? {} : { answerPasskeys: config.answerPasskeys }),
    ...(config.askBeforeUse === undefined ? {} : { askBeforeUse: config.askBeforeUse }),
  };
}

const SHELL_SYNTAX = /[;&|`$<>(){}*?!~"'\\\n\r]/u;

/**
 * Why a configured command cannot run, or undefined when it may. Commands run
 * without a shell, from no particular directory, so a command must be a name
 * found on PATH or an absolute path, and arguments belong in `args`.
 */
export function laptopToolCommandProblem(
  command: string,
  platform: NodeJS.Platform,
): string | undefined {
  const trimmed = command.trim();
  if (trimmed.length === 0) return "Enter a command.";
  if (/\s/u.test(trimmed) && !isAbsoluteCommand(trimmed, platform)) {
    return "Put arguments in Arguments, not in the command.";
  }
  const shellSyntax = platform === "win32" ? /[;&|`$<>(){}*?!~"'\n\r]/u : SHELL_SYNTAX;
  if (shellSyntax.test(trimmed)) {
    return "Commands run without a shell. Remove shell syntax such as quotes, pipes, ~ or $.";
  }
  if (!isAbsoluteCommand(trimmed, platform) && /[\\/]/u.test(trimmed)) {
    return "Use a command on PATH or an absolute path.";
  }
  return undefined;
}

function isAbsoluteCommand(command: string, platform: NodeJS.Platform): boolean {
  return platform === "win32" ? /^(?:[a-zA-Z]:[\\/]|\\\\)/u.test(command) : command.startsWith("/");
}

export interface CommandLookup {
  readonly platform: NodeJS.Platform;
  readonly pathValue: string | undefined;
  readonly pathExt?: string | undefined;
  readonly isExecutableFile: (candidate: string) => boolean;
}

/** The absolute path a command runs from, or null when it is not installed. */
export function resolveLaptopToolCommand(command: string, lookup: CommandLookup): string | null {
  const trimmed = command.trim();
  if (laptopToolCommandProblem(trimmed, lookup.platform) !== undefined) return null;
  if (isAbsoluteCommand(trimmed, lookup.platform)) {
    return lookup.isExecutableFile(trimmed) ? trimmed : null;
  }
  const separator = lookup.platform === "win32" ? ";" : ":";
  const joiner = lookup.platform === "win32" ? "\\" : "/";
  const extensions =
    lookup.platform === "win32"
      ? ["", ...(lookup.pathExt ?? ".com;.exe;.bat;.cmd").toLowerCase().split(";").filter(Boolean)]
      : [""];
  for (const rawDirectory of (lookup.pathValue ?? "").split(separator)) {
    const directory = rawDirectory.trim().replace(/[\\/]+$/u, "");
    if (directory.length === 0) continue;
    for (const extension of extensions) {
      const candidate = `${directory}${joiner}${trimmed}${extension}`;
      if (lookup.isExecutableFile(candidate)) return candidate;
    }
  }
  return null;
}

export interface LaptopToolLaunch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * The process a server starts as. The laptop browser gets its own profile
 * directory unless the person chose their real Chrome, in which case it
 * attaches to the Chrome they have open (Chrome asks them to allow that).
 */
export function laptopToolLaunch(
  server: DesktopLaptopToolServerConfig,
  resolvedCommand: string,
  options: { readonly usesRealBrowserProfile: boolean; readonly browserProfileDir: string },
): LaptopToolLaunch {
  if (server.id !== LAPTOP_BROWSER_SERVER_ID) {
    return { command: resolvedCommand, args: server.args };
  }
  return {
    command: resolvedCommand,
    args: [
      ...server.args,
      ...(options.usesRealBrowserProfile
        ? ["--autoConnect"]
        : [`--userDataDir=${options.browserProfileDir}`]),
    ],
  };
}

/** Variables every tool server gets; anything else in the app's environment stays out. */
const PASSED_ENV_NAMES = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PATH",
  "TMPDIR",
  "TERM",
  "LANG",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  // Windows
  "APPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATHEXT",
  "PROCESSOR_ARCHITECTURE",
  "PROGRAMFILES",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERNAME",
  "USERPROFILE",
]);

/**
 * The environment a tool server starts with: what a command-line program
 * needs to run (home, PATH, locale, proxies), and not the app's own
 * variables, such as `SSH_AUTH_SOCK` or keys exported in the shell that
 * started the app.
 */
export function laptopToolProcessEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const passed: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (
      PASSED_ENV_NAMES.has(name) ||
      PASSED_ENV_NAMES.has(upper) ||
      upper.startsWith("LC_") ||
      upper.startsWith("XDG_")
    ) {
      passed[name] = value;
    }
  }
  return passed;
}

/** Control, line-breaking and text-direction characters a title could hide behind. */
const isHiddenCharacter = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  code === 0x200e ||
  code === 0x200f ||
  (code >= 0x2028 && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

/**
 * Text an agent or a remote server may have chosen, made safe to show inside
 * a sentence: one line, no control or direction-changing characters, short.
 */
export function laptopToolDisplayText(value: string, maxChars = 80): string {
  const flat = Array.from(value, (character) =>
    isHiddenCharacter(character.codePointAt(0) ?? 0) ? " " : character,
  )
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
  if (flat.length === 0) return "Untitled";
  return flat.length > maxChars ? `${flat.slice(0, maxChars - 1)}…` : flat;
}
