/**
 * The host's own Codex and Claude Code threads, found cheaply: listings, stats, and a copy of
 * Codex's state database, which Codex keeps open. Only `readHead` reads a transcript, its start.
 * Like the native apps' lists, it skips threads the person did not start there: sub-agents, other
 * apps' sessions (Tempo's, T3 Code's), scripted runs (`claude -p`, `codex exec`) and automation runs.
 */
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export type NativeDriver = "claudeAgent" | "codex";

export interface NativeTranscript {
  readonly driver: NativeDriver;
  readonly nativeId: string;
  readonly filePath: string;
  readonly size: number;
  readonly mtimeMs: number;
  /** The native app's own name for the thread, when it keeps one. */
  readonly title: string | null;
  /** Not the person's own thread (see the module comment), when known without reading it. */
  readonly foreign: boolean | null;
  /** Stored in a form the importer cannot read (Codex's zstd-compressed cold rollouts). */
  readonly compressed: boolean;
}

export interface NativeDiscovery {
  /** Threads that are not archived, newest first. */
  readonly transcripts: ReadonlyArray<NativeTranscript>;
  /** Native ids the native app has archived. */
  readonly archivedIds: ReadonlySet<string>;
  /** False when the home could not be listed in full, so a missing thread proves nothing. */
  readonly complete: boolean;
}

const SESSION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** Claude Code names a transcript after its session. */
const CLAUDE_TRANSCRIPT = new RegExp(`^(${SESSION_ID})\\.jsonl$`, "i");
/** Claude Desktop's archive or delete of a session. */
const CLAUDE_RELEASED = new RegExp(`^(${SESSION_ID})\\.desktop-released\\.json$`, "i");
/**
 * `rollout-<local time>-<thread id>[_<rollout id>].jsonl[.zst]`; a reverted
 * thread has several, and the newest name is its current one.
 */
export const CODEX_ROLLOUT = new RegExp(
  `^rollout-(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2})-(${SESSION_ID})(?:_[^.]+)?\\.jsonl(\\.zst)?$`,
  "i",
);

/** Listing and stat calls one home may spend per sweep. */
const MAX_OPERATIONS_PER_HOME = 20_000;
/** How much of a transcript's start `readHead` reads: a first look, then at most this much. */
const FIRST_HEAD_BYTES = 64 * 1024;
const HEAD_BYTES = 1024 * 1024;
/** The client name T3 Code (and so Tempo) gives Codex; see CodexProvider.ts. */
const T3_CODEX_ORIGINATOR = "T3 Code";
/** Codex's state database; Codex uses no other name (state/src/sqlite.rs). */
export const CODEX_STATE_DATABASE = "state_5.sqlite";

const EMPTY: NativeDiscovery = { transcripts: [], archivedIds: new Set(), complete: false };

/**
 * Whether a Codex thread is the person's own: started in the TUI, the desktop
 * app or an editor (`cli`, `vscode`, a ChatGPT surface's `custom` source), by
 * the person rather than a feature, and not by Tempo or T3 Code.
 */
const isForeignCodexThread = (input: {
  /** The database's text column, or the rollout's JSON value (an object for sub-agents). */
  readonly source: unknown;
  readonly threadSource: string | null;
  readonly originator: string | null;
}) => {
  const interactive =
    typeof input.source === "string"
      ? ["cli", "vscode"].includes(input.source.trim()) ||
        input.source.trim().startsWith('{"custom"')
      : typeof input.source === "object" && input.source !== null && "custom" in input.source;
  return (
    !interactive ||
    (input.threadSource !== null && input.threadSource !== "user") ||
    input.originator === T3_CODEX_ORIGINATOR
  );
};

/** The fields of a transcript record that tell where and by what a session started. */
const HeadRecord = Schema.Struct({
  type: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  entrypoint: Schema.optional(Schema.String),
  isSidechain: Schema.optional(Schema.Boolean),
  payload: Schema.optional(
    Schema.Struct({
      cwd: Schema.optional(Schema.String),
      originator: Schema.optional(Schema.String),
      source: Schema.optional(Schema.Unknown),
      thread_source: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});
const decodeHeadRecord = Schema.decodeUnknownOption(Schema.fromJsonString(HeadRecord));

interface CodexThreadRow {
  readonly id: string;
  readonly archived: boolean;
  readonly title: string | null;
  readonly foreign: boolean;
  readonly rolloutPath: string | null;
}

/** A non-empty trimmed text column, or null. */
export const textColumn = (value: unknown) =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : null;

/** A table's columns, so a read can ask for what this version of the app has. */
export const tableColumns = (database: NodeSqlite.DatabaseSync, table: string) =>
  new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );

/**
 * `read` over a private copy of a SQLite database and its write-ahead log:
 * opening the native app's own files would touch them while it writes them.
 */
export const readSqliteCopy = Effect.fn("nativeDiscovery.readSqliteCopy")(function* <A>(
  databasePath: string,
  read: (database: NodeSqlite.DatabaseSync) => A,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-native-" });
  const copy = path.join(directory, path.basename(databasePath));
  yield* fileSystem.copyFile(databasePath, copy);
  yield* fileSystem.copyFile(`${databasePath}-wal`, `${copy}-wal`).pipe(Effect.ignore);
  return yield* Effect.try(() => {
    const database = new NodeSqlite.DatabaseSync(copy);
    try {
      return read(database);
    } finally {
      database.close();
    }
  });
}, Effect.scoped);

const readCodexThreadRows = (database: NodeSqlite.DatabaseSync): ReadonlyArray<CodexThreadRow> => {
  const columns = tableColumns(database, "threads");
  if (!columns.has("id") || !columns.has("archived")) return [];
  const optional = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
  const rows = database
    .prepare(
      `SELECT id, archived, ${["rollout_path", "name", "source", "thread_source", "originator"].map(optional).join(", ")} FROM threads`,
    )
    .all();
  const spawned = new Set<string>();
  if (tableColumns(database, "thread_spawn_edges").has("child_thread_id")) {
    for (const row of database.prepare("SELECT child_thread_id FROM thread_spawn_edges").all()) {
      spawned.add(String(row.child_thread_id).toLowerCase());
    }
  }
  return rows.map((row) => {
    const id = String(row.id).toLowerCase();
    return {
      id,
      archived: Number(row.archived) === 1,
      title: textColumn(row.name),
      rolloutPath: textColumn(row.rollout_path),
      foreign:
        spawned.has(id) ||
        isForeignCodexThread({
          source: textColumn(row.source),
          threadSource: textColumn(row.thread_source),
          originator: textColumn(row.originator),
        }),
    };
  });
};

export const makeNativeDiscovery = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const listDirectory = (directory: string) =>
    fileSystem.readDirectory(directory).pipe(Effect.option);
  const statFile = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info) =>
        info.type === "File" && Option.isSome(info.mtime)
          ? Option.some({ size: Number(info.size), mtimeMs: info.mtime.value.getTime() })
          : Option.none(),
      ),
      Effect.orElseSucceed(() => Option.none()),
    );

  /**
   * A folder's entries. One that is there but cannot be listed leaves the walk
   * incomplete, so its threads do not look deleted.
   */
  const listWalked = (directory: string, walk: { complete: boolean }) =>
    listDirectory(directory).pipe(
      Effect.flatMap(
        Option.match({
          onSome: (entries) => Effect.succeed(entries),
          onNone: () =>
            fileSystem.stat(directory).pipe(
              Effect.map((info): ReadonlyArray<string> => {
                if (info.type === "Directory") walk.complete = false;
                return [];
              }),
              Effect.orElseSucceed((): ReadonlyArray<string> => []),
            ),
        }),
      ),
    );

  const claude = Effect.fn("nativeDiscovery.claude")(function* (home: string) {
    const projectsDir = path.join(home, "projects");
    const folders = yield* listDirectory(projectsDir);
    if (Option.isNone(folders)) return EMPTY;
    let operations = 0;
    const walk = { complete: true };
    const transcripts: Array<NativeTranscript> = [];
    const released = new Set<string>();
    for (const folder of folders.value) {
      if (++operations > MAX_OPERATIONS_PER_HOME) {
        walk.complete = false;
        break;
      }
      for (const entry of yield* listWalked(path.join(projectsDir, folder), walk)) {
        const releasedId = CLAUDE_RELEASED.exec(entry)?.[1];
        if (releasedId !== undefined) released.add(releasedId.toLowerCase());
        const nativeId = CLAUDE_TRANSCRIPT.exec(entry)?.[1];
        if (nativeId === undefined) continue;
        if (++operations > MAX_OPERATIONS_PER_HOME) {
          walk.complete = false;
          break;
        }
        const filePath = path.join(projectsDir, folder, entry);
        const stats = yield* statFile(filePath);
        if (Option.isNone(stats)) continue;
        transcripts.push({
          driver: "claudeAgent",
          nativeId: nativeId.toLowerCase(),
          filePath,
          ...stats.value,
          title: null,
          foreign: null,
          compressed: false,
        });
      }
    }
    return {
      transcripts: transcripts
        .filter((transcript) => !released.has(transcript.nativeId))
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs),
      // The CLI has no archive; Claude Desktop marks the sessions it archives or deletes.
      archivedIds: released,
      complete: walk.complete,
    } satisfies NativeDiscovery;
  });

  // The database copy is read again only when Codex has written to it since.
  let codexRows: {
    readonly key: string;
    readonly rows: ReadonlyMap<string, CodexThreadRow>;
  } | null = null;
  /**
   * Codex's threads by id: empty without a database (older Codex), the last
   * good read while a copy cannot be read, and none before any good read.
   */
  const codexThreadRows = Effect.fn("nativeDiscovery.codexThreadRows")(function* (home: string) {
    const databasePath = path.join(home, CODEX_STATE_DATABASE);
    const stats = yield* Effect.forEach([databasePath, `${databasePath}-wal`], statFile);
    if (stats[0] === undefined || Option.isNone(stats[0])) {
      return Option.some<ReadonlyMap<string, CodexThreadRow>>(new Map());
    }
    const key = `${databasePath}|${stats
      .map((entry) =>
        Option.match(entry, { onNone: () => "-", onSome: (s) => `${s.size}:${s.mtimeMs}` }),
      )
      .join("|")}`;
    if (codexRows?.key === key) return Option.some(codexRows.rows);
    const read = yield* readSqliteCopy(databasePath, readCodexThreadRows).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.map((list) => new Map(list.map((row) => [row.id, row]))),
      Effect.option,
    );
    if (Option.isNone(read)) {
      yield* Effect.logWarning("could not read Codex's thread list", { databasePath });
      return Option.map(Option.fromNullishOr(codexRows), (cached) => cached.rows);
    }
    codexRows = { key, rows: read.value };
    return Option.some<ReadonlyMap<string, CodexThreadRow>>(read.value);
  });

  const codex = Effect.fn("nativeDiscovery.codex")(function* (home: string) {
    const sessionsDir = path.join(home, "sessions");
    const years = yield* listDirectory(sessionsDir);
    if (Option.isNone(years)) return EMPTY;
    // Without its archive flags an archived thread would look active: wait for a good read.
    const knownRows = yield* codexThreadRows(home);
    if (Option.isNone(knownRows)) return EMPTY;
    const rows = knownRows.value;
    const walk = { complete: true };
    const newestFirst = (directory: string) =>
      listWalked(directory, walk).pipe(Effect.map((entries) => entries.toSorted().toReversed()));
    let operations = 0;
    // A thread's newest rollout is its current one; the walk meets it first.
    const current = new Map<string, { readonly filePath: string; readonly compressed: boolean }>();
    walking: for (const year of years.value.toSorted().toReversed()) {
      for (const month of yield* newestFirst(path.join(sessionsDir, year))) {
        for (const day of yield* newestFirst(path.join(sessionsDir, year, month))) {
          const directory = path.join(sessionsDir, year, month, day);
          for (const entry of yield* newestFirst(directory)) {
            const match = CODEX_ROLLOUT.exec(entry);
            const nativeId = match?.[2]?.toLowerCase();
            if (nativeId === undefined || current.has(nativeId)) continue;
            if (++operations > MAX_OPERATIONS_PER_HOME) {
              walk.complete = false;
              break walking;
            }
            current.set(nativeId, {
              filePath: path.join(directory, entry),
              compressed: match?.[3] !== undefined,
            });
          }
        }
      }
    }
    const transcripts: Array<NativeTranscript> = [];
    for (const [nativeId, file] of current) {
      const row = rows.get(nativeId);
      if (row?.archived === true) continue;
      // Codex's own record of the current rollout, while it still points at one.
      const recorded =
        row?.rolloutPath?.startsWith(`${sessionsDir}${path.sep}`) === true ? row.rolloutPath : null;
      const recordedStats = recorded === null ? Option.none() : yield* statFile(recorded);
      const filePath = Option.isSome(recordedStats) && recorded !== null ? recorded : file.filePath;
      const stats = Option.isSome(recordedStats) ? recordedStats : yield* statFile(filePath);
      if (Option.isNone(stats)) continue;
      transcripts.push({
        driver: "codex",
        nativeId,
        filePath,
        ...stats.value,
        title: row?.title ?? null,
        foreign: row?.foreign ?? null,
        compressed: filePath.endsWith(".zst"),
      });
    }
    return {
      transcripts: transcripts.toSorted((a, b) => b.mtimeMs - a.mtimeMs),
      archivedIds: new Set([...rows.values()].filter((row) => row.archived).map((row) => row.id)),
      complete: walk.complete,
    } satisfies NativeDiscovery;
  });

  /**
   * The working directory a transcript records, and whether it is the
   * person's own thread: Claude Code marks SDK and scripted sessions with an
   * `sdk-*` entrypoint, and Codex records its client and source in the
   * rollout's first line.
   */
  const decideHead = (transcript: NativeTranscript, text: string) => {
    let cwd: string | null = null;
    let foreign = transcript.foreign;
    for (const line of text.split("\n")) {
      const record = decodeHeadRecord(line);
      if (Option.isNone(record)) continue;
      const { type, payload } = record.value;
      if (transcript.driver === "claudeAgent") {
        cwd ??= record.value.cwd ?? null;
        if (foreign === null && record.value.entrypoint !== undefined) {
          foreign = record.value.entrypoint.startsWith("sdk") || record.value.isSidechain === true;
        }
      } else if (type === "session_meta") {
        cwd = payload?.cwd ?? null;
        foreign ??= isForeignCodexThread({
          source: payload?.source,
          threadSource: payload?.thread_source ?? null,
          originator: payload?.originator ?? null,
        });
      }
      if (cwd !== null && foreign !== null) return { cwd, foreign };
    }
    // An older Claude Code wrote no entrypoint.
    return cwd === null ? null : { cwd, foreign: foreign === true };
  };

  const readHead = Effect.fn("nativeDiscovery.readHead")(function* (transcript: NativeTranscript) {
    // Most heads fit the first read; a Codex rollout's first line carries its instructions.
    for (const length of [FIRST_HEAD_BYTES, HEAD_BYTES]) {
      const bytes = yield* Effect.scoped(
        fileSystem
          .open(transcript.filePath, { flag: "r" })
          .pipe(Effect.flatMap((file) => file.readAlloc(Math.min(length, transcript.size)))),
      ).pipe(Effect.orElseSucceed(() => Option.none<Uint8Array>()));
      if (Option.isNone(bytes)) return null;
      const head = decideHead(transcript, new TextDecoder().decode(bytes.value));
      if (head !== null || bytes.value.byteLength >= transcript.size) return head;
    }
    return null;
  });

  return { claude, codex, readHead };
});
