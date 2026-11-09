import type {
  DesktopLaptopToolGrant,
  EnvironmentId,
  LaptopToolServerId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

/**
 * The person's consent to laptop tools. A grant covers one server, as it launches now, for one
 * thread's run; it ends with the run, after 30 idle minutes, or at Stop, which also stops its
 * calls. Anything but Allow refuses that server to that run, so an agent cannot keep asking.
 * Nothing here allows a call on its own: every grant starts with `prompt`.
 */

export const LAPTOP_TOOL_GRANT_IDLE_MS = 30 * 60_000;
/** How long a refusal is kept; a run's refusal holds for its whole run. */
const LAPTOP_TOOL_DENIAL_RETENTION_MS = 24 * 60 * 60_000;

export interface LaptopToolConsentRequest {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly threadId: ThreadId;
  readonly threadTitle: string;
  readonly runId: RunId;
  readonly serverId: LaptopToolServerId;
  readonly serverName: string;
  /** The exact process the server runs as; a different one asks again. */
  readonly launchKey: string;
}

/** `dismissed` means the prompt closed without an answer; it refuses like `deny`. */
export type LaptopToolConsentDecision = "allow" | "deny" | "dismissed";

/** Why a prompt was closed before the person answered it. */
type PromptAbortReason = "unanswered" | "stopped" | "superseded";

export type LaptopToolAcquireResult =
  | {
      readonly allowed: true;
      /** Aborts when the caller cancels or the person stops the grant. */
      readonly signal: AbortSignal;
      readonly release: () => void;
    }
  | { readonly allowed: false; readonly reason: "denied" | "dismissed" };

export interface LaptopToolGrantsOptions {
  readonly now: () => number;
  /** Asks the person. Must close the prompt (and resolve `dismissed`) when `signal` aborts. */
  readonly prompt: (
    request: LaptopToolConsentRequest,
    signal: AbortSignal,
  ) => Promise<LaptopToolConsentDecision>;
  readonly onChange?: () => void;
  readonly idleMs?: number;
}

interface Grant {
  readonly key: string;
  readonly request: LaptopToolConsentRequest;
  readonly grantedAt: number;
  lastUsedAt: number;
  readonly calls: Set<AbortController>;
}

interface Denial {
  readonly runId: RunId;
  readonly at: number;
}

interface PendingPrompt {
  readonly runId: RunId;
  readonly controller: AbortController;
  readonly decision: Promise<LaptopToolConsentDecision>;
  waiters: number;
}

const laptopToolGrantKey = (
  environmentId: EnvironmentId,
  threadId: ThreadId,
  serverId: LaptopToolServerId,
): string => JSON.stringify([environmentId, threadId, serverId]);

export class LaptopToolGrants {
  private readonly grants = new Map<string, Grant>();
  private readonly denials = new Map<string, Denial>();
  private readonly prompts = new Map<string, PendingPrompt>();
  private readonly idleMs: number;
  private readonly options: LaptopToolGrantsOptions;

  constructor(options: LaptopToolGrantsOptions) {
    this.options = options;
    this.idleMs = options.idleMs ?? LAPTOP_TOOL_GRANT_IDLE_MS;
  }

  /**
   * Waits for permission to make one call. The first call of a run asks the
   * person; calls that arrive while they decide wait for the same answer. A
   * refusal holds for the rest of that run so an agent cannot repeat the prompt.
   */
  async acquire(
    request: LaptopToolConsentRequest,
    callerSignal: AbortSignal,
  ): Promise<LaptopToolAcquireResult> {
    this.sweep();
    const key = laptopToolGrantKey(request.environmentId, request.threadId, request.serverId);
    const existing = this.grants.get(key);
    if (
      existing !== undefined &&
      (existing.request.runId !== request.runId || existing.request.launchKey !== request.launchKey)
    ) {
      this.revoke(key);
    }
    const denial = this.denials.get(key);
    if (denial !== undefined && denial.runId === request.runId) {
      return { allowed: false, reason: "denied" };
    }
    if (!this.grants.has(key)) {
      const decision = await this.ask(key, request, callerSignal);
      if (decision !== "allow") {
        return { allowed: false, reason: decision === "deny" ? "denied" : "dismissed" };
      }
    }
    const grant = this.grants.get(key);
    // Stopped, or replaced by a newer run, while this call waited.
    if (grant === undefined || grant.request.runId !== request.runId) {
      return { allowed: false, reason: "denied" };
    }
    // The server's launch changed while this call waited; the next call asks again.
    if (grant.request.launchKey !== request.launchKey) {
      return { allowed: false, reason: "dismissed" };
    }
    if (callerSignal.aborted) return { allowed: false, reason: "dismissed" };
    const controller = new AbortController();
    const onCallerAbort = () => controller.abort();
    callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    grant.calls.add(controller);
    grant.lastUsedAt = this.options.now();
    this.changed();
    let released = false;
    return {
      allowed: true,
      signal: controller.signal,
      release: () => {
        if (released) return;
        released = true;
        callerSignal.removeEventListener("abort", onCallerAbort);
        grant.calls.delete(controller);
        grant.lastUsedAt = this.options.now();
        this.changed();
      },
    };
  }

  /**
   * Revokes one grant, or every grant, and stops their calls and open prompts.
   * The person said stop, so those runs do not ask again; the next run does.
   */
  stop(key?: string): void {
    const keys = key === undefined ? [...this.grants.keys(), ...this.prompts.keys()] : [key];
    const now = this.options.now();
    let changed = false;
    for (const candidate of new Set(keys)) {
      const grant = this.grants.get(candidate);
      if (grant !== undefined) {
        this.denials.set(candidate, { runId: grant.request.runId, at: now });
        changed = this.revoke(candidate) || changed;
      }
      const prompt = this.prompts.get(candidate);
      if (prompt !== undefined) {
        // The prompt records the refusal for its own run when it closes.
        prompt.controller.abort("stopped" satisfies PromptAbortReason);
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /**
   * Ends a server's grants without refusing anything: its launch changed or it
   * was turned off, so the next call asks the person again.
   */
  revokeServer(serverId: LaptopToolServerId): void {
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (grant.request.serverId === serverId) changed = this.revoke(key) || changed;
    }
    if (changed) this.changed();
  }

  /** A thread's run is not the one its grants were given for any more. */
  runChanged(environmentId: EnvironmentId, threadId: ThreadId, activeRunId: RunId | null): void {
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (
        grant.request.environmentId === environmentId &&
        grant.request.threadId === threadId &&
        grant.request.runId !== activeRunId
      ) {
        changed = this.revoke(key) || changed;
      }
    }
    for (const [key, denial] of this.denials) {
      const [deniedEnvironment, deniedThread] = JSON.parse(key) as [string, string];
      if (
        deniedEnvironment === environmentId &&
        deniedThread === threadId &&
        denial.runId !== activeRunId
      ) {
        this.denials.delete(key);
      }
    }
    if (changed) this.changed();
  }

  /** Ends grants idle for longer than the limit. Calls in flight keep a grant alive. */
  sweep(): void {
    const now = this.options.now();
    let changed = false;
    for (const [key, grant] of this.grants) {
      if (grant.calls.size === 0 && now - grant.lastUsedAt >= this.idleMs) {
        changed = this.revoke(key) || changed;
      }
    }
    for (const [key, denial] of this.denials) {
      if (now - denial.at >= LAPTOP_TOOL_DENIAL_RETENTION_MS) this.denials.delete(key);
    }
    if (changed) this.changed();
  }

  get size(): number {
    return this.grants.size;
  }

  list(): ReadonlyArray<DesktopLaptopToolGrant> {
    return [...this.grants.values()].map((grant) => ({
      key: grant.key,
      environmentId: grant.request.environmentId,
      environmentLabel: grant.request.environmentLabel,
      threadId: grant.request.threadId,
      threadTitle: grant.request.threadTitle,
      serverId: grant.request.serverId,
      serverName: grant.request.serverName,
      runId: grant.request.runId,
      grantedAt: grant.grantedAt,
      lastUsedAt: grant.lastUsedAt,
      inFlight: grant.calls.size,
    }));
  }

  private ask(
    key: string,
    request: LaptopToolConsentRequest,
    callerSignal: AbortSignal,
  ): Promise<LaptopToolConsentDecision> {
    const pending = this.prompts.get(key);
    const prompt =
      pending !== undefined && pending.runId === request.runId
        ? pending
        : this.openPrompt(key, request);
    // A call that gives up stops waiting; the prompt closes once no call waits
    // for it, and an unanswered prompt refuses the run.
    prompt.waiters += 1;
    return new Promise((resolve) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        prompt.waiters -= 1;
        if (prompt.waiters === 0) prompt.controller.abort("unanswered" satisfies PromptAbortReason);
        resolve("dismissed");
      };
      callerSignal.addEventListener("abort", onAbort, { once: true });
      void prompt.decision.then((decision) => {
        callerSignal.removeEventListener("abort", onAbort);
        if (settled) return;
        settled = true;
        prompt.waiters -= 1;
        resolve(decision);
      });
      if (callerSignal.aborted) onAbort();
    });
  }

  private openPrompt(key: string, request: LaptopToolConsentRequest): PendingPrompt {
    this.prompts.get(key)?.controller.abort("superseded" satisfies PromptAbortReason);
    const controller = new AbortController();
    const decision = this.options
      .prompt(request, controller.signal)
      .catch((): LaptopToolConsentDecision => "dismissed")
      .then((answer): LaptopToolConsentDecision => {
        // An answer that arrives after Stop or a newer prompt does not count.
        if (this.prompts.get(key) === prompt) this.prompts.delete(key);
        const effective = controller.signal.aborted ? "dismissed" : answer;
        const now = this.options.now();
        if (effective === "allow") {
          this.denials.delete(key);
          this.grants.set(key, {
            key,
            request,
            grantedAt: now,
            lastUsedAt: now,
            calls: new Set(),
          });
          this.changed();
        } else if (controller.signal.reason !== "superseded") {
          // Deny, Stop, or nobody answered: this run does not ask again. A
          // prompt replaced by a newer run's says nothing about that run.
          this.denials.set(key, { runId: request.runId, at: now });
        }
        return effective;
      });
    const prompt: PendingPrompt = { runId: request.runId, controller, decision, waiters: 0 };
    this.prompts.set(key, prompt);
    return prompt;
  }

  private revoke(key: string): boolean {
    const grant = this.grants.get(key);
    if (grant === undefined) return false;
    this.grants.delete(key);
    for (const call of grant.calls) call.abort();
    grant.calls.clear();
    return true;
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
