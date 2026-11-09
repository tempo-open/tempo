/**
 * The seam between a server browser tab and its passkey provider: `saved` (Chrome's virtual
 * authenticator) or `icloud-keychain` (the person's Mac, `saved` beside it). Every agent action
 * runs through `agentAction`: unless the profile lets agents use passkeys, a page an agent touched
 * fails every ceremony (never quietly succeeds) until a person navigates it (`personNavigation`).
 */
import type { TempoPasskeyProvider, ThreadId } from "@t3tools/contracts";
import type { CDPSession } from "playwright-core";

export interface BrowserAuthenticatorTarget {
  readonly profileId: string;
  /** The tab's own DevTools session; WebAuthn is set up per page target. */
  readonly cdp: Pick<CDPSession, "send" | "on" | "off">;
  /** Whether an agent opened the tab, or its page came from one an agent touched (a popup). */
  readonly agentTouched: boolean;
  /** Whether a tab linked to this one by `window.opener` holds a page an agent opened or acted in. */
  readonly linkedTabsTouched: () => boolean;
  /** The tab's thread, which the person's Mac names when it asks. Passkeys from a Mac need it. */
  readonly threadId?: ThreadId;
  /** The client session of the person holding the tab; their Mac answers its passkey requests. */
  readonly controllerSessionId?: () => string | null;
}

export interface BrowserAuthenticatorSession {
  /**
   * Runs one agent action in the tab. Unless the profile lets agents use
   * passkeys, the page loses them before the action runs and stays locked
   * until a person loads a new page in the tab. A page that cannot be locked
   * is left with no authenticator for saved passkeys, and the action still runs.
   */
  readonly agentAction: <A>(run: () => Promise<A>) => Promise<A>;
  /**
   * Runs a person's navigation from the browser's controls: the address bar,
   * reload, back, or forward. The page it loads is theirs, unless a linked tab
   * still holds an agent's page.
   */
  readonly personNavigation: <A>(run: () => Promise<A>) => Promise<A>;
  /** Whether an agent opened or acted in the tab's current page. */
  readonly agentTouched: () => boolean;
  /**
   * Call after another DevTools session, such as a viewer's, leaves the tab's
   * page. Chrome drops the page's virtual authenticators with any session
   * that leaves, so the tab sets its saved passkeys up again.
   */
  readonly sessionDetached: () => void;
  /** Stops serving the tab; call when it closes. */
  readonly detach: () => void;
  /** Resolves once the tab's pending passkey work (setup, saves, ceremonies) has finished. */
  readonly idle: () => Promise<void>;
}

export interface BrowserAuthenticator {
  readonly provider: TempoPasskeyProvider;
  /** Readies one tab, before its page runs, for as long as it stays open. */
  readonly attach: (target: BrowserAuthenticatorTarget) => Promise<BrowserAuthenticatorSession>;
}
