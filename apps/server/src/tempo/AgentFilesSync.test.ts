import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  AGENT_FILE_MAX_BYTES,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentFile,
  type AgentFileLink,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as AgentFilesSync from "./AgentFilesSync.ts";
import * as InstructionRoots from "./InstructionRoots.ts";

/** Windows has no executable bit to carry. */
const windowsHost = HostProcess.Platform.defaultValue() === "win32";

/** A laptop's and a host's home folders, side by side in a temporary folder. */
interface Machines {
  readonly base: string;
  readonly laptop: string;
  readonly host: string;
}

const makeMachines = Effect.fn("makeMachines")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-agent-files-" }),
  );
  return { base, laptop: `${base}/laptop`, host: `${base}/host` } satisfies Machines;
});

const write = Effect.fn("write")(function* (
  file: string,
  content: string | Uint8Array,
  mode?: number,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  if (typeof content === "string") yield* fileSystem.writeFileString(file, content);
  else yield* fileSystem.writeFile(file, content);
  if (mode !== undefined) yield* fileSystem.chmod(file, mode);
});

interface Reads {
  readonly files: Array<string>;
  readonly directories: Array<string>;
}

interface MachineOptions {
  /** The provider instances Tempo runs there; upstream hydration from settings by default. */
  readonly configMap?: ProviderInstanceConfigMap;
  /** Records each file the service reads and each folder it lists while `use` runs. */
  readonly reads?: Reads;
  /** The server's environment, such as CLAUDE_CONFIG_DIR or CODEX_HOME; none by default. */
  readonly environment?: NodeJS.ProcessEnv;
}

/** Runs `use` with the server of the machine whose home is `home`. */
const onMachine = <A, E>(
  home: string,
  use: (service: AgentFilesSync.AgentFilesSync["Service"]) => Effect.Effect<A, E>,
  options: MachineOptions = {},
) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const reads = options.reads;
    const observed =
      reads === undefined
        ? fileSystem
        : FileSystem.FileSystem.of({
            ...fileSystem,
            readFile: (file) => {
              reads.files.push(file);
              return fileSystem.readFile(file);
            },
            readDirectory: (directory, readOptions) => {
              reads.directories.push(directory);
              return fileSystem.readDirectory(directory, readOptions);
            },
          });
    const configMap = options.configMap;
    const instances =
      configMap === undefined
        ? InstructionRoots.InstructionProviderInstances.layer
        : InstructionRoots.InstructionProviderInstances.layerFrom(() => Effect.succeed(configMap));
    const layer = AgentFilesSync.layer.pipe(
      Layer.provide(instances),
      Layer.provide(ServerConfig.layerTest(home, `${home}-tempo`)),
      Layer.provide(ServerSettingsModule.layerTest()),
      Layer.provide(Layer.succeed(FileSystem.FileSystem, observed)),
    );
    return yield* Effect.gen(function* () {
      const service = yield* AgentFilesSync.AgentFilesSync;
      if (reads !== undefined) {
        reads.files.length = 0;
        reads.directories.length = 0;
      }
      return yield* use(service);
    }).pipe(Effect.provide(layer));
  }).pipe(
    Effect.provideService(HostProcess.HomeDirectory, home),
    Effect.provideService(HostProcess.Environment, options.environment ?? {}),
  );

const exportFrom = (home: string, options?: MachineOptions) =>
  onMachine(home, (service) => service.exportFiles, options);

const importInto = (
  home: string,
  files: ReadonlyArray<AgentFile>,
  options?: MachineOptions & { readonly links?: ReadonlyArray<AgentFileLink> },
) =>
  onMachine(
    home,
    (service) => service.importFiles({ files, links: options?.links ?? [] }),
    options,
  );

const text = (file: AgentFile | undefined) =>
  Buffer.from(file?.contentBase64 ?? "", "base64").toString("utf8");

const agentFile = (path: string, content: string, executable = false): AgentFile => ({
  path,
  contentBase64: Buffer.from(content).toString("base64"),
  executable,
});

const modeOf = (file: string) =>
  Effect.flatMap(FileSystem.FileSystem, (fileSystem) => fileSystem.stat(file)).pipe(
    Effect.map((info) => info.mode & 0o777),
  );

/**
 * A laptop with personal files in every folder a sync carries, and the
 * settings, credentials and other state beside them.
 */
const makeLaptop = Effect.fn("makeLaptop")(function* (machines: Machines) {
  const { laptop } = machines;
  yield* write(`${laptop}/.claude/CLAUDE.md`, "Personal rules\n");
  yield* write(`${laptop}/.codex/AGENTS.md`, "Codex rules\n");
  yield* write(`${laptop}/.codex/AGENTS.override.md`, "Codex override\n");
  yield* write(`${laptop}/.claude/skills/review/SKILL.md`, "Review skill\n");
  yield* write(`${laptop}/.claude/skills/review/scripts/run.sh`, "#!/bin/sh\necho hi\n", 0o755);
  yield* write(`${laptop}/.claude/commands/ship.md`, "Ship it\n");
  yield* write(`${laptop}/.claude/agents/reviewer.md`, "Reviewer\n");
  yield* write(`${laptop}/.claude/workflows/release.js`, "export default {}\n");
  yield* write(`${laptop}/.claude/rules/style.md`, "Use tabs\n");
  yield* write(`${laptop}/.claude/output-styles/terse.md`, "Be terse\n");
  yield* write(`${laptop}/.codex/skills/deploy/SKILL.md`, "Deploy skill\n");
  yield* write(`${laptop}/.agents/skills/shared/SKILL.md`, "Shared skill\n");
  // Never synced: settings, credentials, history, memory, plugins, Codex auth,
  // config (role files included), command rules, sessions and the prompts it no
  // longer reads, and the skills Claude and Codex keep up to date themselves.
  yield* write(`${laptop}/.claude/settings.json`, '{"env":{}}');
  yield* write(`${laptop}/.claude/settings.local.json`, "{}");
  yield* write(`${laptop}/.claude/.credentials.json`, '{"token":"secret"}');
  yield* write(`${laptop}/.claude.json`, '{"oauthAccount":{}}');
  yield* write(`${laptop}/.claude/history.jsonl`, "{}\n");
  yield* write(`${laptop}/.claude/projects/app/memory/MEMORY.md`, "Memory\n");
  yield* write(`${laptop}/.claude/agent-memory/reviewer/MEMORY.md`, "Memory\n");
  yield* write(`${laptop}/.claude/plugins/cache/tool/skills/x/SKILL.md`, "Plugin skill\n");
  yield* write(`${laptop}/.claude/skills/synced/pdf/SKILL.md`, "From claude.ai\n");
  yield* write(`${laptop}/.claude/skills/.trash/old/SKILL.md`, "From claude.ai\n");
  yield* write(`${laptop}/.codex/auth.json`, '{"token":"secret"}');
  yield* write(`${laptop}/.codex/config.toml`, 'model = "gpt"\n');
  yield* write(`${laptop}/.codex/rules/default.rules`, 'prefix_rule(pattern = ["ls"])\n');
  yield* write(`${laptop}/.codex/sessions/2026/rollout.jsonl`, "{}\n");
  yield* write(`${laptop}/.codex/agents/reviewer.toml`, 'name = "reviewer"\n');
  yield* write(`${laptop}/.codex/prompts/fix.md`, "Fix it\n");
  yield* write(`${laptop}/.codex/skills/.system/skill-creator/SKILL.md`, "Codex's own\n");
  yield* write(`${laptop}/.agents/skills/.system/imagegen/SKILL.md`, "Codex's own\n");
  yield* write(`${laptop}/.agents/.skill-lock.json`, "{}");
});

const SYNCED_PATHS = [
  ".claude/CLAUDE.md",
  ".codex/AGENTS.md",
  ".codex/AGENTS.override.md",
  ".claude/skills/review/SKILL.md",
  ".claude/skills/review/scripts/run.sh",
  ".claude/commands/ship.md",
  ".claude/agents/reviewer.md",
  ".claude/workflows/release.js",
  ".claude/output-styles/terse.md",
  ".claude/rules/style.md",
  ".codex/skills/deploy/SKILL.md",
  ".agents/skills/shared/SKILL.md",
];

/** Every folder whose files a sync carries. */
const SYNCED_FOLDERS = [
  ".claude/skills",
  ".claude/commands",
  ".claude/agents",
  ".claude/workflows",
  ".claude/output-styles",
  ".claude/rules",
  ".codex/skills",
  ".agents/skills",
];

it.layer(NodeServices.layer)("AgentFilesSync", (it) => {
  describe("exportFiles", () => {
    it.effect(
      "exports the personal instruction files and every synced folder, and reads nothing else",
      () =>
        Effect.gen(function* () {
          const machines = yield* makeMachines();
          const { base, laptop } = machines;
          yield* makeLaptop(machines);
          const review = `${laptop}/.claude/skills/review`;
          yield* write(`${review}/settings.json`, '{"token":"secret"}');
          yield* write(`${review}/node_modules/pkg/index.js`, "module.exports = 1\n");
          yield* write(`${review}/.git/HEAD`, "ref: refs/heads/main\n");
          yield* write(
            `${laptop}/.claude/agents/huge.md`,
            new Uint8Array(AGENT_FILE_MAX_BYTES + 1),
          );
          if (symlinksSupported) {
            const fileSystem = yield* FileSystem.FileSystem;
            yield* write(`${base}/outside/secret.md`, "secret\n");
            yield* fileSystem.symlink(
              `${base}/outside/secret.md`,
              `${laptop}/.claude/commands/linked.md`,
            );
          }

          const reads: Reads = { files: [], directories: [] };
          const result = yield* exportFrom(laptop, { reads });

          expect(result.files.map((file) => file.path)).toEqual(SYNCED_PATHS);
          expect(result.links).toEqual([]);
          expect(result.skipped).toEqual([
            { path: ".claude/skills/review/.git", reason: "ignored-folder" },
            { path: ".claude/skills/review/node_modules", reason: "ignored-folder" },
            { path: ".claude/skills/review/settings.json", reason: "not-allowed" },
            ...(symlinksSupported
              ? [{ path: ".claude/commands/linked.md", reason: "symlink" }]
              : []),
            { path: ".claude/agents/huge.md", reason: "too-large" },
          ]);
          const byPath = new Map(result.files.map((file) => [file.path, file] as const));
          expect(text(byPath.get(".claude/CLAUDE.md"))).toBe("Personal rules\n");
          expect(text(byPath.get(".codex/AGENTS.override.md"))).toBe("Codex override\n");
          if (!windowsHost) {
            expect(result.files.filter((file) => file.executable).map((file) => file.path)).toEqual(
              [".claude/skills/review/scripts/run.sh"],
            );
          }
          // Only the exported files were opened, and only synced folders listed,
          // never the skills Claude and Codex keep up to date themselves.
          expect(reads.files.toSorted()).toEqual(
            SYNCED_PATHS.map((file) => `${laptop}/${file}`).toSorted(),
          );
          for (const directory of reads.directories) {
            expect(
              SYNCED_FOLDERS.some(
                (folder) =>
                  directory === `${laptop}/${folder}` ||
                  directory.startsWith(`${laptop}/${folder}/`),
              ),
              directory,
            ).toBe(true);
            expect(directory, directory).not.toMatch(/\/(\.system|synced|\.trash)(\/|$)/);
          }
        }).pipe(Effect.scoped),
    );

    it.effect("skips files past 1 MB and past 20 MB in all", () =>
      Effect.gen(function* () {
        const machines = yield* makeMachines();
        const { laptop } = machines;
        const megabyte = new Uint8Array(AGENT_FILE_MAX_BYTES);
        // Twenty files fill the 20 MB a sync carries; the next one does not fit.
        for (let index = 0; index <= 20; index += 1) {
          yield* write(
            `${laptop}/.claude/skills/big/${String(index).padStart(2, "0")}.bin`,
            megabyte,
          );
        }
        yield* write(`${laptop}/.claude/skills/huge.bin`, new Uint8Array(AGENT_FILE_MAX_BYTES + 1));

        const result = yield* exportFrom(laptop);

        expect(result.files).toHaveLength(20);
        expect(result.files.at(-1)?.path).toBe(".claude/skills/big/19.bin");
        expect(result.skipped).toEqual([
          { path: ".claude/skills/big/20.bin", reason: "total-limit" },
          { path: ".claude/skills/huge.bin", reason: "too-large" },
        ]);
      }).pipe(Effect.scoped),
    );

    it.effect("reports nothing for a person without agent files", () =>
      Effect.gen(function* () {
        const { laptop } = yield* makeMachines();
        expect(yield* exportFrom(laptop)).toEqual({ files: [], links: [], skipped: [] });
      }).pipe(Effect.scoped),
    );
  });

  describe("importFiles", () => {
    it.effect("writes what differs, leaves identical files alone, and deletes nothing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const machines = yield* makeMachines();
        const { laptop, host } = machines;
        yield* makeLaptop(machines);
        yield* write(`${host}/.claude/skills/host-only.md`, "Host only\n");

        const exported = yield* exportFrom(laptop);
        const first = yield* importInto(host, exported.files);
        expect(first).toEqual({ written: SYNCED_PATHS, unchanged: [], skipped: [] });
        for (const file of SYNCED_PATHS) {
          expect(yield* fileSystem.readFileString(`${host}/${file}`)).toBe(
            yield* fileSystem.readFileString(`${laptop}/${file}`),
          );
        }
        // Nothing the laptop keeps beside them came along.
        for (const file of [
          ".claude/settings.json",
          ".claude/projects",
          ".claude/plugins",
          ".codex/auth.json",
          ".codex/config.toml",
          ".codex/rules",
          ".codex/sessions",
          ".claude/agent-memory",
          ".claude/skills/synced",
          ".claude/skills/.trash",
          ".codex/agents",
          ".codex/prompts",
          ".codex/skills/.system",
          ".agents/skills/.system",
          ".agents/.skill-lock.json",
        ]) {
          expect(yield* fileSystem.exists(`${host}/${file}`), file).toBe(false);
        }

        // The same files again write nothing.
        expect(yield* importInto(host, exported.files)).toEqual({
          written: [],
          unchanged: SYNCED_PATHS,
          skipped: [],
        });

        // An edit on the laptop replaces only that file, and the host's own file stays.
        yield* write(`${laptop}/.claude/commands/ship.md`, "Ship it carefully\n");
        const edited = yield* importInto(host, (yield* exportFrom(laptop)).files);
        expect(edited.written).toEqual([".claude/commands/ship.md"]);
        expect(edited.unchanged).toHaveLength(SYNCED_PATHS.length - 1);
        expect(yield* fileSystem.readFileString(`${host}/.claude/commands/ship.md`)).toBe(
          "Ship it carefully\n",
        );
        expect(yield* fileSystem.readFileString(`${host}/.claude/skills/host-only.md`)).toBe(
          "Host only\n",
        );
        // Each write replaced its file in one rename; no temporary file is left behind.
        expect(yield* fileSystem.readDirectory(`${host}/.claude/commands`)).toEqual(["ship.md"]);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(windowsHost)(
      "carries the executable bit, and changes only the bit when the content matches",
      () =>
        Effect.gen(function* () {
          const machines = yield* makeMachines();
          const { laptop, host } = machines;
          yield* makeLaptop(machines);
          const script = ".claude/skills/review/scripts/run.sh";

          yield* importInto(host, (yield* exportFrom(laptop)).files);
          expect((yield* modeOf(`${host}/${script}`)) & 0o111).not.toBe(0);
          expect((yield* modeOf(`${host}/.claude/skills/review/SKILL.md`)) & 0o111).toBe(0);

          const plain = agentFile(script, "#!/bin/sh\necho hi\n", false);
          expect(yield* importInto(host, [plain])).toEqual({
            written: [script],
            unchanged: [],
            skipped: [],
          });
          expect(yield* modeOf(`${host}/${script}`)).toBe(0o644);
          expect((yield* importInto(host, [plain])).unchanged).toEqual([script]);

          // A private file keeps its other bits when it becomes executable.
          yield* write(`${host}/.claude/commands/private.sh`, "echo\n", 0o600);
          yield* importInto(host, [agentFile(".claude/commands/private.sh", "echo\n", true)]);
          expect(yield* modeOf(`${host}/.claude/commands/private.sh`)).toBe(0o700);
        }).pipe(Effect.scoped),
    );

    it.effect("refuses a path a sync may not carry, and then writes nothing", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { host } = yield* makeMachines();
        const allowed = agentFile(".claude/CLAUDE.md", "Personal rules\n");
        for (const path of [
          "",
          "../escape.md",
          ".claude/../../escape.md",
          ".claude/skills/../../escape.md",
          "/etc/passwd",
          `${host}/.claude/CLAUDE.md`,
          "C:\\Users\\me\\.claude\\CLAUDE.md",
          ".claude/settings.json",
          ".claude/settings.local.json",
          ".claude/.credentials.json",
          ".claude.json",
          ".claude/history.jsonl",
          ".claude/rules",
          ".claude/projects/app/memory/MEMORY.md",
          ".claude/plugins/cache/tool/skills/x/SKILL.md",
          ".claude/output-styles/settings.json",
          ".codex/auth.json",
          ".codex/config.toml",
          ".codex/rules/default.rules",
          ".codex/sessions/2026/rollout.jsonl",
          ".codex/skills",
          ".codex/skills/.system/skill-creator/SKILL.md",
          ".codex/prompts/fix.md",
          ".codex/agents/reviewer.toml",
          ".claude/skills/synced/pdf/SKILL.md",
          ".claude/skills/.trash/old/SKILL.md",
          ".claude/agent-memory/reviewer/MEMORY.md",
          ".agents/skills",
          ".agents/skills/.system/imagegen/SKILL.md",
          ".agents/.skill-lock.json",
          ".agents/commands/ship.md",
          ".agents/skills/shared/.credentials.json",
          ".gemini/GEMINI.md",
          ".config/opencode/AGENTS.md",
          "skills/review/SKILL.md",
          ".claude/skills",
          ".claude/skills/review/settings.json",
          ".claude/skills/settings.json/SKILL.md",
          ".claude/skills/review/.credentials.json",
          ".claude/skills/review/node_modules/pkg/index.js",
          ".claude/skills/review/.git/config",
          ".claude/skills/./SKILL.md",
          ".claude/skills//SKILL.md",
          ".claude/skills/review\\..\\..\\settings.json",
        ]) {
          const failure = yield* importInto(host, [allowed, agentFile(path, "{}")]).pipe(
            Effect.flip,
          );
          expect(failure, path).toMatchObject({
            _tag: "AgentFilesError",
            path,
            reason: "not-allowed",
          });
        }
        // The allowed file listed first was never written either.
        expect(yield* fileSystem.exists(`${host}/.claude/CLAUDE.md`)).toBe(false);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "refuses a link from or to a path a sync may not carry, and then writes nothing",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { host } = yield* makeMachines();
          const allowed = agentFile(".claude/CLAUDE.md", "Personal rules\n");
          const fine: AgentFileLink = {
            path: ".claude/skills/shared",
            target: ".agents/skills/shared",
          };
          for (const [link, refused] of [
            [{ path: ".claude/settings.json", target: ".claude/skills/review/SKILL.md" }, "path"],
            [{ path: ".claude/skills", target: ".agents/skills" }, "path"],
            [{ path: "../escape", target: ".agents/skills/shared" }, "path"],
            [{ path: ".codex/skills/.system", target: ".agents/skills/shared" }, "path"],
            [{ path: ".claude/skills/shared", target: ".claude/settings.json" }, "target"],
            [{ path: ".claude/skills/shared", target: ".codex/auth.json" }, "target"],
            [{ path: ".claude/skills/shared", target: ".ssh/id_ed25519" }, "target"],
            [{ path: ".claude/skills/shared", target: "/etc/passwd" }, "target"],
            [{ path: ".claude/skills/shared", target: "../../etc/passwd" }, "target"],
            [{ path: ".claude/skills/shared", target: ".agents/skills/../../.ssh" }, "target"],
            [{ path: ".claude/skills/shared", target: ".agents/skills" }, "target"],
          ] as const) {
            const failure = yield* importInto(host, [allowed], { links: [fine, link] }).pipe(
              Effect.flip,
            );
            expect(failure, JSON.stringify(link)).toMatchObject({
              _tag: "AgentFilesError",
              path: link[refused],
              reason: "not-allowed",
            });
          }
          expect(yield* fileSystem.exists(`${host}/.claude`)).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect("refuses files over 1 MB, over 20 MB in all, or not in base64", () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { host } = yield* makeMachines();
        const megabyte = Buffer.alloc(AGENT_FILE_MAX_BYTES).toString("base64");
        const big = (index: number): AgentFile => ({
          path: `.claude/skills/big/${index}.bin`,
          contentBase64: megabyte,
          executable: false,
        });

        const tooLarge = yield* importInto(host, [
          {
            path: ".claude/skills/huge.bin",
            contentBase64: Buffer.alloc(AGENT_FILE_MAX_BYTES + 1).toString("base64"),
            executable: false,
          },
        ]).pipe(Effect.flip);
        expect(tooLarge).toMatchObject({ path: ".claude/skills/huge.bin", reason: "too-large" });

        const pastTotal = yield* importInto(
          host,
          Array.from({ length: 21 }, (_, index) => big(index)),
        ).pipe(Effect.flip);
        expect(pastTotal).toMatchObject({ path: ".claude/skills/big/20.bin", reason: "too-large" });

        const garbled = yield* importInto(host, [
          { path: ".claude/CLAUDE.md", contentBase64: "not base64!", executable: false },
        ]).pipe(Effect.flip);
        expect(garbled).toMatchObject({ path: ".claude/CLAUDE.md", reason: "not-base64" });

        expect(yield* fileSystem.exists(`${host}/.claude`)).toBe(false);
        // Exactly 20 MB is allowed.
        const full = yield* importInto(
          host,
          Array.from({ length: 20 }, (_, index) => big(index)),
        );
        expect(full.written).toHaveLength(20);
      }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "never writes through a link the host has, and reports it skipped",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { base, host } = yield* makeMachines();
          yield* fileSystem.makeDirectory(`${base}/elsewhere`, { recursive: true });
          yield* fileSystem.makeDirectory(`${host}/.claude`, { recursive: true });
          yield* fileSystem.symlink(`${base}/elsewhere`, `${host}/.claude/skills`);
          yield* write(`${base}/dotfiles/CLAUDE.md`, "Dotfiles rules\n");
          yield* fileSystem.symlink(`${base}/dotfiles/CLAUDE.md`, `${host}/.claude/CLAUDE.md`);

          const result = yield* importInto(host, [
            agentFile(".claude/CLAUDE.md", "Laptop rules\n"),
            agentFile(".claude/skills/review/SKILL.md", "Review skill\n"),
            agentFile(".claude/commands/ship.md", "Ship it\n"),
          ]);

          expect(result).toEqual({
            written: [".claude/commands/ship.md"],
            unchanged: [],
            skipped: [
              { path: ".claude/CLAUDE.md", reason: "symlink" },
              { path: ".claude/skills/review/SKILL.md", reason: "symlink" },
            ],
          });
          expect(yield* fileSystem.readDirectory(`${base}/elsewhere`)).toEqual([]);
          expect(yield* fileSystem.readFileString(`${base}/dotfiles/CLAUDE.md`)).toBe(
            "Dotfiles rules\n",
          );
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "carries a link to another synced path as a link, and makes it only where the host has nothing",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const machines = yield* makeMachines();
          const { base, laptop, host } = machines;
          yield* makeLaptop(machines);
          // How `npx skills` installs a skill for Claude: a link into ~/.agents/skills.
          yield* fileSystem.symlink(
            "../../.agents/skills/shared",
            `${laptop}/.claude/skills/shared`,
          );
          // One instruction file shared by both agents.
          yield* fileSystem.remove(`${laptop}/.codex/AGENTS.override.md`);
          yield* fileSystem.symlink(
            `${laptop}/.claude/CLAUDE.md`,
            `${laptop}/.codex/AGENTS.override.md`,
          );
          // Links that point outside what a sync carries, or at nothing, stay behind.
          yield* write(`${base}/outside/secret.md`, "secret\n");
          yield* fileSystem.symlink(
            `${base}/outside/secret.md`,
            `${laptop}/.claude/commands/linked.md`,
          );
          yield* fileSystem.symlink("../settings.json", `${laptop}/.claude/agents/settings.md`);
          yield* fileSystem.symlink("../../.agents/skills/gone", `${laptop}/.claude/skills/gone`);

          const exported = yield* exportFrom(laptop);
          const overrideLink = { path: ".codex/AGENTS.override.md", target: ".claude/CLAUDE.md" };
          const skillLink = { path: ".claude/skills/shared", target: ".agents/skills/shared" };
          expect(exported.links).toEqual([overrideLink, skillLink]);
          expect(exported.skipped).toEqual([
            { path: ".claude/skills/gone", reason: "symlink" },
            { path: ".claude/commands/linked.md", reason: "symlink" },
            { path: ".claude/agents/settings.md", reason: "symlink" },
          ]);
          // A linked file's content travels once, from where the link points.
          const files = SYNCED_PATHS.filter((file) => file !== overrideLink.path);
          expect(exported.files.map((file) => file.path)).toEqual(files);

          const first = yield* importInto(host, exported.files, { links: exported.links });
          expect(first).toEqual({
            written: [...files, overrideLink.path, skillLink.path],
            unchanged: [],
            skipped: [],
          });
          expect(yield* fileSystem.readLink(`${host}/.claude/skills/shared`)).toBe(
            "../../.agents/skills/shared",
          );
          expect(yield* fileSystem.readFileString(`${host}/.claude/skills/shared/SKILL.md`)).toBe(
            "Shared skill\n",
          );
          expect(yield* fileSystem.readLink(`${host}/.codex/AGENTS.override.md`)).toBe(
            "../.claude/CLAUDE.md",
          );
          expect(yield* fileSystem.exists(`${host}/.claude/commands/linked.md`)).toBe(false);
          expect(yield* fileSystem.exists(`${host}/.claude/agents/settings.md`)).toBe(false);

          // The same links again are unchanged; a host with its own folder there keeps it.
          expect(yield* importInto(host, [], { links: exported.links })).toEqual({
            written: [],
            unchanged: [overrideLink.path, skillLink.path],
            skipped: [],
          });
          const other = yield* makeMachines();
          yield* write(`${other.host}/.claude/skills/shared/SKILL.md`, "The host's own\n");
          const kept = yield* importInto(other.host, [], { links: [skillLink] });
          expect(kept).toEqual({
            written: [],
            unchanged: [],
            skipped: [{ path: ".claude/skills/shared", reason: "symlink" }],
          });
          expect(
            yield* fileSystem.readFileString(`${other.host}/.claude/skills/shared/SKILL.md`),
          ).toBe("The host's own\n");
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "finds each root through CLAUDE_CONFIG_DIR and CODEX_HOME on each machine",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { laptop, host } = yield* makeMachines();
          const laptopCodex = `${laptop}/work/codex`;
          yield* write(`${laptopCodex}/AGENTS.md`, "Codex rules\n");
          yield* write(`${laptopCodex}/skills/deploy/SKILL.md`, "Deploy skill\n");
          yield* write(`${laptop}/.agents/skills/shared/SKILL.md`, "Shared skill\n");
          yield* fileSystem.makeDirectory(`${laptop}/.claude/skills`, { recursive: true });
          yield* fileSystem.symlink(
            `${laptop}/.agents/skills/shared`,
            `${laptop}/.claude/skills/shared`,
          );
          // Ignored here: CODEX_HOME points elsewhere.
          yield* write(`${laptop}/.codex/AGENTS.md`, "Not this one\n");

          const exported = yield* exportFrom(laptop, { environment: { CODEX_HOME: laptopCodex } });
          expect(exported.files.map((file) => [file.path, text(file)])).toEqual([
            [".codex/AGENTS.md", "Codex rules\n"],
            [".codex/skills/deploy/SKILL.md", "Deploy skill\n"],
            [".agents/skills/shared/SKILL.md", "Shared skill\n"],
          ]);
          expect(exported.links).toEqual([
            { path: ".claude/skills/shared", target: ".agents/skills/shared" },
          ]);

          const hostClaude = `${host}/config/claude`;
          const result = yield* importInto(host, exported.files, {
            links: exported.links,
            environment: { CLAUDE_CONFIG_DIR: hostClaude },
          });
          expect(result.skipped).toEqual([]);
          expect(yield* fileSystem.readFileString(`${host}/.codex/skills/deploy/SKILL.md`)).toBe(
            "Deploy skill\n",
          );
          // The link points at the host's own copy, from where its Claude folder is.
          expect(yield* fileSystem.readLink(`${hostClaude}/skills/shared`)).toBe(
            "../../../.agents/skills/shared",
          );
          expect(yield* fileSystem.readFileString(`${hostClaude}/skills/shared/SKILL.md`)).toBe(
            "Shared skill\n",
          );
          expect(yield* fileSystem.exists(`${host}/.claude`)).toBe(false);
        }).pipe(Effect.scoped),
    );

    it.effect.skipIf(!symlinksSupported)(
      "loads newly synced files in Tempo's own Claude and Codex homes",
      () =>
        Effect.gen(function* () {
          const fileSystem = yield* FileSystem.FileSystem;
          const { host } = yield* makeMachines();
          const homes = `${host}-tempo/provider-homes`;
          const configMap = {
            [ProviderInstanceId.make("claudeAgent")]: {
              driver: ProviderDriverKind.make("claudeAgent"),
              enabled: true,
              environment: [
                { name: "CLAUDE_CONFIG_DIR", value: `${homes}/claude`, sensitive: false },
              ],
              config: { homePath: `${homes}/claude` },
            },
            [ProviderInstanceId.make("codex")]: {
              driver: ProviderDriverKind.make("codex"),
              enabled: true,
              environment: [{ name: "CODEX_HOME", value: `${homes}/codex`, sensitive: false }],
              config: { setupMode: "managed", homePath: `${homes}/codex` },
            },
          } as ProviderInstanceConfigMap;
          yield* fileSystem.makeDirectory(`${homes}/claude`, { recursive: true });

          yield* importInto(
            host,
            [
              agentFile(".claude/CLAUDE.md", "Personal rules\n"),
              agentFile(".codex/AGENTS.md", "Codex rules\n"),
              agentFile(".claude/skills/review/SKILL.md", "Review skill\n"),
              agentFile(".claude/rules/style.md", "Use tabs\n"),
              agentFile(".claude/output-styles/terse.md", "Be terse\n"),
              agentFile(".codex/skills/deploy/SKILL.md", "Deploy skill\n"),
              agentFile(".agents/skills/shared/SKILL.md", "Shared skill\n"),
            ],
            { configMap },
          );

          expect(yield* fileSystem.readFileString(`${homes}/claude/CLAUDE.md`)).toContain(
            `@${host}/.claude/CLAUDE.md`,
          );
          expect(yield* fileSystem.readLink(`${homes}/codex/AGENTS.md`)).toBe(
            `${host}/.codex/AGENTS.md`,
          );
          expect(yield* fileSystem.readLink(`${homes}/claude/skills`)).toBe(
            `${host}/.claude/skills`,
          );
          expect(yield* fileSystem.readFileString(`${homes}/claude/rules/style.md`)).toBe(
            "Use tabs\n",
          );
          expect(yield* fileSystem.readFileString(`${homes}/claude/output-styles/terse.md`)).toBe(
            "Be terse\n",
          );
          expect(yield* fileSystem.readLink(`${homes}/codex/skills/deploy`)).toBe(
            `${host}/.codex/skills/deploy`,
          );
          // Codex reads ~/.agents/skills from the home folder, so nothing links it.
          expect(yield* fileSystem.exists(`${homes}/codex/skills/shared`)).toBe(false);
        }).pipe(Effect.scoped),
    );
  });
});
