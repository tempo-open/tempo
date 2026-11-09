/**
 * tempo: a Claude home inside Tempo's data links in the person's skills, commands, agents, saved
 * workflows and output styles from the server machine's `~/.claude` (rules come with
 * InstructionRoots). Settings, credentials and `.claude.json` stay apart. A real folder already in
 * the managed home stays (the log says why).
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import { resolvePersonalInstructionDirs } from "./InstructionRoots.ts";
import { TEMPO_APP_BASE_NAME } from "@t3tools/shared/tempoBrand";

/** The only entries of the person's Claude config directory that are ever linked. */
export const PERSONAL_CLAUDE_FOLDERS = [
  "skills",
  "commands",
  "agents",
  "workflows",
  "output-styles",
] as const;

/** Entries that hold auth or provider settings: never linked, whatever the folder list says. */
export const NEVER_LINKED_CLAUDE_ENTRIES: ReadonlySet<string> = new Set([
  "settings.json",
  "settings.local.json",
  ".credentials.json",
  ".claude.json",
]);

const LINKED_FOLDERS = PERSONAL_CLAUDE_FOLDERS.filter(
  (folder) => !NEVER_LINKED_CLAUDE_ENTRIES.has(folder),
);

export type PersonalClaudeFolderOutcome =
  /** Linked now. */
  | "linked"
  /** Already a link to the person's folder. */
  | "already-linked"
  /** The managed home has a real entry of that name, which stays. */
  | "kept-own"
  /** The managed home has a link to somewhere else, which stays. */
  | "kept-other-link"
  /** The person has no such folder. */
  | "missing"
  /** The person's folder is gone, so the link to it was removed. */
  | "unlinked"
  | "failed";

const readLinkOption = (fileSystem: FileSystem.FileSystem, linkPath: string) =>
  fileSystem
    .readLink(linkPath)
    .pipe(
      Effect.asSome,
      Effect.catchTags({ PlatformError: () => Effect.succeed(Option.none<string>()) }),
    );

const isDirectory = (fileSystem: FileSystem.FileSystem, candidate: string) =>
  fileSystem.stat(candidate).pipe(
    Effect.map((info) => info.type === "Directory"),
    Effect.orElseSucceed(() => false),
  );

/**
 * Links the person's folders into the managed home and returns what happened to
 * each. A home that is the person's own folder gets nothing. Never fails: each
 * folder that cannot be linked is logged and reported as `failed`.
 */
export const linkPersonalClaudeFolders = Effect.fn("linkPersonalClaudeFolders")(function* (input: {
  readonly managedHome: string;
  readonly personalHome: string;
}): Effect.fn.Return<
  ReadonlyArray<{ readonly folder: string; readonly outcome: PersonalClaudeFolderOutcome }>,
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const managedHome = path.resolve(input.managedHome);
  const personalHome = path.resolve(input.personalHome);
  if (managedHome === personalHome) return [];

  const linkOne = Effect.fn("linkPersonalClaudeFolder")(function* (folder: string) {
    const source = path.join(personalHome, folder);
    const target = path.join(managedHome, folder);
    const personalFolder = yield* isDirectory(fileSystem, source);
    const link = yield* readLinkOption(fileSystem, target);
    if (Option.isSome(link)) {
      const toPersonal = path.resolve(managedHome, link.value) === source;
      if (!toPersonal) {
        yield* Effect.logInfo(
          `${TEMPO_APP_BASE_NAME}'s Claude home links ${folder} somewhere else, so it does not use yours.`,
          { home: managedHome, folder, linkedTo: link.value },
        );
        return "kept-other-link" as const;
      }
      if (personalFolder) return "already-linked" as const;
      yield* fileSystem.remove(target);
      return "unlinked" as const;
    }
    if (yield* fileSystem.exists(target)) {
      if (personalFolder) {
        yield* Effect.logInfo(
          `${TEMPO_APP_BASE_NAME}'s Claude home has its own ${folder} folder, so ${source} is not linked. Move what you need out of it and remove it to use yours.`,
          { home: managedHome, folder },
        );
      }
      return "kept-own" as const;
    }
    if (!personalFolder) return "missing" as const;
    yield* fileSystem.symlink(source, target);
    return "linked" as const;
  });

  return yield* Effect.forEach(LINKED_FOLDERS, (folder) =>
    linkOne(folder).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Could not link your Claude ${folder} folder into ${TEMPO_APP_BASE_NAME}'s Claude home.`,
          {
            home: managedHome,
            folder,
            cause,
          },
        ).pipe(Effect.as("failed" as const)),
      ),
      Effect.map((outcome) => ({ folder, outcome })),
    ),
  );
});

/**
 * Links the person's folders into the Claude home a provider instance starts
 * with, when that home is Tempo's own (under the server's base directory). A home
 * the person chose themselves is theirs, and is left alone.
 */
export const linkPersonalClaudeFoldersInto = Effect.fn("linkPersonalClaudeFoldersInto")(function* (
  homePath: string,
) {
  const path = yield* Path.Path;
  const { baseDir } = yield* ServerConfig.ServerConfig;
  const relative = path.relative(path.resolve(baseDir), path.resolve(homePath));
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return [];
  const personal = yield* resolvePersonalInstructionDirs();
  return yield* linkPersonalClaudeFolders({ managedHome: homePath, personalHome: personal.claude });
});
