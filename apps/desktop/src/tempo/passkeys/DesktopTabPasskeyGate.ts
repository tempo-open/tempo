// @effect-diagnostics globalDate:off - Ceremonies are gated inside IPC handlers, outside an Effect runtime.
/**
 * tempo: the agent gate on tabs the desktop draws for its own environment, whose passkey requests go
 * straight to the system sheet. Once an agent opened or acted in a tab (the server says so over
 * the desktop browser channel), each site's first request since launch is the person's to
 * confirm first, as in `LaptopPasskeys`. A Deny quiets that site for a minute.
 */
import { PASSKEY_DENIED_QUIET_MS } from "./LaptopPasskeys.ts";

export type DesktopTabPasskeyCeremony = "create" | "get";

/** How the person answered: Continue, Deny, or nothing before the request gave up. */
export type DesktopTabPasskeyAnswer = "allow" | "deny" | "dismissed";

/** "sheet" lets the request reach the system sheet; anything else is the page's error. */
export type DesktopTabPasskeyAdmission = "sheet" | "NotAllowedError" | "SecurityError";

const stringMember = (value: unknown, key: string): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const member: unknown = Reflect.get(value, key);
  return typeof member === "string" ? member : undefined;
};

/**
 * The relying party a request names, if its page's origin may use it: the
 * origin's own host or a parent domain of it, as WebAuthn requires. WebAuthn
 * defaults it to the origin's host. Null for one the origin may not use; the
 * native layer refuses those too, and public suffixes as well.
 */
export const desktopTabRelyingParty = (
  ceremony: DesktopTabPasskeyCeremony,
  publicKey: unknown,
  origin: string,
): string | null => {
  if (!URL.canParse(origin)) return null;
  const host = new URL(origin).hostname.toLowerCase();
  const requested =
    ceremony === "create"
      ? stringMember(
          typeof publicKey === "object" && publicKey !== null
            ? Reflect.get(publicKey, "rp")
            : undefined,
          "id",
        )
      : stringMember(publicKey, "rpId");
  const rpId = (requested ?? host).toLowerCase();
  return rpId.length > 0 && (rpId === host || host.endsWith(`.${rpId}`)) ? rpId : null;
};

export class DesktopTabPasskeyGate {
  private readonly now: () => number;
  /** Sites the person confirmed once from a tab an agent drove, until the app quits. */
  private readonly confirmedSites = new Set<string>();
  /** Until when a site's requests are refused without asking, after a Deny. */
  private readonly deniedUntil = new Map<string, number>();

  constructor(options: { readonly now?: () => number } = {}) {
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Whether a request may go on to the system sheet. A tab no agent drove
   * always may, as before; for an agent's tab, `ask` puts a site's first
   * request to the person.
   */
  async admit(input: {
    readonly agentDrove: boolean;
    readonly ceremony: DesktopTabPasskeyCeremony;
    readonly publicKey: unknown;
    readonly origin: string;
    readonly ask: (rpId: string) => Promise<DesktopTabPasskeyAnswer>;
  }): Promise<DesktopTabPasskeyAdmission> {
    if (!input.agentDrove) return "sheet";
    const rpId = desktopTabRelyingParty(input.ceremony, input.publicKey, input.origin);
    if (rpId === null) return "SecurityError";
    if (this.confirmedSites.has(rpId)) return "sheet";
    if (this.quiet(rpId)) return "NotAllowedError";
    const answer = await input.ask(rpId);
    if (answer === "allow") {
      this.confirmedSites.add(rpId);
      return "sheet";
    }
    // Only an explicit Deny quiets the site; a request that gave up may ask again.
    if (answer === "deny") this.deniedUntil.set(rpId, this.now() + PASSKEY_DENIED_QUIET_MS);
    return "NotAllowedError";
  }

  private quiet(rpId: string): boolean {
    const until = this.deniedUntil.get(rpId);
    if (until === undefined) return false;
    if (until > this.now()) return true;
    this.deniedUntil.delete(rpId);
    return false;
  }
}
