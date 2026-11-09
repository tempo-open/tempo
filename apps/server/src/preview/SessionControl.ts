// @effect-diagnostics globalDate:off - tempo: the hold clock runs outside the Effect runtime.
import type { PreviewAutomationControlReason } from "@t3tools/contracts";

/** tempo: how long a person's last deliberate input keeps agents from taking their tab back. */
export const HUMAN_HOLD_MS = 10_000;

export class BrowserControlInterrupted extends Error {
  readonly reason: PreviewAutomationControlReason;
  constructor(
    message = "Browser control changed. Refresh the snapshot before trying again.",
    reason: PreviewAutomationControlReason = "interrupted",
  ) {
    super(message);
    this.reason = reason;
  }
}

/** tempo: an agent's action while a person is using the tab. */
export const humanControlError = () =>
  new BrowserControlInterrupted(
    "A person is using this browser tab. Try again in a few seconds.",
    "humanControl",
  );

const settle = (work: Promise<unknown>) =>
  work.then(
    () => undefined,
    () => undefined,
  );

/** Reserves control immediately, but drains running work before the new owner can act. */
export class SessionControl {
  readonly agentId: string | null;
  private readonly onGenerationChange: () => void;
  // tempo: lets go of a viewer's held keys and buttons once it loses the tab.
  private readonly releaseInput: (viewerId: string) => Promise<void>;
  private readonly now: () => number;
  private tail: Promise<unknown> = Promise.resolve();
  private pending: Promise<void> = Promise.resolve();
  private readonly handoff = new Set<Promise<void>>();
  private owner: string | null = null;
  // tempo: when the owner last gave deliberate input.
  private ownerInputAt = 0;
  private epoch = 0;
  private closed = false;

  constructor(
    agentId: string | null,
    onGenerationChange: () => void = () => {},
    // tempo: the clock is injectable so tests need no sleeps.
    options: {
      readonly releaseInput?: (viewerId: string) => Promise<void>;
      readonly now?: () => number;
    } = {},
  ) {
    this.agentId = agentId;
    this.onGenerationChange = onGenerationChange;
    this.releaseInput = options.releaseInput ?? (async () => {});
    this.now = options.now ?? (() => Date.now());
  }

  get controller() {
    return this.owner;
  }

  get generation() {
    return this.epoch;
  }

  private enqueue<A>(run: () => Promise<A>): Promise<A> {
    const result = this.tail.then(run);
    this.tail = result.then(
      () => this.pending,
      () => this.pending,
    );
    return result;
  }

  /** An action can respond before its navigation commits, while later actions still wait. */
  track(work: Promise<unknown>) {
    this.pending = Promise.all([this.pending, settle(work)]).then(() => undefined);
  }

  /** Viewer input stays responsive, but control handoffs still drain its navigations. */
  trackUntilHandoff(work: Promise<unknown>) {
    const settled = settle(work).finally(() => {
      this.handoff.delete(settled);
    });
    this.handoff.add(settled);
  }

  private assertOpen() {
    if (this.closed) throw new BrowserControlInterrupted("This browser tab is closed.", "closed");
  }

  // tempo: a viewer that loses the tab, however it loses it, lets go of its held
  // input once running work drains. Only a tab going back to agents also waits
  // for that viewer's navigations, so an agent never acts on a page still
  // loading; another person's input reaches the page at once, as in a browser.
  private changeOwner(owner: string | null) {
    const previous = this.owner;
    this.owner = owner;
    this.epoch++;
    this.onGenerationChange();
    if (previous === null || this.closed) return Promise.resolve();
    return this.enqueue(async () => {
      if (owner === null) await Promise.all(this.handoff);
      await this.releaseInput(previous);
    }).catch(() => {});
  }

  private async action<A>(allowed: () => boolean, run: () => Promise<A>, deadlineMs?: number) {
    this.assertOpen();
    if (!allowed()) throw new BrowserControlInterrupted("You do not control this browser tab.");
    const epoch = this.epoch;
    return this.enqueue(async () => {
      this.assertOpen();
      if (epoch !== this.epoch || !allowed()) throw new BrowserControlInterrupted();
      if (deadlineMs !== undefined && performance.now() >= deadlineMs) {
        throw new DOMException(
          "This browser request expired before it could start.",
          "TimeoutError",
        );
      }
      return run();
    });
  }

  agentMayAct(agentId: string) {
    return this.agentId === null || this.agentId === agentId;
  }

  agent<A>(agentId: string, run: () => Promise<A>, deadlineMs?: number) {
    if (!this.agentMayAct(agentId))
      return Promise.reject(
        new BrowserControlInterrupted("This tab belongs to another agent.", "agentMismatch"),
      );
    // tempo: an active person keeps the tab; an idle one hands it back first.
    if (!this.yieldToAgent()) return Promise.reject(humanControlError());
    return this.action(() => this.agentMayAct(agentId) && this.owner === null, run, deadlineMs);
  }

  agentCanActNow(agentId: string) {
    // tempo: an action would hand back an idle person's tab.
    return this.agentMayAct(agentId) && !this.humanActive();
  }

  /** tempo: whether a person holds the tab and gave deliberate input within HUMAN_HOLD_MS. */
  humanActive() {
    return this.owner !== null && this.now() - this.ownerInputAt < HUMAN_HOLD_MS;
  }

  /**
   * tempo: before an agent acts, a person idle for HUMAN_HOLD_MS lets go of the
   * tab. False while a person is active, so the agent waits instead.
   */
  yieldToAgent() {
    if (this.humanActive()) return false;
    if (this.owner !== null) void this.changeOwner(null);
    return true;
  }

  /** Read without control or queueing so agents can observe without delaying human input. */
  observe<A>(run: () => Promise<A>) {
    this.assertOpen();
    return run();
  }

  system<A>(run: () => Promise<A>) {
    this.assertOpen();
    return this.enqueue(async () => {
      this.assertOpen();
      return run();
    });
  }

  human<A>(viewerId: string, run: () => Promise<A>) {
    return this.action(() => this.owner === viewerId, run);
  }

  /**
   * tempo: a person's deliberate input takes the tab from an agent or another
   * viewer, and keeps it from agents for HUMAN_HOLD_MS. True when the owner
   * changed. It is synchronous so a claim lands before the input it precedes.
   */
  claim(viewerId: string) {
    this.assertOpen();
    this.ownerInputAt = this.now();
    if (this.owner === viewerId) return false;
    void this.changeOwner(viewerId);
    return true;
  }

  async release(viewerId: string) {
    this.assertOpen();
    if (this.owner !== viewerId) {
      throw new BrowserControlInterrupted(
        "Only the controlling viewer can release this browser tab.",
      );
    }
    await this.changeOwner(null);
  }

  async disconnect(viewerId: string) {
    if (!this.closed && this.owner === viewerId) await this.release(viewerId);
  }

  async close() {
    if (!this.closed) {
      this.closed = true;
      this.changeOwner(null);
    }
    await this.tail;
  }
}
