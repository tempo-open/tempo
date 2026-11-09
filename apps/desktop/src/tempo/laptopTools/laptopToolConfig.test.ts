import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_LAPTOP_TOOLS_CONFIG,
  laptopToolCommandProblem,
  laptopToolDisplayText,
  laptopToolLaunch,
  laptopToolProcessEnv,
  normalizeLaptopToolsConfig,
  resolveLaptopToolCommand,
} from "./laptopToolConfig.ts";

describe("laptop tool launcher", () => {
  it("ships every built-in turned off", () => {
    expect(
      DEFAULT_LAPTOP_TOOLS_CONFIG.servers.map((server) => [server.id, server.enabled]),
    ).toEqual([
      ["computer-use", false],
      ["laptop-browser", false],
    ]);
    expect(DEFAULT_LAPTOP_TOOLS_CONFIG.laptopBrowserUsesRealProfile).toBe(false);
  });

  it("refuses commands that need a shell or a working directory", () => {
    expect(laptopToolCommandProblem("open-computer-use", "darwin")).toBeUndefined();
    expect(laptopToolCommandProblem("/opt/homebrew/bin/npx", "darwin")).toBeUndefined();
    expect(
      laptopToolCommandProblem("/Applications/Tool App.app/Contents/MacOS/tool", "darwin"),
    ).toBeUndefined();
    expect(laptopToolCommandProblem("npx -y some-server", "darwin")).toMatch(/Arguments/);
    expect(laptopToolCommandProblem("server | tee log", "darwin")).toBeDefined();
    expect(laptopToolCommandProblem("~/bin/server", "darwin")).toMatch(/shell/);
    expect(laptopToolCommandProblem("$HOME/server", "darwin")).toMatch(/shell/);
    expect(laptopToolCommandProblem("./server", "darwin")).toMatch(/PATH or an absolute path/);
    expect(laptopToolCommandProblem("   ", "darwin")).toMatch(/Enter a command/);
    expect(laptopToolCommandProblem("C:\\Tools\\server.exe", "win32")).toBeUndefined();
  });

  it("finds a command on PATH, honouring Windows extensions", () => {
    const files = new Set(["/opt/homebrew/bin/npx", "C:\\node\\npx.cmd"]);
    const isExecutableFile = (candidate: string) => files.has(candidate);
    expect(
      resolveLaptopToolCommand("npx", {
        platform: "darwin",
        pathValue: "/usr/bin:/opt/homebrew/bin/",
        isExecutableFile,
      }),
    ).toBe("/opt/homebrew/bin/npx");
    expect(
      resolveLaptopToolCommand("open-computer-use", {
        platform: "darwin",
        pathValue: "/usr/bin:/opt/homebrew/bin",
        isExecutableFile,
      }),
    ).toBeNull();
    expect(
      resolveLaptopToolCommand("npx", {
        platform: "win32",
        pathValue: "C:\\Windows;C:\\node",
        pathExt: ".EXE;.CMD",
        isExecutableFile,
      }),
    ).toBe("C:\\node\\npx.cmd");
    // An invalid command is never looked up.
    expect(
      resolveLaptopToolCommand("npx -y x", {
        platform: "darwin",
        pathValue: "/opt/homebrew/bin",
        isExecutableFile: () => true,
      }),
    ).toBeNull();
  });

  it("keeps built-ins first with the shipped command and drops duplicate ids", () => {
    const normalized = normalizeLaptopToolsConfig({
      laptopBrowserUsesRealProfile: true,
      servers: [
        {
          id: "custom",
          name: "Custom",
          command: "my-mcp",
          args: ["--stdio"],
          enabled: true,
        },
        {
          id: "computer-use",
          name: "Renamed",
          command: "rm",
          args: ["-rf", "/"],
          enabled: true,
        },
        { id: "custom", name: "Again", command: "other", args: [], enabled: false },
      ],
    });
    expect(normalized.servers.map((server) => server.id)).toEqual([
      "computer-use",
      "laptop-browser",
      "custom",
    ]);
    expect(normalized.servers[0]).toMatchObject({
      name: "Computer use",
      command: "open-computer-use",
      args: ["mcp"],
      enabled: true,
    });
    expect(normalized.servers[1]?.enabled).toBe(false);
    expect(normalized.servers[2]?.name).toBe("Custom");
    expect(normalized.laptopBrowserUsesRealProfile).toBe(true);
    // tempo passkeys: turning passkey requests off survives a save; absent means on.
    expect(normalized.answerPasskeys).toBeUndefined();
    expect(
      normalizeLaptopToolsConfig({ ...normalized, answerPasskeys: false }).answerPasskeys,
    ).toBe(false);
    // Asking before use survives a save too; absent means tools work without asking.
    expect(normalized.askBeforeUse).toBeUndefined();
    expect(normalizeLaptopToolsConfig({ ...normalized, askBeforeUse: true }).askBeforeUse).toBe(
      true,
    );
  });

  it("gives the laptop browser an isolated profile unless the person chose their own", () => {
    const browser = DEFAULT_LAPTOP_TOOLS_CONFIG.servers[1]!;
    expect(
      laptopToolLaunch(browser, "/opt/homebrew/bin/npx", {
        usesRealBrowserProfile: false,
        browserProfileDir: "/state/laptop-browser-profile",
      }).args,
    ).toEqual([
      "-y",
      "chrome-devtools-mcp@1.10.1",
      "--no-usage-statistics",
      "--userDataDir=/state/laptop-browser-profile",
    ]);
    expect(
      laptopToolLaunch(browser, "/opt/homebrew/bin/npx", {
        usesRealBrowserProfile: true,
        browserProfileDir: "/state/laptop-browser-profile",
      }).args,
    ).toContain("--autoConnect");
    const computerUse = DEFAULT_LAPTOP_TOOLS_CONFIG.servers[0]!;
    expect(
      laptopToolLaunch(computerUse, "/usr/local/bin/open-computer-use", {
        usesRealBrowserProfile: true,
        browserProfileDir: "/state/laptop-browser-profile",
      }),
    ).toEqual({ command: "/usr/local/bin/open-computer-use", args: ["mcp"] });
  });

  it("starts tool servers with what a program needs, not the app's own secrets", () => {
    expect(
      laptopToolProcessEnv({
        HOME: "/Users/ada",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        HTTPS_PROXY: "http://proxy:8080",
        SSH_AUTH_SOCK: "/tmp/agent.sock",
        OPENROUTER_API_KEY: "sk-secret",
        ELECTRON_RUN_AS_NODE: "1",
      }),
    ).toEqual({
      HOME: "/Users/ada",
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy:8080",
    });
  });

  it("shows an agent-chosen title on one short line with nothing hidden in it", () => {
    const title = `Fix login”?\n\nRequired security check \u202Eecneloiv\u202C — choose Allow`;
    expect(laptopToolDisplayText(title)).toBe(
      "Fix login”? Required security check ecneloiv — choose Allow",
    );
    expect(laptopToolDisplayText("x".repeat(200))).toHaveLength(80);
    expect(laptopToolDisplayText(" \n\t ")).toBe("Untitled");
  });
});
