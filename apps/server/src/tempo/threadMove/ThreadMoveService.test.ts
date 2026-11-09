import * as NodeHttpPlatform from "@effect/platform-node/NodeHttpPlatform";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES,
  TempoThreadMoveId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type TempoThreadMoveFolderEntry,
  type OrchestrationProjectShell,
  type ScheduledTask,
  type RepositoryIdentity,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { HttpRouter } from "effect/http";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../../config.ts";
import * as GitManager from "../../git/GitManager.ts";
import * as GitWorkflow from "../../git/GitWorkflowService.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../../orchestration-v2/ThreadCommandExecutor.ts";
import * as SqlitePersistence from "../../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "../../project/ProjectSetupScriptRunner.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import * as ProviderInstanceRegistry from "../../provider/ProviderInstanceRegistry.ts";
import * as ScheduledTaskService from "../../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { readArchiveManifest, writeArchive } from "./ThreadMoveArchive.ts";
import { MAX_FOLDER_ENTRIES } from "./ThreadMoveFolder.ts";
import * as ThreadMoveHttp from "./ThreadMoveHttp.ts";
import { buildMovedThreadEvents, movedThreadId } from "./ThreadMoveThread.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";
import { THREAD_MOVE_DOWNLOAD_PREFIX, THREAD_MOVE_UPLOAD_PREFIX } from "./ThreadMoveTokens.ts";

const sourceProjectId = ProjectId.make("source-project");
const targetProjectId = ProjectId.make("target-project");
/** A plain folder on the laptop: no Git remote, so its threads move as a copy of it. */
const folderProjectId = ProjectId.make("folder-project");
const identity: RepositoryIdentity = {
  canonicalKey: "github.com/acme/app",
  locator: {
    source: "git-remote",
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/app.git",
  },
  displayName: "acme/app",
};

/** Paths the test's two "machines" use, filled in once the repositories exist. */
const machines = { source: "", target: "", folder: "" };
/** The target's "No project" project, once a folder move created it. */
const scratch: { project: { readonly id: ProjectId; readonly workspaceRoot: string } | null } = {
  project: null,
};
function scheduledTask(id: string, threadId: string | null, enabled: boolean): ScheduledTask {
  return {
    id: ScheduledTaskId.make(id),
    title: "Nightly check",
    prompt: "Check the importer.",
    enabled,
    schedule: { type: "interval", everyMs: 3_600_000 },
    projectId: sourceProjectId,
    threadId: threadId === null ? null : ThreadId.make(threadId),
    workspaceStrategy: { type: "root" },
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    nextRunAt: null,
    lastRunAt: null,
    lastRunStatus: "never",
    lastRunError: null,
    runCount: 0,
  };
}
const scheduledTasks = [
  scheduledTask("bound", "laptop-thread", true),
  scheduledTask("already-off", "laptop-thread", false),
  scheduledTask("elsewhere", null, true),
];

/** Setup scripts the target started, and scheduled tasks the source paused. */
const recorded = { setupRuns: [] as Array<string>, paused: [] as Array<string> };

function projectShell(
  id: ProjectId,
  workspaceRoot: string,
  repositoryIdentity: RepositoryIdentity | null = identity,
): OrchestrationProjectShell {
  return {
    id,
    title: "tempo",
    workspaceRoot,
    repositoryIdentity,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
}

const layerDatabase = SqlitePersistence.layerMemory;
const layerStores = Layer.mergeAll(
  layerDatabase,
  EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
  ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
);
const layerVcsProcess = VcsProcess.layer.pipe(Layer.provide(NodeServices.layer));
const layerGitDriver = GitVcsDriver.layer.pipe(Layer.provide(layerVcsProcess));

const layerProjects = Layer.mock(ProjectService.ProjectService)({
  getById: (projectId) => {
    const project =
      projectId === sourceProjectId
        ? projectShell(sourceProjectId, machines.source)
        : projectId === targetProjectId
          ? projectShell(targetProjectId, machines.target)
          : projectId === folderProjectId
            ? projectShell(folderProjectId, machines.folder, null)
            : projectId === scratch.project?.id
              ? projectShell(projectId, scratch.project.workspaceRoot, null)
              : null;
    return Effect.succeed(
      project === null ? Option.none() : Option.some({ ...project, deletedAt: null }),
    );
  },
  // The target machine only knows its own checkout of the repository.
  listShells: () => Effect.succeed([projectShell(targetProjectId, machines.target)]),
  // How the target's "No project" project comes to exist on the first folder move.
  bootstrap: (input) =>
    Effect.sync(() => {
      scratch.project ??= { id: input.projectId, workspaceRoot: input.workspaceRoot };
      return {
        project: {
          ...projectShell(scratch.project.id, scratch.project.workspaceRoot, null),
          deletedAt: null,
        },
        created: false,
      };
    }),
});

// The real folders for threads without a project, so a moved folder lands where new ones do.
const layerManagedFolders = ManagedProjectFolders.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      layerProjects,
      layerGitDriver,
      GitWorkflow.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
        Layer.provide(layerGitDriver),
      ),
    ),
  ),
);

// The orchestrator reads straight from the real projection store, so the
// service sees exactly what its own event writes produced.
const layerOrchestratorReads = Layer.unwrap(
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const projectionError = (threadId: ThreadId) => (cause: unknown) =>
      new Orchestrator.OrchestratorProjectionError({ threadId, cause });
    return Layer.mock(Orchestrator.OrchestratorV2)({
      getThreadShell: (threadId) =>
        projections.getThreadShell(threadId).pipe(Effect.mapError(projectionError(threadId))),
      getThreadProjection: (threadId) =>
        projections.getThreadProjection(threadId).pipe(Effect.mapError(projectionError(threadId))),
      getThreadRecords: (threadId, fields) =>
        projections
          .getThreadRecords(threadId, fields)
          .pipe(Effect.mapError(projectionError(threadId))),
    });
  }),
);

const layerTest = ThreadMoveService.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerOrchestratorReads,
      EventSink.layer,
      ThreadCommandExecutor.layer,
      layerProjects,
      layerManagedFolders,
      Layer.mock(RepositoryIdentityResolver.RepositoryIdentityResolver)({
        resolve: (cwd) => Effect.succeed(cwd === machines.folder ? null : identity),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        listInstances: Effect.succeed([]),
      }),
      Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
        runForThread: (input) =>
          Effect.sync(() => {
            recorded.setupRuns.push(input.worktreePath);
            return {
              status: "started",
              scriptId: "setup",
              scriptName: "Install",
              scriptCommand: "vp i",
              terminalId: "setup-terminal",
              cwd: input.worktreePath,
              async: true,
            } as const;
          }),
      }),
      Layer.mock(ScheduledTaskService.ScheduledTaskService)({
        list: () => Effect.succeed({ tasks: scheduledTasks }),
        setEnabled: (input) =>
          Effect.sync(() => {
            recorded.paused.push(input.id);
            return { task: scheduledTasks[0]! };
          }),
      }),
      ServerSettings.layerTest(),
      CheckpointStore.layer.pipe(
        Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(layerVcsProcess))),
      ),
      layerGitDriver,
      layerVcsProcess,
      ServerSecretStore.layer,
    ).pipe(Layer.provideMerge(layerStores)),
  ),
  Layer.provideMerge(
    ServerConfig.ServerConfig.layerTest(process.cwd(), { prefix: "tempo-thread-move-service-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const vcsProcess = yield* VcsProcess.VcsProcess;
    const result = yield* vcsProcess.run({
      operation: "ThreadMoveService.test.git",
      command: "git",
      cwd,
      args,
      timeoutMs: 20_000,
    });
    return result.stdout.trim();
  });

const identifyCommitter = (cwd: string) =>
  Effect.forEach(
    [
      ["user.name", "Tempo Test"],
      ["user.email", "tempo-test@example.com"],
      ["commit.gpgsign", "false"],
    ] as const,
    ([key, value]) => git(cwd, ["config", key, value]),
    { discard: true },
  );

const setUpMachines = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "tempo-thread-move-service-" });
  recorded.setupRuns.length = 0;
  recorded.paused.length = 0;
  scratch.project = null;
  const remote = path.join(root, "remote.git");
  machines.source = path.join(root, "laptop");
  machines.target = path.join(root, "mini");
  machines.folder = path.join(root, "notes");
  yield* git(root, ["init", "--bare", "--initial-branch=main", remote]);
  yield* git(root, ["init", "--initial-branch=main", machines.source]);
  yield* identifyCommitter(machines.source);
  yield* fileSystem.writeFileString(path.join(machines.source, "app.ts"), "export {};\n");
  yield* git(machines.source, ["add", "app.ts"]);
  yield* git(machines.source, ["commit", "-m", "initial"]);
  yield* git(machines.source, ["remote", "add", "origin", remote]);
  yield* git(machines.source, ["push", "--quiet", "origin", "main"]);
  yield* git(root, ["clone", "--quiet", remote, machines.target]);
  yield* identifyCommitter(machines.target);
  yield* git(machines.source, ["switch", "--quiet", "-c", "tempo/fix-importer"]);
  yield* fileSystem.writeFileString(path.join(machines.source, "app.ts"), "export const a = 1;\n");
  yield* git(machines.source, ["commit", "-am", "unpushed"]);
  yield* fileSystem.writeFileString(path.join(machines.source, "notes.md"), "wip\n");
  return { root };
});

/**
 * A thread on the laptop, created the way any imported history is: in the
 * laptop's checkout, or with `inFolder` in the plain folder project.
 */
const seedSourceThread = (threadId: ThreadId, options: { readonly inFolder?: boolean } = {}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
    const seedMoveId = TempoThreadMoveId.make(`seed-${threadId}`);
    const cwd = options.inFolder === true ? machines.folder : machines.source;
    const events = buildMovedThreadEvents({
      eventPrefix: `tempo-move:${seedMoveId}`,
      thread: {
        title: "Fix the importer",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: at,
      },
      messages: [
        {
          role: "user",
          text: `Edit ${cwd}/app.ts`,
          attachments: [],
          createdAt: at,
          updatedAt: at,
        },
        { role: "assistant", text: "Edited.", attachments: [], createdAt: at, updatedAt: at },
      ],
      threadId,
      ...(options.inFolder === true
        ? { projectId: folderProjectId, branch: null, worktreePath: null }
        : {
            projectId: sourceProjectId,
            branch: "tempo/fix-importer",
            worktreePath: machines.source,
          }),
      // An earlier hop, so the trail is visible on the laptop's thread.
      movedFrom: {
        moveId: seedMoveId,
        environmentId: EnvironmentId.make("office"),
        environmentLabel: "Office",
        threadId: ThreadId.make("office-thread"),
        movedAt: "2026-10-01T09:00:00.000Z",
      },
      now: at,
      pathMappings: [],
      attachmentIds: new Map(),
    });
    yield* sink.write({ events });
  });

const transferToken = (relativeUrl: string, prefix: string) => relativeUrl.slice(prefix.length + 1);

/** The whole client-driven move, from one "machine" to the other. */
const moveThread = (input: {
  readonly threadId: ThreadId;
  readonly from: { readonly environmentId: EnvironmentId; readonly environmentLabel: string };
  readonly to: { readonly environmentId: EnvironmentId; readonly environmentLabel: string };
}) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const moves = yield* ThreadMoveService.ThreadMoveService;
    // As today's clients ask whenever the target takes folders.
    const prepared = yield* moves.prepareMove({ threadId: input.threadId, allowFolder: true });
    const archivePath = yield* moves.resolveDownload(
      transferToken(prepared.downloadRelativeUrl, THREAD_MOVE_DOWNLOAD_PREFIX),
    );
    const bytes = yield* fileSystem.readFile(archivePath!);
    const upload = yield* moves.createImportUpload({
      moveId: prepared.moveId,
      sizeBytes: bytes.byteLength,
      repository: prepared.repository,
    });
    const stored = yield* moves.receiveUpload(
      transferToken(upload.uploadRelativeUrl, THREAD_MOVE_UPLOAD_PREFIX),
      Stream.make(bytes),
      bytes.byteLength,
    );
    assert.isTrue(stored.ok);
    const imported = yield* moves.importMove({ moveId: prepared.moveId, source: input.from });
    yield* moves.finalizeMove({
      threadId: input.threadId,
      moveId: prepared.moveId,
      target: { ...input.to, threadId: imported.threadId },
    });
    return imported;
  });

describe("ThreadMoveService", () => {
  it.effect("moves a thread with its checkout, then leaves a stub behind", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* setUpMachines;
      const moves = yield* ThreadMoveService.ThreadMoveService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sourceThreadId = ThreadId.make("laptop-thread");
      yield* seedSourceThread(sourceThreadId);

      // Source: prepare. A Git thread carries its Git work even when a folder would be taken.
      const prepared = yield* moves.prepareMove({ threadId: sourceThreadId, allowFolder: true });
      assert.equal(prepared.branch, "tempo/fix-importer");
      assert.isTrue(prepared.hasUncommittedChanges);
      assert.equal(prepared.messageCount, 2);
      assert.equal(prepared.repository?.canonicalKey, identity.canonicalKey);

      // Client: download from the source, upload to the target.
      const archivePath = yield* moves.resolveDownload(
        transferToken(prepared.downloadRelativeUrl, THREAD_MOVE_DOWNLOAD_PREFIX),
      );
      assert.isNotNull(archivePath);
      const { manifest } = yield* readArchiveManifest(archivePath!);
      assert.equal(manifest.git?.branch, "tempo/fix-importer");
      assert.isUndefined(manifest.folder);
      const bytes = yield* fileSystem.readFile(archivePath!);
      assert.equal(bytes.byteLength, prepared.sizeBytes);
      const upload = yield* moves.createImportUpload({
        moveId: prepared.moveId,
        sizeBytes: bytes.byteLength,
        repository: prepared.repository,
      });
      const uploadToken = transferToken(upload.uploadRelativeUrl, THREAD_MOVE_UPLOAD_PREFIX);
      assert.deepEqual(
        yield* moves.receiveUpload(uploadToken, Stream.make(bytes.subarray(0, 10)), null),
        { ok: false, status: 400, detail: `Expected ${bytes.byteLength} bytes.` },
      );
      assert.deepEqual(
        yield* moves.receiveUpload(uploadToken, Stream.make(bytes), bytes.byteLength + 1),
        { ok: false, status: 400, detail: "Content-Length must match the upload size." },
      );
      assert.deepEqual(yield* moves.receiveUpload(uploadToken, Stream.make(bytes), null), {
        ok: true,
      });
      // The token admits one archive, not one per request.
      assert.deepEqual(yield* moves.receiveUpload(uploadToken, Stream.make(bytes), null), {
        ok: false,
        status: 409,
        detail: "This move already has its archive.",
      });
      assert.equal(
        (yield* moves.receiveUpload("forged.token", Stream.make(bytes), null)).ok,
        false,
      );

      // Target: import.
      const source = { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" };
      const imported = yield* moves.importMove({ moveId: prepared.moveId, source });
      assert.equal(imported.threadId, movedThreadId(prepared.moveId));
      assert.equal(imported.projectId, targetProjectId);
      // The branch exists on the mini only through the move, so it keeps its name.
      assert.equal(imported.branch, "tempo/fix-importer");
      assert.equal(
        yield* fileSystem.readFileString(path.join(imported.worktreePath, "app.ts")),
        "export const a = 1;\n",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(imported.worktreePath, "notes.md")),
        "wip\n",
      );
      // The new checkout gets the project's setup, as any new worktree does.
      assert.deepEqual(recorded.setupRuns, [imported.worktreePath]);
      assert.include(imported.notes, "Running the project's setup script (Install) in a terminal.");
      const moved = yield* orchestrator.getThreadProjection(imported.threadId);
      assert.equal(moved.thread.movedFrom?.environmentLabel, "Laptop");
      assert.equal(moved.thread.movedFrom?.threadId, sourceThreadId);
      assert.equal(moved.thread.historyOrigin, "v1_import");
      assert.deepEqual(
        moved.messages.map((message) => message.text),
        [`Edit ${imported.worktreePath}/app.ts`, "Edited."],
      );

      // A retried import finds the thread instead of creating a second checkout.
      const again = yield* moves.importMove({ moveId: prepared.moveId, source });
      assert.equal(again.worktreePath, imported.worktreePath);
      const worktrees = yield* git(machines.target, ["worktree", "list", "--porcelain"]);
      assert.equal(worktrees.split("\n").filter((line) => line.startsWith("worktree ")).length, 2);

      // Source: finalize, twice.
      const target = {
        environmentId: EnvironmentId.make("mini"),
        environmentLabel: "Desk Mac",
        threadId: imported.threadId,
      };
      const finalized = yield* moves.finalizeMove({
        threadId: sourceThreadId,
        moveId: prepared.moveId,
        target,
      });
      yield* moves.finalizeMove({ threadId: sourceThreadId, moveId: prepared.moveId, target });
      // Tasks that posted into the thread would fail against the stub on every run.
      assert.equal(finalized.pausedScheduledTasks, 1);
      assert.deepEqual(recorded.paused.slice(0, 1), ["bound"]);
      const stub = yield* orchestrator.getThreadShell(sourceThreadId);
      assert.equal(stub?.movedTo?.environmentLabel, "Desk Mac");
      assert.equal(stub?.movedTo?.threadId, imported.threadId);
      // The laptop's checkout is untouched.
      assert.equal(
        yield* fileSystem.readFileString(path.join(machines.source, "notes.md")),
        "wip\n",
      );
      assert.isNull(
        yield* moves.resolveDownload(
          transferToken(prepared.downloadRelativeUrl, THREAD_MOVE_DOWNLOAD_PREFIX),
        ),
      );

      const refused = yield* moves.prepareMove({ threadId: sourceThreadId }).pipe(Effect.flip);
      assert.equal(refused._tag, "TempoThreadMoveAlreadyMovedError");
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("moving back comes home to the original checkout with the work done away", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* setUpMachines;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const laptop = { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" };
      const mini = { environmentId: EnvironmentId.make("mini"), environmentLabel: "Desk Mac" };
      const laptopThreadId = ThreadId.make("laptop-thread");
      yield* seedSourceThread(laptopThreadId);

      const away = yield* moveThread({ threadId: laptopThreadId, from: laptop, to: mini });
      // The agent keeps going on the mini: a commit, and new uncommitted work.
      yield* fileSystem.writeFileString(
        path.join(away.worktreePath, "app.ts"),
        "export const a = 2;\n",
      );
      yield* git(away.worktreePath, ["commit", "--quiet", "-am", "on the mini"]);
      yield* fileSystem.writeFileString(path.join(away.worktreePath, "mini.md"), "from the mini\n");
      const miniHead = yield* git(away.worktreePath, ["rev-parse", "HEAD"]);

      const home = yield* moveThread({ threadId: away.threadId, from: mini, to: laptop });

      // Same checkout and branch on the laptop, now at the mini's state.
      assert.equal(home.worktreePath, machines.source);
      assert.equal(home.branch, "tempo/fix-importer");
      assert.include(home.notes, "It is back in its original checkout on tempo/fix-importer.");
      assert.equal(yield* git(machines.source, ["rev-parse", "HEAD"]), miniHead);
      assert.equal(
        yield* git(machines.source, ["symbolic-ref", "--short", "HEAD"]),
        "tempo/fix-importer",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(machines.source, "app.ts")),
        "export const a = 2;\n",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(machines.source, "mini.md")),
        "from the mini\n",
      );
      assert.equal(
        yield* fileSystem.readFileString(path.join(machines.source, "notes.md")),
        "wip\n",
      );
      const worktrees = yield* git(machines.source, ["worktree", "list", "--porcelain"]);
      assert.lengthOf(
        worktrees.split("\n").filter((line) => line.startsWith("worktree ")),
        1,
      );
      // An existing checkout is already set up; only the mini's new worktree ran setup.
      assert.deepEqual(recorded.setupRuns, [away.worktreePath]);
      const returned = yield* orchestrator.getThreadShell(home.threadId);
      assert.equal(returned?.movedFrom?.environmentLabel, "Desk Mac");
      assert.isUndefined(returned?.movedTo);
      const miniStub = yield* orchestrator.getThreadShell(away.threadId);
      assert.equal(miniStub?.movedTo?.threadId, home.threadId);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("a moved thread whose checkout changed meanwhile comes back on a new branch", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* setUpMachines;
      const laptop = { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" };
      const mini = { environmentId: EnvironmentId.make("mini"), environmentLabel: "Desk Mac" };
      const laptopThreadId = ThreadId.make("laptop-thread");
      yield* seedSourceThread(laptopThreadId);
      const away = yield* moveThread({ threadId: laptopThreadId, from: laptop, to: mini });
      // Someone edits the laptop's checkout while the thread is away.
      yield* fileSystem.writeFileString(path.join(machines.source, "notes.md"), "edited\n");

      const home = yield* moveThread({ threadId: away.threadId, from: mini, to: laptop });
      assert.notEqual(home.worktreePath, machines.source);
      assert.equal(home.branch, "tempo/fix-importer-moved");
      assert.include(
        home.notes,
        "tempo/fix-importer was taken here, so the work is on tempo/fix-importer-moved.",
      );
      // The edited checkout is left as it was.
      assert.equal(
        yield* fileSystem.readFileString(path.join(machines.source, "notes.md")),
        "edited\n",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("reports a missing archive and forgets aborted moves", () =>
    Effect.gen(function* () {
      yield* setUpMachines;
      const moves = yield* ThreadMoveService.ThreadMoveService;
      const missing = yield* moves
        .importMove({
          moveId: TempoThreadMoveId.make("never-uploaded"),
          source: { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" },
        })
        .pipe(Effect.flip);
      assert.equal(missing._tag, "TempoThreadMoveArchiveNotFoundError");

      const threadId = ThreadId.make("aborted-thread");
      yield* seedSourceThread(threadId);
      const prepared = yield* moves.prepareMove({ threadId });
      yield* moves.abortMove({ threadId, moveId: prepared.moveId });
      assert.isNull(
        yield* moves.resolveDownload(
          transferToken(prepared.downloadRelativeUrl, THREAD_MOVE_DOWNLOAD_PREFIX),
        ),
      );
      const finalize = yield* moves
        .finalizeMove({
          threadId,
          moveId: prepared.moveId,
          target: {
            environmentId: EnvironmentId.make("mini"),
            environmentLabel: "Desk Mac",
            threadId: ThreadId.make("elsewhere"),
          },
        })
        .pipe(Effect.flip);
      assert.equal(finalize._tag, "TempoThreadMoveArchiveNotFoundError");
      const shell = yield* (yield* Orchestrator.OrchestratorV2).getThreadShell(threadId);
      assert.isUndefined(shell?.movedTo);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
  it.effect("carries the archive over the signed HTTP routes", () =>
    Effect.gen(function* () {
      yield* setUpMachines;
      const moves = yield* ThreadMoveService.ThreadMoveService;
      const threadId = ThreadId.make("http-thread");
      yield* seedSourceThread(threadId);
      const prepared = yield* moves.prepareMove({ threadId });
      const upload = yield* moves.createImportUpload({
        moveId: prepared.moveId,
        sizeBytes: prepared.sizeBytes,
        repository: prepared.repository,
      });
      const { handler, dispose } = HttpRouter.toWebHandler(
        ThreadMoveHttp.layer.pipe(
          // Route handlers read services from the served context, as in the server.
          Layer.provideMerge(
            Layer.mergeAll(
              Layer.succeed(ThreadMoveService.ThreadMoveService, moves),
              NodeHttpPlatform.layer,
              NodeServices.layer,
            ),
          ),
        ),
        { disableLogger: true },
      );
      const origin = "https://mini.example";
      const responses = yield* Effect.promise(async () => {
        try {
          const download = await handler(new Request(`${origin}${prepared.downloadRelativeUrl}`));
          const body = new Uint8Array(await download.arrayBuffer());
          const uploaded = await handler(
            new Request(`${origin}${upload.uploadRelativeUrl}`, {
              method: "POST",
              body,
              headers: { "content-type": "application/octet-stream" },
            }),
          );
          const forged = await handler(
            new Request(`${origin}${THREAD_MOVE_DOWNLOAD_PREFIX}/forged.signature`),
          );
          return {
            download: download.status,
            bytes: body.byteLength,
            upload: uploaded.status,
            forged: forged.status,
          };
        } finally {
          await dispose();
        }
      });
      assert.deepEqual(responses, {
        download: 200,
        bytes: prepared.sizeBytes,
        upload: 204,
        forged: 404,
      });
      const imported = yield* moves.importMove({
        moveId: prepared.moveId,
        source: { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" },
      });
      assert.equal(imported.threadId, movedThreadId(prepared.moveId));
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("moves a thread with no Git remote as a copy of its folder", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* setUpMachines;
      const moves = yield* ThreadMoveService.ThreadMoveService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      // A repository with no remote, a script, a link inside the folder and one out of it.
      yield* git(root, ["init", "--quiet", "--initial-branch=main", machines.folder]);
      yield* identifyCommitter(machines.folder);
      yield* fileSystem.writeFileString(path.join(machines.folder, "notes.md"), "plan\n");
      yield* git(machines.folder, ["add", "notes.md"]);
      yield* git(machines.folder, ["commit", "--quiet", "-m", "notes"]);
      yield* fileSystem.makeDirectory(path.join(machines.folder, "bin"));
      yield* fileSystem.writeFileString(path.join(machines.folder, "bin", "run.sh"), "#!/bin/sh\n");
      yield* fileSystem.chmod(path.join(machines.folder, "bin", "run.sh"), 0o755);
      yield* fileSystem.symlink("notes.md", path.join(machines.folder, "latest.md"));
      yield* fileSystem.symlink(machines.source, path.join(machines.folder, "laptop-checkout"));
      const threadId = ThreadId.make("notes-thread");
      yield* seedSourceThread(threadId, { inFolder: true });

      // A client or target that predates folder moves gets the refusal it always did.
      const refused = yield* moves.prepareMove({ threadId }).pipe(Effect.flip);
      assert.equal(refused._tag, "TempoThreadMoveRepositoryRequiredError");

      // Source: the archive carries the folder, .git included, but not the link out of it.
      const prepared = yield* moves.prepareMove({ threadId, allowFolder: true });
      assert.isNull(prepared.repository);
      assert.isNull(prepared.branch);
      const archivePath = yield* moves.resolveDownload(
        transferToken(prepared.downloadRelativeUrl, THREAD_MOVE_DOWNLOAD_PREFIX),
      );
      const { manifest } = yield* readArchiveManifest(archivePath!);
      assert.isNull(manifest.git);
      const entries = new Map(manifest.folder?.entries.map((entry) => [entry.path, entry.type]));
      assert.equal(entries.get("notes.md"), "file");
      assert.equal(entries.get("bin/run.sh"), "file");
      assert.equal(entries.get("latest.md"), "symlink");
      assert.equal(entries.get(".git/HEAD"), "file");
      assert.isFalse(entries.has("laptop-checkout"));
      assert.deepEqual(manifest.folder?.skipped, ["laptop-checkout"]);

      // Client: carry the archive over. Target: import it.
      const bytes = yield* fileSystem.readFile(archivePath!);
      const upload = yield* moves.createImportUpload({
        moveId: prepared.moveId,
        sizeBytes: bytes.byteLength,
        repository: null,
      });
      const stored = yield* moves.receiveUpload(
        transferToken(upload.uploadRelativeUrl, THREAD_MOVE_UPLOAD_PREFIX),
        Stream.make(bytes),
        bytes.byteLength,
      );
      assert.isTrue(stored.ok);
      const imported = yield* moves.importMove({
        moveId: prepared.moveId,
        source: { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" },
      });

      // It gets a new folder for threads without a project, named as a new thread's would be.
      const scratchRoot = Option.getOrThrow(
        yield* (yield* ManagedProjectFolders.ManagedProjectFolders).scratchRoot,
      );
      assert.equal(path.dirname(imported.worktreePath), scratchRoot);
      assert.match(path.basename(imported.worktreePath), /-fix-the-importer-[a-z0-9]{8}$/);
      assert.equal(imported.projectId, scratch.project?.id);
      assert.isNull(imported.branch);
      assert.equal(
        yield* fileSystem.readFileString(path.join(imported.worktreePath, "notes.md")),
        "plan\n",
      );
      assert.equal(
        (yield* fileSystem.stat(path.join(imported.worktreePath, "bin", "run.sh"))).mode & 0o777,
        0o755,
      );
      assert.equal(
        yield* fileSystem.readLink(path.join(imported.worktreePath, "latest.md")),
        "notes.md",
      );
      assert.isFalse(yield* fileSystem.exists(path.join(imported.worktreePath, "laptop-checkout")));
      // Its repository came along with it.
      assert.equal(yield* git(imported.worktreePath, ["log", "--format=%s"]), "notes");
      assert.deepEqual(imported.notes, [
        "Tool activity and checkpoints stay with the original thread.",
        `Its folder was copied to ${imported.worktreePath}.`,
        "Left on Laptop, since it cannot be copied: laptop-checkout.",
        // The test's machines have no providers.
        "This machine does not have the thread's provider. Pick a model before continuing.",
      ]);
      // A new folder has no project setup to run.
      assert.deepEqual(recorded.setupRuns, []);
      const moved = yield* orchestrator.getThreadProjection(imported.threadId);
      assert.equal(moved.thread.worktreePath, imported.worktreePath);
      assert.equal(moved.thread.movedFrom?.environmentLabel, "Laptop");
      assert.deepEqual(
        moved.messages.map((message) => message.text),
        [`Edit ${imported.worktreePath}/app.ts`, "Edited."],
      );

      yield* moves.finalizeMove({
        threadId,
        moveId: prepared.moveId,
        target: {
          environmentId: EnvironmentId.make("mini"),
          environmentLabel: "Desk Mac",
          threadId: imported.threadId,
        },
      });
      const stub = yield* orchestrator.getThreadShell(threadId);
      assert.equal(stub?.movedTo?.threadId, imported.threadId);
      // The laptop's folder is untouched.
      assert.equal(
        yield* fileSystem.readFileString(path.join(machines.folder, "notes.md")),
        "plan\n",
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("refuses a moved folder with an entry that would land outside it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { root } = yield* setUpMachines;
      const moves = yield* ThreadMoveService.ThreadMoveService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const payload = path.join(root, "payload");
      yield* fileSystem.writeFileString(payload, "owned\n");
      const at = DateTime.makeUnsafe("2026-10-01T10:00:00.000Z");
      /** Uploads, as another machine could, a folder move with `entries`, and imports it. */
      const importHostile = (name: string, entries: ReadonlyArray<TempoThreadMoveFolderEntry>) =>
        Effect.gen(function* () {
          const moveId = TempoThreadMoveId.make(`hostile-${name}`);
          const archivePath = path.join(root, `${name}.tempomove`);
          yield* writeArchive({
            archivePath,
            manifest: {
              format: "tempo-thread-move",
              version: 1,
              moveId,
              createdAt: at,
              source: {
                threadId: ThreadId.make("laptop-thread"),
                projectId: folderProjectId,
                cwd: "/laptop/notes",
                workspaceRoot: "/laptop/notes",
              },
              repository: null,
              git: null,
              folder: { entries, skipped: [] },
              thread: {
                title: "Hostile",
                modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
                providerDriver: null,
                runtimeMode: "full-access",
                interactionMode: "default",
                createdAt: at,
                movedFrom: null,
              },
              messages: [],
              providerRefs: [],
            },
            files: [{ name: "folder-0", path: payload }],
          });
          const bytes = yield* fileSystem.readFile(archivePath);
          const upload = yield* moves.createImportUpload({
            moveId,
            sizeBytes: bytes.byteLength,
            repository: null,
          });
          yield* moves.receiveUpload(
            transferToken(upload.uploadRelativeUrl, THREAD_MOVE_UPLOAD_PREFIX),
            Stream.make(bytes),
            bytes.byteLength,
          );
          const refused = yield* moves
            .importMove({
              moveId,
              source: { environmentId: EnvironmentId.make("laptop"), environmentLabel: "Laptop" },
            })
            .pipe(Effect.flip);
          if (refused._tag !== "TempoThreadMoveFailedError") {
            return assert.fail(`${name} was refused with ${refused._tag}`);
          }
          assert.equal(
            refused.cause instanceof Error ? refused.cause.message : refused.cause,
            "The moved folder has an entry that would land outside it.",
          );
          assert.isNull(yield* orchestrator.getThreadShell(movedThreadId(moveId)));
        });
      const file = (entryPath: string) =>
        ({ type: "file", path: entryPath, file: "folder-0", mode: 0o644 }) as const;

      yield* importHostile("climbs", [file("../escape.txt")]);
      yield* importHostile("absolute", [file(path.join(root, "escape.txt"))]);
      yield* importHostile("link-out", [{ type: "symlink", path: "up", target: ".." }]);
      yield* importHostile("through-link", [
        { type: "symlink", path: "here", target: "." },
        file("here/escape.txt"),
      ]);
      // Each link stays in by itself, but `here/..` leaves through the first one.
      yield* importHostile("link-chain", [
        { type: "symlink", path: "here", target: "." },
        { type: "directory", path: "d" },
        { type: "symlink", path: "d/up", target: "../here/.." },
      ]);

      const scratchRoot = Option.getOrThrow(
        yield* (yield* ManagedProjectFolders.ManagedProjectFolders).scratchRoot,
      );
      // Nothing landed outside, and no refused import kept the folder it was given.
      assert.isFalse(yield* fileSystem.exists(path.join(scratchRoot, "escape.txt")));
      assert.isFalse(yield* fileSystem.exists(path.join(root, "escape.txt")));
      assert.deepEqual(yield* fileSystem.readDirectory(scratchRoot), []);
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );

  it.effect("refuses a folder too large to move before packing it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      yield* setUpMachines;
      const moves = yield* ThreadMoveService.ThreadMoveService;
      yield* fileSystem.makeDirectory(machines.folder);
      const image = path.join(machines.folder, "disk.img");
      yield* fileSystem.writeFileString(image, "");
      // Sparse, so the test writes nothing.
      yield* fileSystem.truncate(image, TEMPO_THREAD_MOVE_MAX_ARCHIVE_BYTES + 1);
      const threadId = ThreadId.make("big-thread");
      yield* seedSourceThread(threadId, { inFolder: true });

      const refused = yield* moves.prepareMove({ threadId, allowFolder: true }).pipe(Effect.flip);
      if (refused._tag !== "TempoThreadMoveTooLargeError") {
        return assert.fail(`refused with ${refused._tag}`);
      }
      assert.equal(refused.maxFolderEntries, MAX_FOLDER_ENTRIES);
      assert.equal(
        refused.message,
        "This thread's folder is too large to move: the limit is 2048 MB and 100000 files and folders. Delete what can be rebuilt, such as node_modules, or move large files out of it.",
      );
      // The refused move left no archive behind.
      assert.deepEqual(
        yield* fileSystem.readDirectory(
          path.join(config.stateDir, "tempo-thread-moves", "outgoing"),
        ),
        [],
      );
    }).pipe(Effect.provide(layerTest), Effect.scoped),
  );
});
