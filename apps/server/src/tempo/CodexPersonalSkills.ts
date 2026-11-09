/**
 * tempo: Codex runs with Tempo's managed CODEX_HOME, so each Codex start links the person's
 * `~/.codex/skills` one by one into the managed `skills` folder, which stays Tempo's (Codex rewrites
 * its bundled `.system` skills there). Skills also in `~/.agents/skills` are skipped: Codex loads
 * that folder anyway and would list them twice. Real skills stay; links to removed skills go.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { resolvePersonalInstructionDirs } from "./InstructionRoots.ts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";

/**
 * Links the person's Codex skills into the Codex home a provider instance
 * starts with, when that home is Tempo's own (under the server's base directory).
 * Never fails: a failure is logged, and the next start tries again.
 */
export const linkPersonalCodexSkillsInto = Effect.fn("linkPersonalCodexSkillsInto")(
  function* (homePath: string) {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* ServerConfig.ServerConfig;
    const home = path.resolve(homePath);
    const relative = path.relative(path.resolve(baseDir), home);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
    const personal = yield* resolvePersonalInstructionDirs();
    if (path.resolve(personal.codex) === home) return;
    const source = path.join(personal.codex, "skills");
    const target = path.join(home, "skills");
    const readLink = (file: string) => fileSystem.readLink(file).pipe(Effect.option);
    const isDirectory = (file: string) =>
      fileSystem.stat(file).pipe(
        Effect.map((info) => info.type === "Directory"),
        Effect.orElseSucceed(() => false),
      );
    const names = (folder: string) =>
      fileSystem.readDirectory(folder).pipe(Effect.orElseSucceed((): string[] => []));
    // A link in place of the whole folder is someone else's; skills are never written through it.
    if (Option.isSome(yield* readLink(target))) return;

    const wanted = new Set<string>();
    for (const name of yield* names(source)) {
      // Codex skips hidden folders, and `.system` holds its own bundled skills.
      if (name.startsWith(".") || !(yield* isDirectory(path.join(source, name)))) continue;
      if (yield* fileSystem.exists(path.join(personal.agents, "skills", name))) continue;
      wanted.add(name);
    }
    for (const name of yield* names(target)) {
      const link = yield* readLink(path.join(target, name));
      const ours =
        Option.isSome(link) && path.resolve(target, link.value) === path.join(source, name);
      if (ours && !wanted.has(name)) yield* fileSystem.remove(path.join(target, name));
    }
    for (const name of wanted) {
      const entry = path.join(target, name);
      // Already linked, linked elsewhere, or Tempo's own copy: each stays.
      if (Option.isSome(yield* readLink(entry)) || (yield* fileSystem.exists(entry))) continue;
      yield* fileSystem.makeDirectory(target, { recursive: true });
      yield* fileSystem.symlink(path.join(source, name), entry);
    }
  },
  Effect.catchCause((cause) =>
    Effect.logWarning(
      `Could not link your Codex skills into ${TEMPO_APP_BASE_NAME}'s Codex home.`,
      {
        cause,
      },
    ),
  ),
);
