import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import * as ServerConfig from "../config.ts";
import { linkPersonalCodexSkillsInto } from "./CodexPersonalSkills.ts";

const write = Effect.fn("write")(function* (file: string, content: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
  yield* fileSystem.writeFileString(file, content);
});

/**
 * A person with Codex skills (and Codex's own `.system` copy) in `~/.codex/skills`
 * and one shared skill in `~/.agents/skills`, and Tempo's Codex home with its own
 * `.system` skills and a skill copied into it.
 */
const makeHomes = Effect.fn("makeHomes")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = yield* fileSystem.realPath(
    yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-codex-skills-" }),
  );
  const person = `${root}/me`;
  const managed = `${root}/tempo/provider-homes/codex`;
  yield* write(`${person}/.codex/skills/deploy/SKILL.md`, "Deploy\n");
  yield* write(`${person}/.codex/skills/review/SKILL.md`, "Review\n");
  yield* write(`${person}/.codex/skills/shared/SKILL.md`, "Shared, older copy\n");
  yield* write(`${person}/.codex/skills/.system/imagegen/SKILL.md`, "The person's Codex's own\n");
  yield* write(`${person}/.codex/skills/notes.md`, "Not a skill\n");
  yield* write(`${person}/.agents/skills/shared/SKILL.md`, "Shared\n");
  yield* write(`${managed}/skills/.system/imagegen/SKILL.md`, "Tempo's Codex's own\n");
  yield* write(`${managed}/skills/review/SKILL.md`, "Tempo's copy\n");
  return { root, person, managed };
});

/** Runs the linker as the server whose base directory is `<root>/tempo` and whose home is `person`. */
const linkAs = (root: string, person: string, home: string) =>
  linkPersonalCodexSkillsInto(home).pipe(
    Effect.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        Effect.map(ServerConfig.ServerConfig, (current) => ({
          ...current,
          baseDir: `${root}/tempo`,
        })),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "tempo-codex-skills-" })),
      ),
    ),
    Effect.provideService(HostProcess.HomeDirectory, person),
    Effect.provideService(HostProcess.Environment, {}),
  );

it.layer(NodeServices.layer)("linkPersonalCodexSkillsInto", (it) => {
  it.effect.skipIf(!symlinksSupported)(
    "links each of the person's skills into Tempo's Codex home, and nothing Codex loads already",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, person, managed } = yield* makeHomes();

        yield* linkAs(root, person, managed);

        expect(yield* fileSystem.readLink(`${managed}/skills/deploy`)).toBe(
          `${person}/.codex/skills/deploy`,
        );
        expect(yield* fileSystem.readFileString(`${managed}/skills/deploy/SKILL.md`)).toBe(
          "Deploy\n",
        );
        // Tempo's own copy and its own `.system` skills stay; Codex reads ~/.agents/skills itself.
        expect((yield* fileSystem.readDirectory(`${managed}/skills`)).toSorted()).toEqual([
          ".system",
          "deploy",
          "review",
        ]);
        expect(yield* fileSystem.readFileString(`${managed}/skills/review/SKILL.md`)).toBe(
          "Tempo's copy\n",
        );
        expect(
          yield* fileSystem.readFileString(`${managed}/skills/.system/imagegen/SKILL.md`),
        ).toBe("Tempo's Codex's own\n");

        // Linking again changes nothing.
        yield* linkAs(root, person, managed);
        expect((yield* fileSystem.readDirectory(`${managed}/skills`)).toSorted()).toEqual([
          ".system",
          "deploy",
          "review",
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "removes its link when the skill is gone or moves to ~/.agents/skills, and only its own",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, person, managed } = yield* makeHomes();
        yield* write(`${person}/.codex/skills/later/SKILL.md`, "Later\n");
        yield* write(`${root}/elsewhere/tool/SKILL.md`, "Someone else's\n");
        yield* fileSystem.symlink(`${root}/elsewhere/tool`, `${managed}/skills/tool`);
        yield* linkAs(root, person, managed);
        expect(yield* fileSystem.readLink(`${managed}/skills/later`)).toBe(
          `${person}/.codex/skills/later`,
        );

        yield* fileSystem.remove(`${person}/.codex/skills/deploy`, { recursive: true });
        yield* write(`${person}/.agents/skills/later/SKILL.md`, "Later\n");
        yield* linkAs(root, person, managed);

        expect((yield* fileSystem.readDirectory(`${managed}/skills`)).toSorted()).toEqual([
          ".system",
          "review",
          "tool",
        ]);
        expect(yield* fileSystem.readLink(`${managed}/skills/tool`)).toBe(`${root}/elsewhere/tool`);
      }).pipe(Effect.scoped),
  );

  it.effect.skipIf(!symlinksSupported)(
    "leaves homes that are not Tempo's own alone, and never writes through a linked skills folder",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const { root, person, managed } = yield* makeHomes();

        // A home the person chose outside Tempo's folder is theirs.
        const chosen = `${root}/codex-work`;
        yield* fileSystem.makeDirectory(chosen);
        yield* linkAs(root, person, chosen);
        expect(yield* fileSystem.readDirectory(chosen)).toEqual([]);

        yield* fileSystem.remove(`${managed}/skills`, { recursive: true });
        yield* fileSystem.makeDirectory(`${root}/shared-skills`);
        yield* fileSystem.symlink(`${root}/shared-skills`, `${managed}/skills`);
        yield* linkAs(root, person, managed);
        expect(yield* fileSystem.readDirectory(`${root}/shared-skills`)).toEqual([]);
      }).pipe(Effect.scoped),
  );
});
