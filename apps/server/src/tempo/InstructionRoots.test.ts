import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  CodexSettings,
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import { deriveProviderInstanceConfigMap } from "../provider/ProviderInstanceRegistryHydration.ts";
import {
  encodeClaudeProjectDirName,
  ensurePersonalInstructions,
  parseCodexProjectDocConfig,
  personalInstructionsState,
  resolveClaudeMemoryDir,
  resolveCodexInstructionHome,
  resolveInstructionHomes,
  stripPersonalInstructionsBlock,
} from "./InstructionRoots.ts";

const tempDir = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-instruction-roots-" }),
  );
});

const writeFile = Effect.fn(function* (file: string, content: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, content);
});

const decodeCodexSettings = Schema.decodeSync(CodexSettings);

describe("resolveInstructionHomes", () => {
  it.effect("resolves default, configured, and inherited homes for enabled instances", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const homes = yield* resolveInstructionHomes(
        deriveProviderInstanceConfigMap({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("claude_second")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              config: { homePath: "~/.claude-second" },
            },
            [ProviderInstanceId.make("codex_off")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: false,
              config: { homePath: "~/.codex-off" },
            },
            [ProviderInstanceId.make("cursor")]: { driver: ProviderDriverKind.make("cursor") },
          },
        }),
        `${home}/state`,
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, { CODEX_HOME: "~/custom-codex" }),
      );
      const resolved = homes.map(({ provider, home: dir, instanceIds }) => [
        provider,
        dir,
        instanceIds,
      ]);
      expect(resolved).toHaveLength(3);
      expect(resolved).toEqual(
        expect.arrayContaining([
          ["claude", `${home}/.claude-second`, ["claude_second"]],
          ["claude", `${home}/.claude`, ["claudeAgent"]],
          // No CODEX_HOME configured: Codex inherits the server's.
          ["codex", `${home}/custom-codex`, ["codex"]],
        ]),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("reads a shadow Codex home's instructions from its shared home", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const homes = yield* resolveInstructionHomes(
        deriveProviderInstanceConfigMap({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              config: { homePath: "~/.codex", shadowHomePath: "~/.codex-shadow" },
            },
          },
        }),
        `${home}/state`,
      ).pipe(
        Effect.provideService(HostProcess.HomeDirectory, home),
        Effect.provideService(HostProcess.Environment, {}),
      );
      expect(homes.find((entry) => entry.provider === "codex")?.home).toBe(`${home}/.codex`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("resolveCodexInstructionHome", () => {
  it.effect("reads a managed account's instructions from the shared home its shadow links", () =>
    Effect.gen(function* () {
      const home = yield* tempDir();
      const config = decodeCodexSettings({ setupMode: "managed" });
      const resolve = (id: string) =>
        resolveCodexInstructionHome(ProviderInstanceId.make(id), config, {}, `${home}/state`).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
        );
      expect(yield* resolve("codex")).toBe(`${home}/.codex`);
      expect(yield* resolve("codex_work")).toBe(`${home}/.codex`);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("ensurePersonalInstructions", () => {
  it.effect("imports the person's CLAUDE.md into a tempo home and removes it when turned off", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* tempDir();
      const personalDir = `${root}/me/.claude`;
      const home = `${root}/tempo/provider-homes/claude`;
      yield* writeFile(`${personalDir}/CLAUDE.md`, "Use pnpm.\n");
      yield* writeFile(`${home}/CLAUDE.md`, "# Company rules\n");
      const input = { provider: "claude" as const, home, personalDir, baseDir: `${root}/tempo` };

      yield* ensurePersonalInstructions({ ...input, enabled: true });
      const included = yield* fileSystem.readFileString(`${home}/CLAUDE.md`);
      expect(included).toContain(`\n@${personalDir}/CLAUDE.md\n`);
      expect(included.endsWith("# Company rules\n")).toBe(true);
      // Applying twice changes nothing.
      yield* ensurePersonalInstructions({ ...input, enabled: true });
      expect(yield* fileSystem.readFileString(`${home}/CLAUDE.md`)).toBe(included);
      expect(yield* personalInstructionsState({ ...input, enabled: true })).toBe("included");

      yield* ensurePersonalInstructions({ ...input, enabled: false });
      expect(yield* fileSystem.readFileString(`${home}/CLAUDE.md`)).toBe("# Company rules\n");
      expect(yield* personalInstructionsState({ ...input, enabled: false })).toBe("excluded");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "links the person's AGENTS.md into a tempo Codex home but never replaces a real file",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const root = yield* tempDir();
        const personalDir = `${root}/me/.codex`;
        const home = `${root}/tempo/provider-homes/codex`;
        yield* writeFile(`${personalDir}/AGENTS.md`, "Be brief.\n");
        yield* writeFile(`${personalDir}/auth.json`, "{}");
        const input = { provider: "codex" as const, home, personalDir, baseDir: `${root}/tempo` };

        yield* ensurePersonalInstructions({ ...input, enabled: true });
        expect(yield* fileSystem.readLink(`${home}/AGENTS.md`)).toBe(`${personalDir}/AGENTS.md`);
        expect(yield* fileSystem.exists(`${home}/auth.json`)).toBe(false);

        yield* ensurePersonalInstructions({ ...input, enabled: false });
        expect(yield* fileSystem.exists(`${home}/AGENTS.md`)).toBe(false);

        // The person's override is what Codex reads for them, so that is what gets linked.
        yield* writeFile(`${personalDir}/AGENTS.override.md`, "Override.\n");
        yield* ensurePersonalInstructions({ ...input, enabled: true });
        expect(yield* fileSystem.readLink(`${home}/AGENTS.md`)).toBe(
          `${personalDir}/AGENTS.override.md`,
        );
        expect(yield* personalInstructionsState({ ...input, enabled: true })).toBe("included");
        yield* ensurePersonalInstructions({ ...input, enabled: false });
        expect(yield* fileSystem.exists(`${home}/AGENTS.md`)).toBe(false);

        yield* writeFile(`${home}/AGENTS.md`, "Company Codex rules\n");
        yield* ensurePersonalInstructions({ ...input, enabled: true });
        expect(yield* fileSystem.readFileString(`${home}/AGENTS.md`)).toBe("Company Codex rules\n");
        // Tempo's own file keeps the person's out, and the page says so.
        expect(yield* personalInstructionsState({ ...input, enabled: true })).toBe("blocked");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("leaves homes outside the server's base directory alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const root = yield* tempDir();
      const personalDir = `${root}/me/.claude`;
      const home = `${root}/me/.claude-second`;
      yield* writeFile(`${personalDir}/CLAUDE.md`, "Use pnpm.\n");
      const input = { provider: "claude" as const, home, personalDir, baseDir: `${root}/tempo` };
      yield* ensurePersonalInstructions({ ...input, enabled: true });
      expect(yield* fileSystem.exists(`${home}/CLAUDE.md`)).toBe(false);
      expect(yield* personalInstructionsState({ ...input, enabled: true })).toBe("excluded");
      expect(
        yield* personalInstructionsState({ ...input, home: personalDir, enabled: false }),
      ).toBe("direct");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("strips only the managed block", () => {
    expect(stripPersonalInstructionsBlock("no block\n")).toBe("no block\n");
  });
});

describe("Claude auto memory folder", () => {
  it("encodes the project path the way Claude Code names it", () => {
    expect(encodeClaudeProjectDirName("/Users/ada/.t3/worktrees/tempo/t3-0a1b2c3d")).toBe(
      "-Users-ada--t3-worktrees-tempo-t3-0a1b2c3d",
    );
  });

  it.effect("keys worktrees by their main checkout and honours the config folder", () =>
    Effect.gen(function* () {
      const root = yield* tempDir();
      const main = `${root}/repo`;
      const worktree = `${root}/worktrees/feature`;
      yield* writeFile(`${main}/.git/worktrees/feature/commondir`, "../..\n");
      yield* writeFile(`${worktree}/.git`, `gitdir: ${main}/.git/worktrees/feature\n`);
      const memory = yield* resolveClaudeMemoryDir({
        configDir: `${root}/.claude`,
        cwd: `${worktree}`,
        environment: {},
      });
      expect(memory).toEqual({
        directory: `${root}/.claude/projects/${encodeClaudeProjectDirName(main)}/memory`,
        enabled: true,
      });

      yield* writeFile(
        `${root}/.claude/settings.json`,
        JSON.stringify({ autoMemoryEnabled: false, autoMemoryDirectory: "~/memories" }),
      );
      const custom = yield* resolveClaudeMemoryDir({
        configDir: `${root}/.claude`,
        cwd: main,
        environment: {},
      }).pipe(Effect.provideService(HostProcess.HomeDirectory, root));
      expect(custom).toEqual({ directory: `${root}/memories`, enabled: false });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("parseCodexProjectDocConfig", () => {
  it("reads top-level project doc keys and ignores tables", () => {
    expect(
      parseCodexProjectDocConfig(
        [
          'model = "gpt-5"',
          "project_doc_max_bytes = 65_536 # bigger",
          'project_doc_fallback_filenames = ["TEAM_GUIDE.md",',
          "  '.agents.md']",
          "project_root_markers = []",
          "[profiles.work]",
          "project_doc_max_bytes = 1",
        ].join("\n"),
      ),
    ).toEqual({
      maxBytes: 65_536,
      fallbackFilenames: ["TEAM_GUIDE.md", ".agents.md"],
      rootMarkers: [],
    });
  });

  it("drops fallback names that are not plain file names, as Codex does", () => {
    expect(
      parseCodexProjectDocConfig(
        'project_doc_fallback_filenames = ["../secret.md", "a/b.md", "..", ".", "AGENTS.md", "GUIDE.md"]',
      ).fallbackFilenames,
    ).toEqual(["GUIDE.md"]);
  });
});
