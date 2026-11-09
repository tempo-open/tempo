import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  INSTRUCTION_FILE_MAX_BYTES,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type InstructionFileGroup,
  type Project,
  type ProviderInstanceConfigMap,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import { WALK_MAX_FILES, parseClaudeImports } from "./instructionDiscovery.ts";
import * as InstructionFiles from "./InstructionFiles.ts";
import * as InstructionRoots from "./InstructionRoots.ts";
import { encodeClaudeProjectDirName } from "./InstructionRoots.ts";

const NOW = "2026-10-12T12:00:00.000Z";

const writeFile = Effect.fn(function* (file: string, content: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, content);
});

const git = Effect.fn(function* (cwd: string, args: ReadonlyArray<string>) {
  const vcsProcess = yield* VcsProcess.VcsProcess;
  yield* vcsProcess.run({ operation: "InstructionFiles.test.git", command: "git", cwd, args });
});

const project = (root: string): Project => ({
  id: ProjectId.make("shop"),
  title: "Shop",
  workspaceRoot: root,
  defaultModelSelection: null,
  scripts: [],
  createdAt: NOW,
  updatedAt: NOW,
  deletedAt: null,
});

interface Fixture {
  readonly base: string;
  readonly home: string;
  readonly root: string;
  readonly outside: string;
}

/** A person's home with Claude and Codex files and one git project in ~/code/shop. */
const makeFixture = Effect.fn(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const base = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-instruction-files-" }),
  );
  const home = `${base}/home`;
  const root = `${home}/code/shop`;
  const outside = `${base}/outside`;
  yield* writeFile(`${home}/.claude/CLAUDE.md`, "Personal rules\n");
  yield* writeFile(`${home}/.claude/rules/style.md`, "Use tabs\n");
  yield* writeFile(`${home}/.codex/AGENTS.md`, "Codex personal\n");
  yield* writeFile(`${home}/code/CLAUDE.md`, "Code folder rules\n");
  yield* writeFile(`${outside}/secret.md`, "secret\n");
  yield* fileSystem.makeDirectory(root, { recursive: true });
  yield* git(root, ["init", "-q"]);
  yield* writeFile(
    `${root}/CLAUDE.md`,
    "@AGENTS.md\nSee @docs/conventions.md and `@ignored.md` and @.env\n",
  );
  yield* writeFile(`${root}/AGENTS.md`, "Shared rules\n");
  yield* writeFile(`${root}/docs/conventions.md`, "Conventions\n");
  yield* writeFile(`${root}/.env`, "SECRET=1\n");
  yield* writeFile(`${root}/package.json`, "{}\n");
  yield* writeFile(`${root}/packages/web/CLAUDE.md`, "Web rules\n");
  yield* writeFile(`${root}/packages/web/AGENTS.md`, "Web agents\n");
  yield* writeFile(
    `${root}/.claude/rules/testing.md`,
    '---\npaths:\n  - "**/*.test.ts"\n---\nTests\n',
  );
  yield* writeFile(`${root}/.gitignore`, "dist/\n");
  yield* writeFile(`${root}/dist/CLAUDE.md`, "built\n");
  yield* writeFile(`${root}/node_modules/pkg/CLAUDE.md`, "dependency\n");
  yield* writeFile(`${root}/.hidden/CLAUDE.md`, "hidden\n");
  const memory = `${home}/.claude/projects/${encodeClaudeProjectDirName(root)}/memory`;
  yield* writeFile(`${memory}/MEMORY.md`, "- [Note](note.md)\n");
  yield* writeFile(`${memory}/note.md`, "A note\n");
  return { base, home, root, outside } satisfies Fixture;
});

interface ServiceOptions {
  /** The provider instances sessions launch with; upstream hydration from settings by default. */
  readonly configMap?: ProviderInstanceConfigMap;
  /** Counts project walks (`git check-ignore` runs). */
  readonly walks?: { count: number };
}

const countingVcsProcess = (walks: { count: number }) =>
  Layer.effect(
    VcsProcess.VcsProcess,
    Effect.gen(function* () {
      const real = yield* VcsProcess.VcsProcess;
      return VcsProcess.VcsProcess.of({
        run: (input) => {
          if (input.operation === "InstructionFiles.walk") walks.count += 1;
          return real.run(input);
        },
      });
    }),
  ).pipe(Layer.provide(VcsProcess.layer));

const serviceLayer = (fixture: Fixture, options: ServiceOptions = {}) => {
  const instances =
    options.configMap === undefined
      ? InstructionRoots.InstructionProviderInstances.layer
      : InstructionRoots.InstructionProviderInstances.layerFrom(() =>
          Effect.succeed(options.configMap!),
        );
  return Layer.mergeAll(
    InstructionFiles.layer,
    InstructionRoots.layerPersonalInstructionsSync,
  ).pipe(
    Layer.provide(instances),
    Layer.provide(ServerConfig.layerTest(fixture.root, `${fixture.base}/tempo`)),
    Layer.provide(ServerSettingsModule.layerTest()),
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        snapshot: Effect.succeed({ projects: [project(fixture.root)], updatedAt: NOW }),
      }),
    ),
    Layer.provide(
      options.walks === undefined ? VcsProcess.layer : countingVcsProcess(options.walks),
    ),
  );
};

/** Run against the fixture with the server's home and environment pointed at it. */
const withService = <A, E>(
  fixture: Fixture,
  use: (service: InstructionFiles.InstructionFiles["Service"]) => Effect.Effect<A, E>,
  options: ServiceOptions = {},
) =>
  Effect.gen(function* () {
    return yield* use(yield* InstructionFiles.InstructionFiles);
  }).pipe(
    Effect.provide(serviceLayer(fixture, options)),
    Effect.provideService(HostProcess.HomeDirectory, fixture.home),
    Effect.provideService(HostProcess.Environment, {}),
  );

const groupBy = (groups: ReadonlyArray<InstructionFileGroup>, scope: string, title: string) => {
  const group = groups.find((candidate) => candidate.scope === scope && candidate.title === title);
  expect(group).toBeDefined();
  return group!;
};

const entry = (group: InstructionFileGroup, displayPath: string) => {
  const found = group.entries.find((candidate) => candidate.displayPath === displayPath);
  expect(found, displayPath).toBeDefined();
  return found!;
};

const layer = Layer.mergeAll(
  NodeServices.layer,
  VcsProcess.layer.pipe(Layer.provide(NodeServices.layer)),
);

describe("InstructionFiles.list", () => {
  it.effect("shows the global, project, nested, imported, and memory files sessions load", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const result = yield* withService(fixture, (service) => service.list({}));
      expect(result.usePersonalInstructions).toBe(true);

      const claude = groupBy(result.groups, "global", "Claude");
      expect(claude.entries.map((item) => item.displayPath)).toEqual([
        "CLAUDE.md",
        "rules/style.md",
      ]);
      expect(claude.personal).toEqual({
        path: `${fixture.home}/.claude/CLAUDE.md`,
        state: "direct",
      });
      const codex = groupBy(result.groups, "global", "Codex");
      expect(entry(codex, "AGENTS.md")).toMatchObject({ providers: ["codex"], exists: true });

      const shop = groupBy(result.groups, "project", "Shop");
      expect(shop.truncated).toBe(false);
      const paths = shop.entries.map((item) => item.displayPath);
      expect(paths).toEqual(
        expect.arrayContaining([
          "CLAUDE.md",
          "CLAUDE.local.md",
          "AGENTS.md",
          "~/code/CLAUDE.md",
          "packages/web/CLAUDE.md",
          "packages/web/AGENTS.md",
          ".claude/rules/testing.md",
          "docs/conventions.md",
        ]),
      );
      for (const excluded of [
        "dist/CLAUDE.md",
        "node_modules/pkg/CLAUDE.md",
        ".hidden/CLAUDE.md",
        ".env",
      ]) {
        expect(paths).not.toContain(excluded);
      }
      expect(entry(shop, "CLAUDE.local.md")).toMatchObject({ exists: false, size: null });
      // Codex reads AGENTS.md itself; Claude reads it through CLAUDE.md's import.
      expect(entry(shop, "AGENTS.md").providers).toEqual(["claude", "codex"]);
      expect(entry(shop, "docs/conventions.md")).toMatchObject({
        kind: "import",
        providers: ["claude"],
      });
      // A CLAUDE.md in the project means Claude skips nested AGENTS.md; Codex follows it.
      expect(entry(shop, "packages/web/AGENTS.md").providers).toEqual(["codex"]);
      expect(entry(shop, "packages/web/CLAUDE.md").loadedBy).toContain("packages/web/");
      expect(entry(shop, ".claude/rules/testing.md").loadedBy).toContain("`paths`");
      expect(entry(shop, "~/code/CLAUDE.md").loadedBy).toContain("parent folder");

      const memory = groupBy(result.groups, "memory", "Shop");
      expect(memory.entries.map((item) => item.displayPath)).toEqual(["MEMORY.md", "note.md"]);
      expect(entry(memory, "MEMORY.md").providers).toEqual(["claude"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stops the folder walk at its depth and file caps and says so", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      yield* writeFile(`${fixture.root}/a/b/c/d/e/f/CLAUDE.md`, "deepest walked\n");
      yield* writeFile(`${fixture.root}/a/b/c/d/e/f/g/CLAUDE.md`, "too deep\n");
      const deep = yield* withService(fixture, (service) => service.list({}));
      const shop = groupBy(deep.groups, "project", "Shop");
      expect(shop.truncated).toBe(true);
      const paths = shop.entries.map((item) => item.displayPath);
      expect(paths).toContain("a/b/c/d/e/f/CLAUDE.md");
      expect(paths).not.toContain("a/b/c/d/e/f/g/CLAUDE.md");

      for (let index = 0; index <= WALK_MAX_FILES; index += 1) {
        yield* writeFile(`${fixture.root}/many/m${index}/AGENTS.md`, "x\n");
      }
      const many = yield* withService(fixture, (service) => service.list({}));
      const walked = groupBy(many.groups, "project", "Shop").entries.filter((item) =>
        item.displayPath.startsWith("many/"),
      );
      expect(walked.length).toBeLessThan(WALK_MAX_FILES + 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("InstructionFiles access", () => {
  it.effect("refuses files that are not instruction files, traversal, and symlink escapes", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const { root, outside } = fixture;
      yield* writeFile(`${outside}/CLAUDE.md`, "outside\n");
      yield* fileSystem.makeDirectory(`${root}/sub`, { recursive: true });
      yield* fileSystem.symlink(`${outside}/secret.md`, `${root}/sub/CLAUDE.md`);
      yield* fileSystem.symlink(outside, `${root}/.claude/rules/linked`);
      const refused = (requested: string) =>
        withService(fixture, (service) =>
          service.read({ path: requested }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          ),
        );
      for (const requested of [
        `${root}/package.json`,
        `${root}/.env`,
        `${root}/node_modules/pkg/CLAUDE.md`,
        `${root}/../../../outside/CLAUDE.md`,
        "CLAUDE.md",
      ]) {
        expect(yield* refused(requested), requested).toBe("not-allowed");
      }
      for (const requested of [`${root}/sub/CLAUDE.md`, `${root}/.claude/rules/linked/secret.md`]) {
        expect(yield* refused(requested), requested).toBe("links-outside");
      }
      const writeEscape = yield* withService(fixture, (service) =>
        service
          .write({ path: `${root}/sub/CLAUDE.md`, content: "x", expectedMtimeMs: 0 })
          .pipe(Effect.flip),
      );
      expect(writeEscape.reason).toBe("links-outside");
      expect(yield* fileSystem.readFileString(`${outside}/secret.md`)).toBe("secret\n");
      // The list shows the link, says why it does not open, and offers no edit.
      const listed = yield* withService(fixture, (service) => service.list({}));
      expect(
        entry(groupBy(listed.groups, "project", "Shop"), "sub/CLAUDE.md").unopenable,
      ).toContain("outside the folders Tempo edits");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("never opens credentials through a linked instruction file or import", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const { root, home } = fixture;
      const auth = `${home}/.codex/auth.json`;
      yield* writeFile(auth, '{"token":"secret"}');
      yield* fileSystem.makeDirectory(`${root}/linked`, { recursive: true });
      yield* fileSystem.symlink(auth, `${root}/linked/AGENTS.md`);
      yield* fileSystem.symlink(auth, `${root}/notes.md`);
      yield* writeFile(`${root}/CLAUDE.md`, "@notes.md\n");
      const result = yield* withService(fixture, (service) =>
        Effect.all({
          agents: service.read({ path: `${root}/linked/AGENTS.md` }).pipe(Effect.flip),
          imported: service
            .read({ path: `${root}/notes.md`, via: `${root}/CLAUDE.md` })
            .pipe(Effect.flip),
          overwrite: service
            .write({ path: `${root}/linked/AGENTS.md`, content: "{}", expectedMtimeMs: 0 })
            .pipe(Effect.flip),
          claude: service.read({ path: `${root}/CLAUDE.md` }),
          list: service.list({}),
        }),
      );
      expect(result.agents.reason).toBe("links-outside");
      expect(result.overwrite.reason).toBe("links-outside");
      expect(result.imported.reason).toBe("not-allowed");
      expect(result.claude.imports).toEqual([
        expect.objectContaining({ token: "notes.md", openable: false }),
      ]);
      const shop = groupBy(result.list.groups, "project", "Shop");
      expect(entry(shop, "linked/AGENTS.md").unopenable).toContain("not a text document");
      expect(shop.entries.map((item) => item.displayPath)).not.toContain("notes.md");
      expect(yield* fileSystem.readFileString(auth)).toBe('{"token":"secret"}');
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("opens a personal file a dotfiles manager links from elsewhere", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const personal = `${fixture.home}/.claude/CLAUDE.md`;
      const dotfile = `${fixture.base}/dotfiles/claude/CLAUDE.md`;
      yield* writeFile(dotfile, "From dotfiles\n");
      yield* fileSystem.remove(personal);
      yield* fileSystem.symlink(dotfile, personal);
      yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          const opened = yield* service.read({ path: personal });
          expect(opened.content).toBe("From dotfiles\n");
          yield* service.write({
            path: personal,
            content: "Edited\n",
            expectedMtimeMs: opened.mtimeMs,
          });
          const listed = yield* service.list({});
          expect(entry(groupBy(listed.groups, "global", "Claude"), "CLAUDE.md").unopenable).toBe(
            undefined,
          );
        }),
      );
      expect(yield* fileSystem.readFileString(dotfile)).toBe("Edited\n");
      expect(yield* fileSystem.readLink(personal)).toBe(dotfile);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("reads instruction files, imports, parent-folder files, and in-project links", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const { root } = fixture;
      yield* fileSystem.makeDirectory(`${root}/packages/api`, { recursive: true });
      yield* fileSystem.symlink("../../AGENTS.md", `${root}/packages/api/CLAUDE.md`);
      const result = yield* withService(fixture, (service) =>
        Effect.all({
          claude: service.read({ path: `${root}/CLAUDE.md` }),
          imported: service.read({ path: `${root}/docs/conventions.md` }),
          parent: service.read({ path: `${fixture.home}/code/CLAUDE.md` }),
          linked: service.read({ path: `${root}/packages/api/CLAUDE.md` }),
        }),
      );
      expect(result.claude.imports.map(({ token, openable }) => [token, openable])).toEqual([
        ["AGENTS.md", true],
        ["docs/conventions.md", true],
        [".env", false],
      ]);
      expect(result.imported.content).toBe("Conventions\n");
      expect(result.parent.content).toBe("Code folder rules\n");
      expect(result.linked.content).toBe("Shared rules\n");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("writes with optimistic concurrency and deletes only what was confirmed", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const { root } = fixture;
      const local = `${root}/CLAUDE.local.md`;
      yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          yield* service.write({ path: local, content: "Mine\n", expectedMtimeMs: null });
          expect(
            (yield* service
              .write({ path: local, content: "Again\n", expectedMtimeMs: null })
              .pipe(Effect.flip)).reason,
          ).toBe("already-exists");

          const opened = yield* service.read({ path: local });
          expect(
            (yield* service
              .write({ path: local, content: "Stale\n", expectedMtimeMs: opened.mtimeMs - 1 })
              .pipe(Effect.flip)).reason,
          ).toBe("conflict");
          const saved = yield* service.write({
            path: local,
            content: "Updated\n",
            expectedMtimeMs: opened.mtimeMs,
          });
          expect(yield* fileSystem.readFileString(local)).toBe("Updated\n");
          expect(
            (yield* service
              .write({
                path: local,
                content: "x".repeat(INSTRUCTION_FILE_MAX_BYTES + 1),
                expectedMtimeMs: saved.mtimeMs,
              })
              .pipe(Effect.flip)).reason,
          ).toBe("too-large");

          const rule = `${root}/.claude/rules/new/deep.md`;
          yield* service.write({ path: rule, content: "New rule\n", expectedMtimeMs: null });
          expect(yield* fileSystem.readFileString(rule)).toBe("New rule\n");

          expect(
            (yield* service
              .remove({ path: local, expectedMtimeMs: saved.mtimeMs - 1 })
              .pipe(Effect.flip)).reason,
          ).toBe("conflict");
          yield* service.remove({ path: local, expectedMtimeMs: saved.mtimeMs });
          expect(yield* fileSystem.exists(local)).toBe(false);
        }),
      );

      // Deleting a symlinked instruction file removes the link, not the file it names.
      yield* fileSystem.makeDirectory(`${root}/packages/api`, { recursive: true });
      yield* fileSystem.symlink("../../AGENTS.md", `${root}/packages/api/CLAUDE.md`);
      yield* withService(fixture, (service) =>
        Effect.gen(function* () {
          const linked = yield* service.read({ path: `${root}/packages/api/CLAUDE.md` });
          yield* service.remove({ path: linked.path, expectedMtimeMs: linked.mtimeMs });
        }),
      );
      expect(yield* fileSystem.exists(`${root}/packages/api/CLAUDE.md`)).toBe(false);
      expect(yield* fileSystem.readFileString(`${root}/AGENTS.md`)).toBe("Shared rules\n");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("InstructionFiles load rules", () => {
  it.effect("follows Codex: the first file in a folder wins, even when it is blank", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { root, home } = fixture;
      yield* writeFile(`${root}/AGENTS.override.md`, "  \n");
      yield* writeFile(`${home}/.codex/AGENTS.override.md`, "\n\n");
      const result = yield* withService(fixture, (service) => service.list({}));
      const shop = groupBy(result.groups, "project", "Shop");
      expect(entry(shop, "AGENTS.override.md")).toMatchObject({ providers: [] });
      expect(entry(shop, "AGENTS.override.md").loadedBy).toContain("loads nothing else");
      // Claude still reads AGENTS.md through CLAUDE.md's import; Codex does not.
      expect(entry(shop, "AGENTS.md").providers).toEqual(["claude"]);
      expect(entry(shop, "AGENTS.md").loadedBy).toContain("AGENTS.override.md");
      // Globally, Codex falls through a blank override to AGENTS.md.
      const codex = groupBy(result.groups, "global", "Codex");
      expect(entry(codex, "AGENTS.override.md").providers).toEqual([]);
      expect(entry(codex, "AGENTS.md").providers).toEqual(["codex"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("ignores Codex fallback names that leave the folder", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { root, home } = fixture;
      yield* writeFile(
        `${home}/.codex/config.toml`,
        'project_doc_fallback_filenames = ["../secret.md", "GUIDE.md"]\n',
      );
      yield* writeFile(`${home}/code/secret.md`, "not an instruction file\n");
      yield* writeFile(`${root}/GUIDE.md`, "Guide\n");
      const result = yield* withService(fixture, (service) =>
        Effect.all({
          list: service.list({}),
          secret: service.read({ path: `${home}/code/secret.md` }).pipe(Effect.flip),
        }),
      );
      const paths = groupBy(result.list.groups, "project", "Shop").entries.map(
        (item) => item.displayPath,
      );
      expect(paths).toContain("GUIDE.md");
      expect(paths).not.toContain("~/code/secret.md");
      expect(result.secret.reason).toBe("not-allowed");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("says when a project import from outside needs Claude Code's approval", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { root, home } = fixture;
      yield* writeFile(`${home}/.claude/shop-notes.md`, "Mine\n");
      yield* writeFile(`${root}/CLAUDE.md`, "@AGENTS.md\n@~/.claude/shop-notes.md\n");
      yield* writeFile(`${home}/.claude/CLAUDE.md`, "@notes/everywhere.md\n");
      yield* writeFile(`${home}/.claude/notes/everywhere.md`, "Everywhere\n");
      const result = yield* withService(fixture, (service) => service.list({}));
      const shop = groupBy(result.groups, "project", "Shop");
      const external = entry(shop, "~/.claude/shop-notes.md");
      expect(external.loadedBy).toContain("once you approve imports from outside this project");
      expect(external.warning).toContain("approved it in Claude Code");
      expect(entry(shop, "AGENTS.md").warning).toBeUndefined();
      // The person's own CLAUDE.md is trusted: no approval needed.
      const claude = groupBy(result.groups, "global", "Claude");
      expect(entry(claude, "notes/everywhere.md").warning).toBeUndefined();
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("warns about MEMORY.md only past 200 lines", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const memory = `${fixture.home}/.claude/projects/${encodeClaudeProjectDirName(fixture.root)}/memory/MEMORY.md`;
      const lines = (count: number) =>
        `${Array.from({ length: count }, (_, i) => `- ${i}`).join("\n")}\n`;
      yield* writeFile(memory, lines(200));
      const exact = yield* withService(fixture, (service) => service.list({}));
      expect(entry(groupBy(exact.groups, "memory", "Shop"), "MEMORY.md").warning).toBeUndefined();
      yield* writeFile(memory, lines(201));
      const over = yield* withService(fixture, (service) => service.list({}));
      expect(entry(groupBy(over.groups, "memory", "Shop"), "MEMORY.md").warning).toContain(
        "200 lines",
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("opens an import through its importer without walking every project", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture();
      const { root } = fixture;
      const walks = { count: 0 };
      const listed = yield* withService(fixture, (service) => service.list({}), { walks });
      const conventions = entry(groupBy(listed.groups, "project", "Shop"), "docs/conventions.md");
      expect(conventions.importedFrom).toBe(`${root}/CLAUDE.md`);
      walks.count = 0;
      const opened = yield* withService(
        fixture,
        (service) => service.read({ path: conventions.path, via: conventions.importedFrom! }),
        { walks },
      );
      expect(opened.content).toBe("Conventions\n");
      expect(walks.count).toBe(0);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("lists tempo-managed homes and includes the person's own instructions in them", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const fixture = yield* makeFixture();
      const homes = `${fixture.base}/tempo/provider-homes`;
      const configMap = {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: true,
          environment: [{ name: "CLAUDE_CONFIG_DIR", value: `${homes}/claude`, sensitive: false }],
          config: { homePath: `${homes}/claude` },
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: true,
          environment: [{ name: "CODEX_HOME", value: `${homes}/codex`, sensitive: false }],
          config: { setupMode: "managed", homePath: `${homes}/codex` },
        },
      } as ProviderInstanceConfigMap;
      // Building the service starts the sync, which includes the person's files.
      const result = yield* withService(fixture, (service) => service.list({}), { configMap });
      const claude = groupBy(result.groups, "global", "Claude");
      expect(claude.root).toBe(`${homes}/claude`);
      expect(claude.personal).toEqual({
        path: `${fixture.home}/.claude/CLAUDE.md`,
        state: "included",
      });
      expect(entry(claude, "CLAUDE.md").exists).toBe(true);
      // The import makes the person's file a Claude import of the tempo home.
      expect(entry(claude, "~/.claude/CLAUDE.md").providers).toEqual(["claude"]);
      expect(yield* fileSystem.readFileString(`${homes}/claude/CLAUDE.md`)).toContain(
        `@${fixture.home}/.claude/CLAUDE.md`,
      );
      const codex = groupBy(result.groups, "global", "Codex");
      expect(codex.root).toBe(`${homes}/codex`);
      expect(codex.personal?.state).toBe("included");
      expect(yield* fileSystem.readLink(`${homes}/codex/AGENTS.md`)).toBe(
        `${fixture.home}/.codex/AGENTS.md`,
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

describe("parseClaudeImports", () => {
  it("follows Claude Code's import syntax and skips code and comments", () => {
    const content = [
      String.raw`See @README.md and @docs/Design\ Docs/api.md, or mail me@example.com.`,
      "Inline `@not-imported.md` stays literal.",
      "```",
      "@inside-fence.md",
      "```",
      "<!-- @in-comment.md -->",
      "@~/.claude/mine.md",
    ].join("\n");
    expect(parseClaudeImports(content)).toEqual([
      "README.md",
      "docs/Design Docs/api.md,",
      "~/.claude/mine.md",
    ]);
  });
});
