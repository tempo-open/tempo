import { assert, describe, it } from "@effect/vitest";
import {
  TempoThreadMoveId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  decideProductionWait,
  endProductionWait,
  promotionFor,
  resolveProductionPromotionTarget,
} from "./productionWaitDecision.ts";

const createdAt = DateTime.makeUnsafe("2026-10-14T09:00:00.000Z");
const now = DateTime.makeUnsafe("2026-10-14T10:00:00.000Z");
const since = "2026-10-14T09:30:00.000Z";

const thread: OrchestrationV2AppThread = {
  createdBy: "user",
  creationSource: "web",
  id: ThreadId.make("waiting-thread"),
  projectId: ProjectId.make("tempo"),
  title: "Ship the router",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("waiting-thread"),
  },
  forkedFrom: null,
  createdAt,
  updatedAt: createdAt,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};
const waiting = { ...thread, waitingForProductionSince: since };

const set = (waitingFlag: boolean) => ({
  type: "thread.production-wait.set" as const,
  waiting: waitingFlag,
});

describe("decideProductionWait", () => {
  it("starts a wait now and keeps an earlier start", () => {
    assert.deepEqual(decideProductionWait({ thread, command: set(true), now }), {
      thread: { ...thread, waitingForProductionSince: DateTime.formatIso(now), updatedAt: now },
    });
    assert.deepEqual(decideProductionWait({ thread: waiting, command: set(true), now }), {
      thread: waiting,
    });
  });

  it("stops a wait, and stopping a thread that does not wait changes nothing", () => {
    assert.deepEqual(decideProductionWait({ thread: waiting, command: set(false), now }), {
      thread: { ...waiting, waitingForProductionSince: null, updatedAt: now },
    });
    assert.deepEqual(decideProductionWait({ thread, command: set(false), now }), { thread });
  });

  it("refuses to start waiting where a thread cannot wait", () => {
    const refused = (candidate: OrchestrationV2AppThread) =>
      "refusal" in decideProductionWait({ thread: candidate, command: set(true), now });
    assert.isTrue(refused({ ...thread, settledOverride: "settled", settledAt: now }));
    assert.isTrue(refused({ ...thread, archivedAt: now }));
    assert.isTrue(refused({ ...thread, deletedAt: now }));
    assert.isTrue(
      refused({
        ...thread,
        lineage: {
          ...thread.lineage,
          parentThreadId: ThreadId.make("parent"),
          relationshipToParent: "subagent",
        },
      }),
    );
    assert.isTrue(
      refused({
        ...thread,
        movedTo: {
          moveId: TempoThreadMoveId.make("move-1"),
          environmentId: EnvironmentId.make("studio"),
          environmentLabel: "Desk",
          threadId: ThreadId.make("moved-thread"),
          movedAt: DateTime.formatIso(now),
        },
      }),
    );
    // An un-settled thread and a fork can wait.
    assert.isFalse(refused({ ...thread, settledOverride: "active" }));
    assert.isFalse(
      refused({ ...thread, lineage: { ...thread.lineage, relationshipToParent: "fork" } }),
    );
  });

  it("resumes only the wait that started at the promotion's read", () => {
    const resume = (at: string) => ({ type: "thread.production-wait.resume" as const, since: at });
    assert.deepEqual(decideProductionWait({ thread: waiting, command: resume(since), now }), {
      thread: { ...waiting, waitingForProductionSince: null, updatedAt: now },
    });
    // Ended, or restarted later, while the deployments were read.
    assert.isTrue("refusal" in decideProductionWait({ thread, command: resume(since), now }));
    assert.isTrue(
      "refusal" in
        decideProductionWait({
          thread: { ...waiting, waitingForProductionSince: "2026-10-14T09:45:00.000Z" },
          command: resume(since),
          now,
        }),
    );
  });

  it("drops a wait only when there is one", () => {
    assert.deepEqual(endProductionWait(waiting), { waitingForProductionSince: null });
    assert.deepEqual(endProductionWait(thread), {});
  });
});

describe("promotionFor", () => {
  const deployment = (
    id: number,
    createdAtIso: string,
    latestState: string | null,
    workflow: string | null = ".github/workflows/deploy.yml",
  ) => ({ id, createdAt: createdAtIso, latestState, workflow });

  it("takes the newest successful deployment created after the wait started", () => {
    const deployments = [
      deployment(4, "2026-10-14T11:00:00Z", "in_progress"),
      deployment(3, "2026-10-14T10:00:00Z", "success"),
      deployment(2, "2026-10-14T09:45:00Z", "success"),
      deployment(1, "2026-10-14T09:00:00Z", "success"),
    ];
    assert.equal(promotionFor(since, deployments)?.id, 3);
  });

  it("ignores deploys that started before the wait, failed, or are still running", () => {
    assert.isUndefined(
      promotionFor(since, [
        deployment(3, "2026-10-14T10:00:00Z", "failure"),
        deployment(2, "2026-10-14T09:50:00Z", "queued"),
        deployment(1, "2026-10-14T09:29:59Z", "success"),
      ]),
    );
    assert.isUndefined(promotionFor(since, []));
    assert.isUndefined(
      promotionFor("not a time", [deployment(1, "2026-10-14T10:00:00Z", "success")]),
    );
  });

  it("counts only the Deploy workflow's production deployments", () => {
    assert.isUndefined(
      promotionFor(since, [
        deployment(
          2,
          "2026-10-14T10:00:00Z",
          "success",
          ".github/workflows/android-play-bundle.yml",
        ),
        deployment(1, "2026-10-14T09:45:00Z", "success", null),
      ]),
    );
  });

  it("counts the configured workflow instead of the default one", () => {
    const deployments = [
      deployment(2, "2026-10-14T10:00:00Z", "success"),
      deployment(1, "2026-10-14T09:45:00Z", "success", ".github/workflows/release.yml"),
    ];
    assert.equal(promotionFor(since, deployments, ".github/workflows/release.yml")?.id, 1);
  });

  it("counts a promotion that landed long ago, as a machine that slept through it sees it", () => {
    const longAgo = "2026-10-01T00:00:00.000Z";
    assert.equal(promotionFor(longAgo, [deployment(9, "2026-10-02T00:00:00Z", "success")])?.id, 9);
  });
});

describe("resolveProductionPromotionTarget", () => {
  it("is off until TEMPO_PRODUCTION_REPOSITORY names owner/name", () => {
    for (const value of [
      undefined,
      "",
      "  ",
      "acme",
      "acme/app/extra",
      "https://github.com/acme/app",
    ]) {
      assert.isNull(resolveProductionPromotionTarget({ TEMPO_PRODUCTION_REPOSITORY: value }));
    }
  });

  it("watches the named repository's deploy workflow unless TEMPO_PRODUCTION_WORKFLOW names another", () => {
    assert.deepEqual(
      resolveProductionPromotionTarget({ TEMPO_PRODUCTION_REPOSITORY: " acme/app " }),
      {
        host: "github.com",
        owner: "acme",
        repository: "app",
        environment: "production",
        workflow: ".github/workflows/deploy.yml",
      },
    );
    assert.equal(
      resolveProductionPromotionTarget({
        TEMPO_PRODUCTION_REPOSITORY: "acme/app",
        TEMPO_PRODUCTION_WORKFLOW: ".github/workflows/release.yml",
      })?.workflow,
      ".github/workflows/release.yml",
    );
  });
});
