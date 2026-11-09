import {
  TempoThreadMoveId,
  TempoThreadMoveProjectNotFoundError,
  TempoThreadMoveThreadChangedError,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { runThreadMove, type ThreadMoveCalls } from "./threadMove.ts";

const laptop = { environmentId: EnvironmentId.make("laptop"), label: "Laptop" };
const mini = { environmentId: EnvironmentId.make("mini"), label: "Mac mini" };
const threadId = ThreadId.make("thread-1");
const moveId = TempoThreadMoveId.make("move-1");

function fakeCalls(overrides: Partial<ThreadMoveCalls> = {}) {
  const log: Array<string> = [];
  const calls: ThreadMoveCalls = {
    prepare: async (environmentId) => {
      log.push(`prepare@${environmentId}`);
      return {
        moveId,
        downloadRelativeUrl: "/api/tempo/thread-moves/download/token",
        sizeBytes: 42,
        expiresAt: 0,
        messageCount: 2,
        hasUncommittedChanges: true,
        branch: "tempo/work",
        repository: {
          canonicalKey: "github.com/acme/app",
          groupingKey: "github.com/acme/app",
          displayName: "acme/app",
        },
      };
    },
    createImportUpload: async (environmentId, input) => {
      log.push(`createImportUpload@${environmentId}:${input.repository?.canonicalKey ?? "folder"}`);
      return { uploadRelativeUrl: "/api/tempo/thread-moves/upload/token", expiresAt: 0 };
    },
    importMove: async (environmentId, input) => {
      log.push(`import@${environmentId}:${input.source.environmentLabel}`);
      return {
        threadId: ThreadId.make("moved-thread"),
        projectId: ProjectId.make("project"),
        branch: "tempo/work",
        worktreePath: "/mini/worktrees/tempo-work",
        notes: [],
      };
    },
    finalize: async (environmentId, input) => {
      log.push(`finalize@${environmentId}:${input.target.threadId}`);
      return { pausedScheduledTasks: 1 };
    },
    abort: async (environmentId) => {
      log.push(`abort@${environmentId}`);
    },
    ...overrides,
  };
  return { calls, log };
}

const resolveHttpUrl = (environmentId: EnvironmentId, relativeUrl: string) =>
  `https://${environmentId}.test${relativeUrl}`;
const noWait = async () => {};

describe("runThreadMove", () => {
  it("prepares on the source, carries the bytes, imports on the target, then stubs the source", async () => {
    const { calls, log } = fakeCalls();
    const transfers: Array<unknown> = [];
    const steps: Array<string> = [];
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl,
      transfer: async (urls) => {
        transfers.push(urls);
      },
      onStep: (step) => steps.push(step),
    });
    expect(outcome).toMatchObject({
      status: "moved",
      threadId: "moved-thread",
      environmentId: "mini",
      copiedFolder: false,
      notes: [],
      finalized: { ok: true, pausedScheduledTasks: 1 },
    });
    expect(log).toEqual([
      "prepare@laptop",
      "createImportUpload@mini:github.com/acme/app",
      "import@mini:Laptop",
      "finalize@laptop:moved-thread",
    ]);
    expect(transfers).toEqual([
      {
        downloadUrl: "https://laptop.test/api/tempo/thread-moves/download/token",
        uploadUrl: "https://mini.test/api/tempo/thread-moves/upload/token",
        sizeBytes: 42,
      },
    ]);
    expect(steps).toEqual(["prepare", "transfer", "import", "finalize"]);
  });

  it("carries a thread with no Git remote as a folder only when the target takes one", async () => {
    const asked: Array<boolean | undefined> = [];
    const { calls, log } = fakeCalls({
      prepare: async (_environmentId, input) => {
        asked.push(input.allowFolder);
        return {
          moveId,
          downloadRelativeUrl: "/api/tempo/thread-moves/download/token",
          sizeBytes: 42,
          expiresAt: 0,
          messageCount: 2,
          hasUncommittedChanges: false,
          branch: null,
          repository: null,
        };
      },
    });
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl,
      transfer: async () => {},
    });
    expect(asked).toEqual([true]);
    expect(log).toContain("createImportUpload@mini:folder");
    expect(outcome).toMatchObject({ status: "moved", copiedFolder: true });
  });

  it("aborts on the source when the target cannot import, leaving the thread in place", async () => {
    const refusal = new TempoThreadMoveProjectNotFoundError({ repository: "acme/app" });
    const { calls, log } = fakeCalls({
      importMove: async () => {
        throw refusal;
      },
    });
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl,
      transfer: async () => {},
    });
    expect(outcome).toEqual({ status: "failed", step: "import", error: refusal });
    expect(
      outcome.status === "failed" && outcome.error instanceof Error && outcome.error.message,
    ).toBe("Open acme/app as a project on the machine it is moving to first.");
    expect(log.at(-1)).toBe("abort@laptop");
    expect(log.some((entry) => entry.startsWith("finalize"))).toBe(false);
  });

  it("asks the target again when an import's answer is lost on the way", async () => {
    let attempts = 0;
    const { calls, log } = fakeCalls({
      importMove: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("socket closed");
        return {
          threadId: ThreadId.make("moved-thread"),
          projectId: ProjectId.make("project"),
          branch: "tempo/work",
          worktreePath: "/mini/worktrees/tempo-work",
          notes: [],
        };
      },
    });
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl,
      transfer: async () => {},
      sleep: noWait,
    });
    expect(outcome).toMatchObject({ status: "moved", threadId: "moved-thread" });
    expect(attempts).toBe(2);
    expect(log.some((entry) => entry.startsWith("abort"))).toBe(false);
  });

  it("aborts when an environment drops mid-transfer", async () => {
    const { calls, log } = fakeCalls();
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl: (environmentId, relativeUrl) =>
        environmentId === mini.environmentId ? null : resolveHttpUrl(environmentId, relativeUrl),
      transfer: async () => {},
    });
    expect(outcome.status === "failed" && outcome.step).toBe("transfer");
    expect(log).toEqual([
      "prepare@laptop",
      "createImportUpload@mini:github.com/acme/app",
      "abort@laptop",
    ]);
  });

  it("retries a source that briefly cannot become a stub, and can be asked again later", async () => {
    let attempts = 0;
    let online = false;
    const { calls } = fakeCalls({
      finalize: async () => {
        attempts += 1;
        if (!online) throw new Error("source went offline");
        return { pausedScheduledTasks: 0 };
      },
    });
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl,
      transfer: async () => {},
      sleep: noWait,
    });
    if (outcome.status !== "moved") throw new Error("expected a move");
    expect(outcome.finalized.ok).toBe(false);
    expect(attempts).toBe(3);
    online = true;
    expect(await outcome.retryFinalize()).toEqual({ ok: true, pausedScheduledTasks: 0 });
  });

  it("does not retry a source that refuses to become a stub", async () => {
    const refusal = new TempoThreadMoveThreadChangedError({ threadId });
    let attempts = 0;
    const { calls } = fakeCalls({
      finalize: async () => {
        attempts += 1;
        throw refusal;
      },
    });
    const outcome = await runThreadMove({
      calls,
      threadId,
      source: laptop,
      target: mini,
      allowFolder: true,
      resolveHttpUrl,
      transfer: async () => {},
      sleep: noWait,
    });
    expect(outcome.status === "moved" && outcome.finalized).toEqual({ ok: false, error: refusal });
    expect(attempts).toBe(1);
  });
});
