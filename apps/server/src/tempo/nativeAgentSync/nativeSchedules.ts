/**
 * Native scheduled tasks as Tempo tasks, created paused so none runs twice; the person turns each on.
 * Claude Code's one-shot reminders stay out (Tempo would repeat them). Its tasks made in a session
 * and Codex heartbeats run in the synced thread, others in fresh ones. Updates keep on or off; a
 * native deletion removes the task unless the person turned it on; one removed here stays removed.
 */
import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ModelSelection,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import { readSqliteCopy, tableColumns, textColumn, type NativeDriver } from "./nativeDiscovery.ts";
import { scheduleFromCron, scheduleFromRrule, type ScheduleMapping } from "./scheduleMapping.ts";

/** Imported tasks' ids start with this; the rest is a digest of where the native task lives. */
const TASK_ID_PREFIX = "tempo-native:";
const TITLE_LENGTH = 60;
/** The Codex app's own default when an automation has no rule. */
const CODEX_DEFAULT_RRULE = "FREQ=HOURLY;INTERVAL=24;BYMINUTE=0";

const NATIVE_APP_NAMES: Readonly<Record<NativeDriver, string>> = {
  claudeAgent: "Claude Code",
  codex: "Codex",
};

/** What the sync remembers of an imported task: where it lives and what it last was. */
export const NativeTaskRecord = Schema.Struct({
  root: Schema.String,
  digest: Schema.String,
});
export type NativeTaskRecord = typeof NativeTaskRecord.Type;

// Claude Code skips a malformed task and keeps the rest; so does this read.
const decodeClaudeTasksFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ tasks: Schema.Array(Schema.Unknown) })),
);
const decodeClaudeTask = Schema.decodeUnknownOption(
  Schema.Struct({
    id: Schema.String,
    cron: Schema.String,
    prompt: Schema.String,
    recurring: Schema.optional(Schema.Boolean),
    createdBySessionId: Schema.optional(Schema.String),
  }),
);

const CodexAutomation = Schema.Struct({
  version: Schema.optional(Schema.Number),
  id: Schema.String,
  kind: Schema.optional(Schema.String),
  name: Schema.String,
  prompt: Schema.String,
  status: Schema.String,
  rrule: Schema.optional(Schema.String),
  model: Schema.optional(Schema.String),
  execution_environment: Schema.optional(Schema.String),
  cwds: Schema.optional(Schema.Array(Schema.String)),
  target_thread_id: Schema.optional(Schema.String),
  updated_at: Schema.optional(Schema.Number),
});
type CodexAutomation = typeof CodexAutomation.Type;
const decodeCodexAutomation = Schema.decodeUnknownOption(CodexAutomation);
const decodeStringList = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const TOML_ESCAPES: Readonly<Record<string, string>> = {
  b: "\b",
  t: "\t",
  n: "\n",
  f: "\f",
  r: "\r",
  '"': '"',
  "\\": "\\",
};

/** A TOML basic string's body, or null at a malformed escape. */
const unescapeTomlString = (body: string): string | null => {
  let result = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char !== "\\") {
      result += char;
      continue;
    }
    const next = body[index + 1] ?? "";
    if (next === "u" || next === "U") {
      const length = next === "u" ? 4 : 8;
      const code = Number.parseInt(body.slice(index + 2, index + 2 + length), 16);
      if (!Number.isFinite(code)) return null;
      result += String.fromCodePoint(code);
      index += 1 + length;
      continue;
    }
    const escaped = TOML_ESCAPES[next];
    if (escaped === undefined) return null;
    result += escaped;
    index += 1;
  }
  return result;
};

const tomlValue = (text: string): unknown => {
  const string = /^"((?:[^"\\]|\\.)*)"$/.exec(text);
  if (string !== null) return unescapeTomlString(string[1] ?? "");
  if (text === "true" || text === "false") return text === "true";
  if (/^-?\d+$/.test(text)) return Number(text);
  if (text.startsWith("[") && text.endsWith("]")) {
    const items = [...text.slice(1, -1).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((match) =>
      unescapeTomlString(match[1] ?? ""),
    );
    return items.every((item) => item !== null) ? items : undefined;
  }
  return undefined;
};

/**
 * The top-level `key = value` lines of an `automation.toml`, as the Codex app
 * writes them: basic strings, numbers, booleans and string arrays, one per
 * line. Not a TOML parser; other values (the inline `target` table) are left out.
 */
const parseAutomationToml = (text: string): Record<string, unknown> => {
  const fields: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (match === null) continue;
    const value = tomlValue(match[2] ?? "");
    if (value !== undefined && value !== null) fields[match[1] ?? ""] = value;
  }
  return fields;
};

/** One native task, before it is matched to Tempo. */
interface NativeTask {
  readonly driver: NativeDriver;
  /** Where it is kept: its project folder, or the Codex home. */
  readonly root: string;
  /** Unique across native tasks; the Tempo task id is its digest. */
  readonly key: string;
  readonly name: string | null;
  readonly prompt: string;
  readonly schedule: ScheduleMapping;
  /** The native schedule, shown in the title when Tempo cannot follow it exactly. */
  readonly scheduleText: string;
  /** The native session it runs in; null runs a fresh thread in `workspaceRoot`. */
  readonly sessionId: string | null;
  readonly workspaceRoot: string | null;
  readonly model: string | null;
  /** Each run in a new worktree rather than the folder itself. */
  readonly worktree: boolean;
}

/** The imported threads the sync knows, as tasks bind to them. */
export interface TaskThread {
  readonly projectId: ProjectId;
  readonly deleted: boolean;
  readonly worktreePath: string | null;
}

export interface NativeSchedulesInput {
  readonly homes: { readonly claude: string | null; readonly codex: string | null };
  readonly state: Readonly<Record<string, NativeTaskRecord>>;
  readonly threads: ReadonlyMap<ThreadId, TaskThread>;
  /** The Tempo project for a folder, created when missing; null keeps the folder's tasks out. */
  readonly projectFor: (workspaceRoot: string) => Effect.Effect<ProjectId | null>;
}

export interface NativeSchedulesResult {
  readonly state: Readonly<Record<string, NativeTaskRecord>>;
  readonly created: number;
  readonly updated: number;
  readonly removed: number;
  /**
   * The folders outside the native homes whose tasks or presence this sync
   * read: Claude Code's task folders and the Codex app's automation folders.
   */
  readonly folders: ReadonlyArray<string>;
}

/** "Check the deploy (Claude Code)", with the native schedule when Tempo cannot follow it exactly. */
const importedTaskTitle = (input: {
  readonly driver: NativeDriver;
  readonly name: string | null;
  readonly prompt: string;
  readonly scheduleText: string;
  readonly exact: boolean;
}) => {
  const line = (input.name ?? input.prompt).trim().split("\n")[0]?.trim() ?? "";
  const summary =
    line.length > TITLE_LENGTH ? `${line.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : line;
  const origin = NATIVE_APP_NAMES[input.driver];
  const note = input.exact ? origin : `${origin}, runs ${input.scheduleText} there`;
  return `${summary === "" ? "Scheduled task" : summary} (${note})`;
};

/** A Codex automation as the tasks it makes: one per folder for "cron", one in its thread for "heartbeat". */
const codexTasks = (codexHome: string, automation: CodexAutomation): ReadonlyArray<NativeTask> => {
  if (automation.status === "DELETED" || automation.prompt.trim() === "") return [];
  const rrule = automation.rrule?.trim() || CODEX_DEFAULT_RRULE;
  const schedule = scheduleFromRrule(rrule);
  if (schedule === null) return [];
  const common = {
    driver: "codex" as const,
    root: codexHome,
    name: automation.name,
    prompt: automation.prompt,
    schedule,
    scheduleText: rrule,
    model: automation.model?.trim() || null,
    worktree: automation.execution_environment !== "local",
  };
  if (automation.kind === "heartbeat") {
    const threadId = automation.target_thread_id?.trim().toLowerCase();
    return threadId
      ? [
          {
            ...common,
            key: `codex\0${automation.id}`,
            sessionId: threadId,
            workspaceRoot: null,
          },
        ]
      : [];
  }
  return (automation.cwds ?? []).map((cwd) => ({
    ...common,
    key: `codex\0${automation.id}\0${cwd}`,
    sessionId: null,
    workspaceRoot: cwd,
  }));
};

const readCodexDatabaseAutomations = (
  database: Parameters<Parameters<typeof readSqliteCopy>[1]>[0],
): ReadonlyArray<CodexAutomation> => {
  const columns = tableColumns(database, "automations");
  if (!["id", "name", "prompt", "status"].every((column) => columns.has(column))) return [];
  const optional = (name: string) => (columns.has(name) ? name : `NULL AS ${name}`);
  const rows = database
    .prepare(
      // Deleted rows too: a delete there outranks an older TOML copy.
      `SELECT id, name, prompt, status, ${["rrule", "model", "cwds", "kind", "target_thread_id", "execution_environment", "updated_at"].map(optional).join(", ")} FROM automations`,
    )
    .all();
  return rows.flatMap((row) => {
    const automation = decodeCodexAutomation({
      id: String(row.id),
      name: String(row.name),
      prompt: String(row.prompt),
      status: String(row.status),
      ...(textColumn(row.rrule) === null ? {} : { rrule: textColumn(row.rrule) }),
      ...(textColumn(row.model) === null ? {} : { model: textColumn(row.model) }),
      ...(textColumn(row.kind) === null ? {} : { kind: textColumn(row.kind) }),
      ...(textColumn(row.target_thread_id) === null
        ? {}
        : { target_thread_id: textColumn(row.target_thread_id) }),
      ...(textColumn(row.execution_environment) === null
        ? {}
        : { execution_environment: textColumn(row.execution_environment) }),
      ...(typeof row.updated_at === "number" ? { updated_at: row.updated_at } : {}),
      cwds: Option.getOrElse(decodeStringList(textColumn(row.cwds) ?? "[]"), () => []),
    });
    return Option.toArray(automation);
  });
};

export const makeNativeSchedules = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;

  const digest = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(
      Effect.map((bytes) => Hex.encode(bytes).slice(0, 24)),
      Effect.orDie,
    );
  const exists = (target: string) =>
    fileSystem.exists(target).pipe(Effect.orElseSucceed(() => false));

  /**
   * A folder's tasks, or null when they cannot be read: the folder is gone or
   * unmounted, or the file is mid-write. Only a missing file means no tasks.
   */
  const readClaudeTasks = Effect.fn("nativeSchedules.readClaudeTasks")(function* (root: string) {
    if (!(yield* exists(root))) return null;
    const filePath = path.join(root, ".claude", "scheduled_tasks.json");
    if (!(yield* exists(filePath))) return [];
    const text = yield* fileSystem.readFileString(filePath).pipe(Effect.option);
    const file = Option.flatMap(text, decodeClaudeTasksFile);
    if (Option.isNone(file)) return null;
    return file.value.tasks.flatMap((entry): ReadonlyArray<NativeTask> => {
      const decoded = decodeClaudeTask(entry);
      if (Option.isNone(decoded)) return [];
      const task = decoded.value;
      const schedule = scheduleFromCron(task.cron);
      if (task.recurring !== true || task.prompt.trim() === "" || schedule === null) return [];
      const sessionId = task.createdBySessionId?.trim().toLowerCase() || null;
      return [
        {
          driver: "claudeAgent",
          root,
          key: `claudeAgent\0${root}\0${task.id}`,
          name: null,
          prompt: task.prompt,
          schedule,
          scheduleText: `cron ${task.cron}`,
          sessionId,
          workspaceRoot: root,
          model: null,
          worktree: false,
        },
      ];
    });
  });

  // The database copy is read again only when the Codex app has written to it since.
  let codexDatabase: {
    readonly key: string;
    readonly rows: ReadonlyArray<CodexAutomation>;
  } | null = null;
  /** The app's automations table: empty without one, null when a copy cannot be read. */
  const readCodexDatabase = Effect.fn("nativeSchedules.readCodexDatabase")(function* (
    databasePath: string,
  ) {
    const stats = yield* Effect.forEach([databasePath, `${databasePath}-wal`], (file) =>
      fileSystem.stat(file).pipe(
        Effect.map((info) => `${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`),
        Effect.orElseSucceed(() => "-"),
      ),
    );
    if (stats[0] === "-") return [];
    const key = `${databasePath}|${stats.join("|")}`;
    if (codexDatabase?.key === key) return codexDatabase.rows;
    const read = yield* readSqliteCopy(databasePath, readCodexDatabaseAutomations).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.option,
    );
    if (Option.isNone(read)) {
      yield* Effect.logWarning("could not read the Codex app's automations", { databasePath });
      return null;
    }
    codexDatabase = { key, rows: read.value };
    return read.value;
  });

  /**
   * The Codex app's automations, or null when they cannot be read in full.
   * Both stores count, the app's database and its TOML files, newest copy
   * first and the database on a tie.
   */
  const readCodexTasks = Effect.fn("nativeSchedules.readCodexTasks")(function* (codexHome: string) {
    if (!(yield* exists(codexHome))) return null;
    const rows = yield* readCodexDatabase(path.join(codexHome, "sqlite", "codex.db"));
    if (rows === null) return null;
    const byId = new Map<string, CodexAutomation>();
    const keep = (automation: CodexAutomation) => {
      const current = byId.get(automation.id);
      if (current === undefined || (automation.updated_at ?? 0) > (current.updated_at ?? 0)) {
        byId.set(automation.id, automation);
      }
    };
    for (const automation of rows) keep(automation);
    const automationsDir = path.join(codexHome, "automations");
    if (yield* exists(automationsDir)) {
      const folders = yield* fileSystem.readDirectory(automationsDir).pipe(Effect.option);
      if (Option.isNone(folders)) return null;
      for (const folder of folders.value) {
        const file = path.join(automationsDir, folder, "automation.toml");
        if (!(yield* exists(file))) continue;
        const text = yield* fileSystem.readFileString(file).pipe(Effect.option);
        if (Option.isNone(text)) return null;
        const automation = decodeCodexAutomation(parseAutomationToml(text.value));
        // The app reads a file only when its id names its folder.
        if (Option.isSome(automation) && automation.value.id === folder) keep(automation.value);
      }
    }
    return [...byId.values()].flatMap((automation) => codexTasks(codexHome, automation));
  });

  const defaultModel = (driver: NativeDriver): ModelSelection => ({
    instanceId: ProviderInstanceId.make(driver),
    model: DEFAULT_MODEL_BY_PROVIDER[ProviderDriverKind.make(driver)] ?? DEFAULT_MODEL,
  });

  /** The Tempo task for a native one, or null when it has nowhere to run here. */
  const toUpsert = Effect.fn("nativeSchedules.toUpsert")(function* (
    task: NativeTask,
    input: NativeSchedulesInput,
  ) {
    const boundId =
      task.sessionId === null ? null : ThreadId.make(`import:${task.driver}:${task.sessionId}`);
    const bound = boundId === null ? undefined : input.threads.get(boundId);
    const threadId = bound === undefined || bound.deleted ? null : boundId;
    // A heartbeat runs only in its own thread.
    if (threadId === null && task.workspaceRoot === null) return null;
    const projectId =
      threadId !== null && bound !== undefined
        ? bound.projectId
        : task.workspaceRoot === null
          ? null
          : yield* input.projectFor(task.workspaceRoot);
    if (projectId === null) return null;
    const shell = threadId === null ? null : yield* orchestrator.getThreadShell(threadId);
    const model =
      task.model === null
        ? (shell?.modelSelection ?? defaultModel(task.driver))
        : { instanceId: ProviderInstanceId.make(task.driver), model: task.model };
    return {
      title: importedTaskTitle({ ...task, exact: task.schedule.exact }),
      prompt: task.prompt,
      schedule: task.schedule.schedule,
      projectId,
      threadId,
      // The defaults agents' schedule_task uses for a fresh thread in a worktree.
      workspaceStrategy:
        threadId === null && task.worktree
          ? { type: "worktree", baseRef: "main", startFromOrigin: true }
          : { type: "root" },
      modelSelection: model,
      runtimeMode: shell?.runtimeMode ?? DEFAULT_RUNTIME_MODE,
      interactionMode: shell?.interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE,
      createdBy: "system",
      creationSource: "server",
    } satisfies Omit<ScheduledTaskUpsertInput, "enabled" | "id">;
  });

  const sync = Effect.fn("nativeSchedules.sync")(function* (input: NativeSchedulesInput) {
    // Where the native tasks were read in full: only there does a missing task mean deleted.
    const read = new Set<string>();
    const tasks: Array<NativeTask> = [];
    const folders = new Set<string>();
    if (input.homes.claude !== null) {
      const roots = new Set(
        (yield* projectStore.listShells()).map((project) => project.workspaceRoot),
      );
      for (const thread of input.threads.values()) {
        if (!thread.deleted && thread.worktreePath !== null) roots.add(thread.worktreePath);
      }
      for (const root of roots) {
        folders.add(root);
        const found = yield* readClaudeTasks(root);
        if (found === null) continue;
        read.add(root);
        tasks.push(...found);
      }
    }
    if (input.homes.codex !== null) {
      const found = yield* readCodexTasks(input.homes.codex);
      if (found !== null) {
        read.add(input.homes.codex);
        tasks.push(...found);
      }
    }
    const native = new Map<string, NativeTask>();
    for (const task of tasks) {
      native.set(`${TASK_ID_PREFIX}${yield* digest(task.key)}`, task);
      if (task.workspaceRoot !== null) folders.add(task.workspaceRoot);
    }

    const existing = new Map<string, ScheduledTask>(
      (yield* scheduledTasks.list()).tasks
        .filter((task) => task.id.startsWith(TASK_ID_PREFIX))
        .map((task) => [task.id, task]),
    );
    const state: Record<string, NativeTaskRecord> = { ...input.state };
    let created = 0;
    let updated = 0;
    let removed = 0;
    for (const [taskId, task] of native) {
      const id = ScheduledTaskId.make(taskId);
      const upsert = yield* toUpsert(task, input);
      if (upsert === null) continue;
      // The native task and where it runs; the bound thread's model and modes are Tempo's own.
      const record = {
        root: task.root,
        digest: yield* digest(
          [
            task.key,
            upsert.title,
            task.prompt,
            task.scheduleText,
            task.model ?? "",
            upsert.workspaceStrategy.type,
            upsert.projectId,
            upsert.threadId ?? "",
          ].join("\0"),
        ),
      };
      const current = existing.get(id);
      if (current === undefined) {
        // Removed here after an import: the person's choice stands.
        if (state[id] !== undefined) continue;
        yield* scheduledTasks.upsert({ ...upsert, id, enabled: false });
        created += 1;
      } else if (state[id]?.digest !== record.digest) {
        yield* scheduledTasks.upsert({ ...upsert, id, enabled: current.enabled });
        updated += 1;
      }
      state[id] = record;
    }
    for (const [id, record] of Object.entries(state)) {
      if (native.has(id) || !read.has(record.root)) continue;
      const current = existing.get(id);
      if (current !== undefined && !current.enabled) {
        yield* scheduledTasks.delete({ id: current.id });
        removed += 1;
      }
      delete state[id];
    }
    return {
      state,
      created,
      updated,
      removed,
      folders: [...folders],
    } satisfies NativeSchedulesResult;
  });

  return { sync };
});
