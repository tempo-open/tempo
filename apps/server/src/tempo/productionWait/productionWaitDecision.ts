/**
 * tempo: Waiting for Production. What a thread waits for, the orchestrator's
 * decisions about a wait, and how a sweep recognizes the promotion that ends it.
 *
 * @module productionWaitDecision
 */
import {
  tempoProductionWaitRefusal,
  tempoProductionWaitRefusalMessage,
  type OrchestrationV2AppThread,
  type OrchestrationV2Notification,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/**
 * The promotion every waiting thread waits for: a successful deployment to the `production`
 * GitHub Environment of one repository, recorded by one workflow. Other workflows can record
 * production deployments too (store releases, for example), so only that workflow's count.
 */
export interface ProductionPromotionTarget {
  readonly host: "github.com";
  readonly owner: string;
  readonly repository: string;
  readonly environment: "production";
  /** The workflow file, relative to the repository root, whose deployments count. */
  readonly workflow: string;
}

/** The workflow whose production deployments count when TEMPO_PRODUCTION_WORKFLOW is unset. */
const DEFAULT_PRODUCTION_WORKFLOW = ".github/workflows/deploy.yml";

const GITHUB_REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/u;

/**
 * The promotion target TEMPO_PRODUCTION_REPOSITORY (`owner/name` on github.com) and
 * TEMPO_PRODUCTION_WORKFLOW name. Null while no repository is named, or the name is not
 * `owner/name`, which turns Waiting for Production off on this environment.
 */
export function resolveProductionPromotionTarget(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ProductionPromotionTarget | null {
  const match = GITHUB_REPOSITORY.exec(env.TEMPO_PRODUCTION_REPOSITORY?.trim() ?? "");
  if (match === null) return null;
  const workflow = env.TEMPO_PRODUCTION_WORKFLOW?.trim() || DEFAULT_PRODUCTION_WORKFLOW;
  return {
    host: "github.com",
    owner: match[1]!,
    repository: match[2]!,
    environment: "production",
    workflow,
  };
}

/** Minutes between sweeps, the pull request watch's cadence. */
export const PRODUCTION_WAIT_SWEEP_MINUTES = 2;

export const PRODUCTION_PROMOTED_MESSAGE =
  "Staging has been promoted to production. Continue where you left off.";

export const PRODUCTION_PROMOTED_NOTIFICATION: OrchestrationV2Notification = {
  source: { kind: "monitor" },
  outcome: "completed",
  summary: "Staging promoted to production",
};

/** One production deployment as a sweep reads it, newest first. */
export interface ProductionDeployment {
  readonly id: number;
  /** When GitHub created the deployment, which is when that production deploy started. */
  readonly createdAt: string;
  /** Its latest status in lower case (`success`, `failure`, `in_progress`, …); null before the first. */
  readonly latestState: string | null;
  /** The workflow file whose run made it, read once it succeeds; null before, or when unknown. */
  readonly workflow: string | null;
}

/**
 * The promotion that ends a wait that started at `since`: a deployment by `workflow` created
 * after the wait began whose latest status is success. A deploy already running at the start may
 * predate the merged work, so it does not count. Comparing with the start rather than the last
 * sweep also ends waits whose promotion landed while this machine slept.
 */
export function promotionFor(
  since: string,
  deployments: ReadonlyArray<ProductionDeployment>,
  workflow: string = DEFAULT_PRODUCTION_WORKFLOW,
): ProductionDeployment | undefined {
  const sinceMs = Date.parse(since);
  if (Number.isNaN(sinceMs)) return undefined;
  return deployments.find(
    (deployment) =>
      deployment.latestState === "success" &&
      deployment.workflow === workflow &&
      Date.parse(deployment.createdAt) > sinceMs,
  );
}

type ProductionWaitCommand =
  | { readonly type: "thread.production-wait.set"; readonly waiting: boolean }
  | { readonly type: "thread.production-wait.resume"; readonly since: string };

/**
 * The thread a production wait command leaves, or why it is refused. Starting
 * keeps an earlier start and stopping a thread that does not wait changes
 * nothing; both still record the thread so the command has an event. A resume
 * applies only while the wait that started at `since` is on.
 */
export function decideProductionWait(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly command: ProductionWaitCommand;
  readonly now: DateTime.Utc;
}): { readonly thread: OrchestrationV2AppThread } | { readonly refusal: string } {
  const { thread, command, now } = input;
  const current = thread.waitingForProductionSince ?? null;
  if (command.type === "thread.production-wait.resume") {
    return current === command.since && thread.deletedAt === null
      ? { thread: { ...thread, waitingForProductionSince: null, updatedAt: now } }
      : { refusal: "The production wait ended or restarted before the promotion was read." };
  }
  if (command.waiting) {
    const refusal = tempoProductionWaitRefusal(thread);
    if (refusal !== null) return { refusal: tempoProductionWaitRefusalMessage(refusal) };
    return current !== null
      ? { thread }
      : {
          thread: { ...thread, waitingForProductionSince: DateTime.formatIso(now), updatedAt: now },
        };
  }
  if (thread.deletedAt !== null) return { refusal: tempoProductionWaitRefusalMessage("notFound") };
  return current === null
    ? { thread }
    : { thread: { ...thread, waitingForProductionSince: null, updatedAt: now } };
}

/** Settling, archiving, forking and moving a thread away end or drop its wait. */
export function endProductionWait(
  thread: Pick<OrchestrationV2AppThread, "waitingForProductionSince">,
): { readonly waitingForProductionSince?: null } {
  return thread.waitingForProductionSince == null ? {} : { waitingForProductionSince: null };
}
