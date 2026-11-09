import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import * as ServerConfig from "../config.ts";
import {
  linkPersonalClaudeFolders,
  linkPersonalClaudeFoldersInto,
  NEVER_LINKED_CLAUDE_ENTRIES,
  PERSONAL_CLAUDE_FOLDERS,
} from "./ClaudePersonalFolders.ts";

/** A person's `~/.claude` with every folder Tempo links, auth and settings files, and more. */
const makeHomes = Effect.fn("makeHomes")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-claude-folders-" });
  const personal = path.join(root, "person", ".claude");
  const managed = path.join(root, "tempo", "provider-homes", "claude");
  for (const folder of [...PERSONAL_CLAUDE_FOLDERS, "projects", "plugins", "rules"]) {
    yield* fileSystem.makeDirectory(path.join(personal, folder), { recursive: true });
    yield* fileSystem.writeFileString(path.join(personal, folder, "README.md"), folder);
  }
  for (const entry of NEVER_LINKED_CLAUDE_ENTRIES) {
    yield* fileSystem.writeFileString(path.join(personal, entry), "{}");
  }
  yield* fileSystem.makeDirectory(managed, { recursive: true });
  return { root, personal, managed };
});

it.layer(NodeServices.layer)("linkPersonalClaudeFolders", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "links skills, commands, agents, workflows and output styles, never settings or credentials",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { personal, managed } = yield* makeHomes();

        const outcomes = yield* linkPersonalClaudeFolders({
          managedHome: managed,
          personalHome: personal,
        });

        expect(outcomes).toEqual(
          PERSONAL_CLAUDE_FOLDERS.map((folder) => ({ folder, outcome: "linked" })),
        );
        for (const folder of PERSONAL_CLAUDE_FOLDERS) {
          expect(yield* fileSystem.readLink(path.join(managed, folder))).toBe(
            path.join(personal, folder),
          );
          expect(yield* fileSystem.readFileString(path.join(managed, folder, "README.md"))).toBe(
            folder,
          );
        }
        // Nothing that holds auth or provider settings, and no other folder, comes along.
        expect((yield* fileSystem.readDirectory(managed)).toSorted()).toEqual(
          [...PERSONAL_CLAUDE_FOLDERS].toSorted(),
        );
        // Output styles load like skills; rules follow Use my personal instructions instead.
        expect(yield* fileSystem.readLink(path.join(managed, "output-styles"))).toBe(
          path.join(personal, "output-styles"),
        );
        expect(yield* fileSystem.exists(path.join(managed, "rules"))).toBe(false);
        // Refreshing again changes nothing.
        expect(
          yield* linkPersonalClaudeFolders({ managedHome: managed, personalHome: personal }),
        ).toEqual(PERSONAL_CLAUDE_FOLDERS.map((folder) => ({ folder, outcome: "already-linked" })));
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "keeps a real folder the managed home already has, and a link someone else made",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, personal, managed } = yield* makeHomes();
        yield* fileSystem.makeDirectory(path.join(managed, "skills"));
        yield* fileSystem.writeFileString(path.join(managed, "skills", "mine.md"), "mine");
        const shared = path.join(root, "shared-agents");
        yield* fileSystem.makeDirectory(shared);
        yield* fileSystem.symlink(shared, path.join(managed, "agents"));

        const outcomes = yield* linkPersonalClaudeFolders({
          managedHome: managed,
          personalHome: personal,
        });

        expect(outcomes).toContainEqual({ folder: "skills", outcome: "kept-own" });
        expect(outcomes).toContainEqual({ folder: "agents", outcome: "kept-other-link" });
        expect(yield* fileSystem.readDirectory(path.join(managed, "skills"))).toEqual(["mine.md"]);
        expect(yield* fileSystem.readLink(path.join(managed, "agents"))).toBe(shared);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "removes a link to a folder the person deleted, and links nothing into their own home",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { personal, managed } = yield* makeHomes();
        yield* linkPersonalClaudeFolders({ managedHome: managed, personalHome: personal });
        yield* fileSystem.remove(path.join(personal, "workflows"), { recursive: true });

        const outcomes = yield* linkPersonalClaudeFolders({
          managedHome: managed,
          personalHome: personal,
        });

        expect(outcomes).toContainEqual({ folder: "workflows", outcome: "unlinked" });
        expect(yield* fileSystem.exists(path.join(managed, "workflows"))).toBe(false);
        expect(
          yield* linkPersonalClaudeFolders({ managedHome: personal, personalHome: personal }),
        ).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "links into Tempo's own Claude home only, from the server machine's ~/.claude",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { root, personal, managed } = yield* makeHomes();
        const config = Layer.effect(
          ServerConfig.ServerConfig,
          Effect.map(ServerConfig.ServerConfig, (current) => ({
            ...current,
            baseDir: path.join(root, "tempo"),
          })),
        ).pipe(
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-claude-folders-" })),
        );
        const run = (home: string) =>
          linkPersonalClaudeFoldersInto(home).pipe(
            Effect.provide(config),
            Effect.provideService(HostProcess.HomeDirectory, path.dirname(personal)),
            Effect.provideService(HostProcess.Environment, {}),
          );

        // A home the person chose outside Tempo's own folder is theirs.
        const chosen = path.join(root, "elsewhere");
        yield* fileSystem.makeDirectory(chosen);
        expect(yield* run(chosen)).toEqual([]);
        expect(yield* fileSystem.readDirectory(chosen)).toEqual([]);

        expect((yield* run(managed)).map((entry) => entry.outcome)).toEqual(
          PERSONAL_CLAUDE_FOLDERS.map(() => "linked"),
        );
      }).pipe(Effect.scoped),
  );
});
