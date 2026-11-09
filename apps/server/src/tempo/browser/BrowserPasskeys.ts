// @effect-diagnostics nodeBuiltinImport:off - Hashes profile ids into secret names; Effect has no sync digest.
/**
 * Passkeys saved in a server browser profile, kept in the server secret store (one secret per
 * profile; clients see only metadata) and served by Chrome's virtual authenticator in each tab.
 * A change in one tab refreshes the others so sign counts never go backwards. A page an agent
 * touched holds no credentials unless agents may use them, and never under `icloud-keychain`.
 */
import {
  TEMPO_DEFAULT_PASSKEY_SETTINGS,
  TempoBrowserProfileError,
  type TempoBrowserProfileState,
  type TempoBrowserSetPasskeySettingsInput,
  type TempoPasskeyProvider,
  TempoPasskeySettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as LaptopToolHosts from "../laptopTools/LaptopToolHosts.ts";
import type {
  BrowserAuthenticator,
  BrowserAuthenticatorSession,
  BrowserAuthenticatorTarget,
} from "./BrowserAuthenticator.ts";
import { attachICloudKeychain, type ICloudKeychainOptions } from "./ICloudKeychainPasskeys.ts";

const StoredPasskey = Schema.Struct({
  credentialId: Schema.String,
  isResidentCredential: Schema.Boolean,
  rpId: Schema.String,
  /** PKCS#8, base64. Never leaves the server. */
  privateKey: Schema.String,
  userHandle: Schema.optionalKey(Schema.String),
  signCount: Schema.Number,
  largeBlob: Schema.optionalKey(Schema.String),
  backupEligibility: Schema.optionalKey(Schema.Boolean),
  backupState: Schema.optionalKey(Schema.Boolean),
  userName: Schema.optionalKey(Schema.String),
  userDisplayName: Schema.optionalKey(Schema.String),
  createdAt: Schema.String,
  lastUsedAt: Schema.NullOr(Schema.String),
});
type StoredPasskey = typeof StoredPasskey.Type;

const ProfilePasskeys = Schema.Struct({
  version: Schema.Literal(1),
  settings: TempoPasskeySettings,
  credentials: Schema.Array(StoredPasskey),
});
type ProfilePasskeys = typeof ProfilePasskeys.Type;

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(ProfilePasskeys));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(ProfilePasskeys));

const EMPTY_PROFILE: ProfilePasskeys = {
  version: 1,
  settings: TEMPO_DEFAULT_PASSKEY_SETTINGS,
  credentials: [],
};

/** Profile ids are free text; the secret name is a hash of one. */
export const passkeySecretName = (profileId: string) =>
  `tempo-browser-passkeys-${NodeCrypto.createHash("sha256").update(profileId).digest("hex").slice(0, 32)}`;

type PasskeysView = TempoBrowserProfileState["passkeys"];

const toView = (
  profile: ProfilePasskeys,
  availableProviders: ReadonlyArray<TempoPasskeyProvider>,
): PasskeysView => ({
  settings: profile.settings,
  saved: profile.credentials.map((credential) => ({
    credentialId: credential.credentialId,
    rpId: credential.rpId,
    ...(credential.userName === undefined ? {} : { userName: credential.userName }),
    ...(credential.userDisplayName === undefined
      ? {}
      : { userDisplayName: credential.userDisplayName }),
    createdAt: credential.createdAt,
    lastUsedAt: credential.lastUsedAt,
  })),
  availableProviders,
});

const storage = (cause: unknown) => new TempoBrowserProfileError({ reason: "storage", cause });

/**
 * The authenticator Chrome emulates for saved passkeys. It starts without
 * presence, verification, or credentials, so nothing signs with a new one
 * until an apply unlocks the tab.
 */
const VIRTUAL_AUTHENTICATOR = {
  protocol: "ctap2",
  transport: "internal",
  hasResidentKey: true,
  hasUserVerification: true,
  isUserVerified: false,
  automaticPresenceSimulation: false,
} as const;

type CdpCredential = Omit<StoredPasskey, "createdAt" | "lastUsedAt" | "rpId"> & {
  readonly rpId?: string;
};

const fromCdp = (
  credential: CdpCredential,
  previous: StoredPasskey | undefined,
  at: string,
): StoredPasskey => ({
  credentialId: credential.credentialId,
  isResidentCredential: credential.isResidentCredential,
  rpId: credential.rpId ?? previous?.rpId ?? "",
  privateKey: credential.privateKey,
  ...(credential.userHandle === undefined ? {} : { userHandle: credential.userHandle }),
  signCount: Math.max(credential.signCount, previous?.signCount ?? 0),
  ...(credential.largeBlob === undefined ? {} : { largeBlob: credential.largeBlob }),
  ...(credential.backupEligibility === undefined
    ? {}
    : { backupEligibility: credential.backupEligibility }),
  ...(credential.backupState === undefined ? {} : { backupState: credential.backupState }),
  ...((credential.userName ?? previous?.userName) === undefined
    ? {}
    : { userName: credential.userName ?? previous!.userName! }),
  ...((credential.userDisplayName ?? previous?.userDisplayName) === undefined
    ? {}
    : { userDisplayName: credential.userDisplayName ?? previous!.userDisplayName! }),
  createdAt: previous?.createdAt ?? at,
  lastUsedAt: previous?.lastUsedAt ?? null,
});

/**
 * Chrome keeps one discoverable credential per site and account: creating
 * another deletes the first. The store follows, or the stale one would block
 * the new one from being added to tabs.
 */
const sameAccount = (a: StoredPasskey, b: StoredPasskey) =>
  a.isResidentCredential &&
  b.isResidentCredential &&
  a.rpId === b.rpId &&
  a.userHandle !== undefined &&
  a.userHandle === b.userHandle;

const toCdp = ({ createdAt: _created, lastUsedAt: _used, ...credential }: StoredPasskey) =>
  credential;

export class BrowserPasskeys extends Context.Service<
  BrowserPasskeys,
  {
    readonly get: (profileId: string) => Effect.Effect<PasskeysView, TempoBrowserProfileError>;
    readonly setSettings: (
      input: TempoBrowserSetPasskeySettingsInput,
    ) => Effect.Effect<PasskeysView, TempoBrowserProfileError>;
    readonly remove: (input: {
      readonly profileId: string;
      readonly credentialId: string;
    }) => Effect.Effect<PasskeysView, TempoBrowserProfileError>;
    /** Deletes every passkey and setting of a profile that is going away. */
    readonly forget: (profileId: string) => Effect.Effect<void, TempoBrowserProfileError>;
    /** Readies a new tab for the profile's passkey provider; it serves the tab until detached. */
    readonly attach: (
      target: BrowserAuthenticatorTarget,
    ) => Effect.Effect<BrowserAuthenticatorSession>;
  }
>()("t3/tempo/browser/BrowserPasskeys") {}

interface LiveSession {
  readonly apply: () => Promise<void>;
}

const constVoid = () => {};

/**
 * For a tab its provider could not set up: nothing to lock, so agent actions
 * just run. It still counts as touched, which keeps its linked tabs locked.
 */
const unattached = (target: BrowserAuthenticatorTarget): BrowserAuthenticatorSession => {
  let agentTouched = target.agentTouched;
  return {
    agentAction: (run) => {
      agentTouched = true;
      return run();
    },
    personNavigation: (run) => run(),
    agentTouched: () => agentTouched,
    sessionDetached: constVoid,
    detach: constVoid,
    idle: async () => {},
  };
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const lock = yield* Semaphore.make(1);
  const cache = new Map<string, ProfilePasskeys>();
  /** Every attached tab, by profile, so changes reach tabs already open. */
  const sessions = new Map<string, Set<LiveSession>>();

  const load = Effect.fn("BrowserPasskeys.load")(function* (profileId: string) {
    const cached = cache.get(profileId);
    if (cached) return cached;
    const stored = yield* secrets.get(passkeySecretName(profileId));
    // An unreadable store fails rather than reads empty, so no write can replace it.
    const profile = Option.isNone(stored)
      ? EMPTY_PROFILE
      : yield* decodeProfile(new TextDecoder().decode(stored.value));
    cache.set(profileId, profile);
    return profile;
  }, Effect.mapError(storage));

  /** Applies a change to the stored profile; a change that returns the profile as is writes nothing. */
  const update = (profileId: string, change: (profile: ProfilePasskeys) => ProfilePasskeys) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* load(profileId);
        const next = change(current);
        if (next === current) return current;
        const encoded = yield* encodeProfile(next).pipe(Effect.mapError(storage));
        yield* secrets
          .set(passkeySecretName(profileId), new TextEncoder().encode(encoded))
          .pipe(Effect.mapError(storage));
        cache.set(profileId, next);
        return next;
      }),
    );

  const now = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  /** Brings every open tab of a profile in line with its stored settings and passkeys. */
  const refreshTabs = (profileId: string) =>
    Effect.sync(() => {
      for (const session of sessions.get(profileId) ?? []) void session.apply().catch(constVoid);
    });

  const warn = (message: string, cause: unknown) => {
    runFork(Effect.logWarning(message, { cause }));
  };

  const saved: BrowserAuthenticator = {
    provider: "saved",
    attach: async (target) => {
      const { profileId, cdp } = target;
      let authenticatorId: string | null = null;
      /**
       * True unless the tab holds the profile's passkeys with presence and
       * verification on. A locked tab's credential events are never saved.
       */
      let locked = true;
      let detached = false;
      /** An agent opened or acted in the current page. */
      let agentTouched = target.agentTouched;
      /** An agent ever acted in the tab, so a page restored from history may hold its script. */
      let everAgentTouched = target.agentTouched;
      let agentActions = 0;
      /** A person's navigation from the browser's controls is under way. */
      let personNavigations = 0;
      /** Credentials the tab is removing itself: Chrome reports those deletions as well. */
      const removing = new Set<string>();
      let queue = Promise.resolve();
      /** An apply waiting its turn; later requests share it, since it reads state when it runs. */
      let queued: Promise<void> | null = null;
      const saving = new Set<Promise<void>>();
      // Changes run one at a time per tab, in order. A failed one is logged and
      // reported to whoever asked for it; the queue carries on.
      const serially = (work: () => Promise<void>) => {
        const result = queue.then(work);
        queue = result.catch((cause: unknown) => {
          if (!detached) warn("Could not update the tab's saved passkeys; it holds none.", cause);
        });
        return result;
      };
      /** Takes the tab's authenticator away with everything it holds, leaving the tab locked. */
      const dropAuthenticator = async () => {
        locked = true;
        const id = authenticatorId;
        authenticatorId = null;
        // Chrome refuses this only for an authenticator it dropped already, which signs nothing.
        if (id !== null) {
          await cdp
            .send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id })
            .catch(constVoid);
        }
      };
      const addAll = async (id: string, credentials: Iterable<StoredPasskey>) => {
        // One credential Chrome refuses must not cost the tab the others.
        for (const credential of credentials) {
          await cdp
            .send("WebAuthn.addCredential", { authenticatorId: id, credential: toCdp(credential) })
            .catch((cause: unknown) =>
              warn("Could not give a tab one of its saved passkeys.", cause),
            );
        }
      };
      /** Brings the tab in line with the profile, failing on the first command Chrome refuses. */
      const sync = async () => {
        if (detached) return;
        const profile = await runPromise(load(profileId));
        // With iCloud Keychain the saved passkeys stay too: they answer when no Mac can.
        if (!profile.settings.savePasskeys) {
          locked = true;
          if (authenticatorId !== null) {
            const id = authenticatorId;
            authenticatorId = null;
            await cdp.send("WebAuthn.removeVirtualAuthenticator", { authenticatorId: id });
          }
          return;
        }
        if (authenticatorId === null) {
          await cdp.send("WebAuthn.enable", { enableUI: false });
          ({ authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
            options: VIRTUAL_AUTHENTICATOR,
          }));
          locked = true;
        }
        const id = authenticatorId;
        // With iCloud Keychain an agent signs in only through the Mac's prompt, never with these.
        const agentsMaySign =
          profile.settings.agentsMayUse && profile.settings.provider !== "icloud-keychain";
        if (!agentsMaySign && (agentTouched || agentActions > 0)) {
          // Lock first, so nothing can sign while the credentials go.
          locked = true;
          await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
            authenticatorId: id,
            enabled: false,
          });
          await cdp.send("WebAuthn.setUserVerified", {
            authenticatorId: id,
            isUserVerified: false,
          });
          await cdp.send("WebAuthn.clearCredentials", { authenticatorId: id });
          return;
        }
        if (locked) {
          // A lock that failed part way may have left credentials behind.
          await cdp.send("WebAuthn.clearCredentials", { authenticatorId: id });
          await addAll(id, profile.credentials);
          await cdp.send("WebAuthn.setUserVerified", { authenticatorId: id, isUserVerified: true });
          await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
            authenticatorId: id,
            enabled: true,
          });
          locked = false;
          return;
        }
        // An unlocked tab changes only the credentials that differ, and never
        // turns presence off: a sign-in it is in the middle of would hang.
        const { credentials: held } = await cdp.send("WebAuthn.getCredentials", {
          authenticatorId: id,
        });
        const missing = new Map(
          profile.credentials.map((credential) => [credential.credentialId, credential]),
        );
        for (const credential of held) {
          const stored = missing.get(credential.credentialId);
          // A count ahead of the store is a sign-in whose save is on its way.
          if (stored !== undefined && stored.signCount <= credential.signCount) {
            missing.delete(credential.credentialId);
            continue;
          }
          removing.add(credential.credentialId);
          try {
            await cdp.send("WebAuthn.removeCredential", {
              authenticatorId: id,
              credentialId: credential.credentialId,
            });
          } finally {
            removing.delete(credential.credentialId);
          }
        }
        await addAll(id, missing.values());
      };
      /**
       * Chrome ties a page's virtual authenticators to the page, not to the session that added
       * them, and drops them when any DevTools session leaves it (a viewer's, say). So a failed
       * sync starts over once from a new authenticator; a second failure leaves the tab with
       * none, and nothing signs in it until the next apply.
       */
      const applyNow = async () => {
        try {
          await sync();
        } catch {
          await dropAuthenticator();
          try {
            await sync();
          } catch (cause) {
            await dropAuthenticator();
            throw cause;
          }
        }
      };
      const session: LiveSession = {
        apply: () => {
          if (queued !== null) return queued;
          const run = serially(async () => {
            queued = null;
            await applyNow();
          });
          queued = run;
          return run;
        },
      };
      const save = (work: Effect.Effect<void, TempoBrowserProfileError>) => {
        const pending = runPromise(work).catch((cause: unknown) =>
          warn("Could not save a passkey.", cause),
        );
        saving.add(pending);
        void pending.finally(() => saving.delete(pending));
      };
      /** Stores a credential the page created here, replacing any earlier one for the same account. */
      const recordAdded = (credential: CdpCredential) =>
        save(
          Effect.gen(function* () {
            const at = yield* now;
            yield* update(profileId, (profile) => {
              const previous = profile.credentials.find(
                (candidate) => candidate.credentialId === credential.credentialId,
              );
              const next = fromCdp(credential, previous, at);
              return {
                ...profile,
                credentials: [
                  ...profile.credentials.filter(
                    (candidate) =>
                      candidate.credentialId !== next.credentialId && !sameAccount(candidate, next),
                  ),
                  next,
                ],
              };
            });
            yield* refreshTabs(profileId);
          }),
        );
      /**
       * Moves a saved credential's sign count (and names) forward. One the
       * store no longer has, such as a passkey just deleted, is never put
       * back; the refresh drops it from the tab instead.
       */
      const recordChanged = (credential: CdpCredential, used: boolean) =>
        save(
          Effect.gen(function* () {
            const at = yield* now;
            yield* update(profileId, (profile) => {
              const previous = profile.credentials.find(
                (candidate) => candidate.credentialId === credential.credentialId,
              );
              if (!previous) return profile;
              const next = {
                ...fromCdp(credential, previous, at),
                ...(used ? { lastUsedAt: at } : {}),
              };
              return {
                ...profile,
                credentials: profile.credentials.map((candidate) =>
                  candidate === previous ? next : candidate,
                ),
              };
            });
            yield* refreshTabs(profileId);
          }),
        );
      const recordDeleted = (credentialId: string) =>
        save(
          Effect.gen(function* () {
            yield* update(profileId, (profile) =>
              profile.credentials.some((candidate) => candidate.credentialId === credentialId)
                ? {
                    ...profile,
                    credentials: profile.credentials.filter(
                      (candidate) => candidate.credentialId !== credentialId,
                    ),
                  }
                : profile,
            );
            yield* refreshTabs(profileId);
          }),
        );
      type CredentialEvent = { authenticatorId: string; credential: CdpCredential };
      // The page's own changes are saved only while the tab is unlocked.
      // Assertions always are: they can only use a credential the store gave
      // the tab, and only move it forward. Chrome reports a credential this
      // tab removes or clears itself as deleted too; those are not the page's.
      const onAdded = (payload: CredentialEvent) => {
        if (payload.authenticatorId === authenticatorId && !locked) recordAdded(payload.credential);
      };
      const onAsserted = (payload: CredentialEvent) => {
        if (payload.authenticatorId === authenticatorId) recordChanged(payload.credential, true);
      };
      const onUpdated = (payload: CredentialEvent) => {
        if (payload.authenticatorId === authenticatorId && !locked)
          recordChanged(payload.credential, false);
      };
      const onDeleted = (payload: { authenticatorId: string; credentialId: string }) => {
        if (
          payload.authenticatorId === authenticatorId &&
          !locked &&
          !removing.has(payload.credentialId)
        )
          recordDeleted(payload.credentialId);
      };
      // A new document drops whatever an agent ran in the old one, but only a
      // page a person loaded from the browser's controls is theirs again: the
      // agent's script can navigate too, to a page that signs in on load. A
      // linked tab still holding an agent's page could reach the new one.
      const onNavigated = (payload: {
        frame: { parentId?: string };
        type: "Navigation" | "BackForwardCacheRestore";
      }) => {
        if (payload.frame.parentId !== undefined) return;
        if (payload.type === "BackForwardCacheRestore") {
          if (everAgentTouched && !agentTouched) {
            agentTouched = true;
            void session.apply().catch(constVoid);
          }
          return;
        }
        if (!agentTouched || personNavigations === 0 || agentActions > 0) return;
        if (target.linkedTabsTouched()) return;
        agentTouched = false;
        void session.apply().catch(constVoid);
      };
      /**
       * Playwright hears of a commit before this session does. A round trip on
       * this session delivers every event Chrome sent it before, so an earlier
       * navigation's commit never counts as the person's, and theirs is seen
       * before the window closes.
       */
      const caughtUp = () => cdp.send("Page.getFrameTree").then(constVoid, constVoid);
      cdp.on("WebAuthn.credentialAdded", onAdded);
      cdp.on("WebAuthn.credentialAsserted", onAsserted);
      cdp.on("WebAuthn.credentialUpdated", onUpdated);
      cdp.on("WebAuthn.credentialDeleted", onDeleted);
      cdp.on("Page.frameNavigated", onNavigated);
      const tabs = sessions.get(profileId) ?? new Set<LiveSession>();
      tabs.add(session);
      sessions.set(profileId, tabs);
      const detach = () => {
        detached = true;
        cdp.off("WebAuthn.credentialAdded", onAdded);
        cdp.off("WebAuthn.credentialAsserted", onAsserted);
        cdp.off("WebAuthn.credentialUpdated", onUpdated);
        cdp.off("WebAuthn.credentialDeleted", onDeleted);
        cdp.off("Page.frameNavigated", onNavigated);
        tabs.delete(session);
        if (tabs.size === 0 && sessions.get(profileId) === tabs) sessions.delete(profileId);
      };
      try {
        await cdp.send("Page.enable");
      } catch (cause) {
        detach();
        throw cause;
      }
      // A failed first apply leaves the tab locked; the next change retries it.
      await session.apply().catch(constVoid);
      return {
        agentAction: async (run) => {
          agentTouched = true;
          everAgentTouched = true;
          agentActions++;
          try {
            // A tab that cannot be locked holds no authenticator by now, so the action runs anyway.
            await session.apply().catch(constVoid);
            return await run();
          } finally {
            agentActions--;
          }
        },
        personNavigation: async (run) => {
          await caughtUp();
          personNavigations++;
          try {
            return await run();
          } finally {
            await caughtUp();
            personNavigations--;
          }
        },
        agentTouched: () => agentTouched,
        // The apply finds the old authenticator gone and sets up a new one.
        sessionDetached: () => void session.apply().catch(constVoid),
        idle: async () => {
          while (saving.size > 0) await Promise.all(saving);
          await queue;
        },
        detach,
      };
    },
  };

  // iCloud Keychain needs the laptops that connect to this environment.
  const laptops = Option.getOrUndefined(
    yield* Effect.serviceOption(LaptopToolHosts.LaptopToolHosts),
  );
  const threads = Option.getOrUndefined(
    yield* Effect.serviceOption(ThreadManagementService.ThreadManagementService),
  );
  const icloud: ICloudKeychainOptions | undefined =
    laptops === undefined
      ? undefined
      : {
          relay: ({ sessionId, request, timeoutMs, signal }) =>
            runPromise(
              laptops.send({ sessionId, request, timeoutMs }).pipe(
                Effect.map((outcome) =>
                  outcome._tag === "passkey"
                    ? outcome.result
                    : outcome._tag === "failure" && outcome.code === "server-unavailable"
                      ? ("no-laptop" as const)
                      : { _tag: "refused" as const, error: "NotAllowedError" as const },
                ),
                Effect.catchTags({
                  // No connected Mac takes passkeys (or several could and none holds the tab).
                  LaptopToolsUnavailableError: (error) =>
                    Effect.succeed(
                      error.code === "server-not-found"
                        ? ("no-laptop" as const)
                        : { _tag: "refused" as const, error: "NotAllowedError" as const },
                    ),
                }),
              ),
              { signal },
            ).catch(() => ({
              _tag: "refused" as const,
              error: signal.aborted ? ("AbortError" as const) : ("NotAllowedError" as const),
            })),
          settings: (profileId) => runPromise(load(profileId)).then((profile) => profile.settings),
          threadTitle: (threadId) =>
            threads === undefined
              ? Promise.resolve("")
              : runPromise(
                  threads.getThreadShell(threadId).pipe(
                    Effect.map((shell) => shell?.title ?? ""),
                    Effect.orElseSucceed(() => ""),
                  ),
                ),
          warn,
        };

  /** Providers this environment can serve. */
  const providers = new Set<TempoPasskeyProvider>(
    icloud === undefined ? [saved.provider] : [saved.provider, "icloud-keychain"],
  );
  const availableProviders = [...providers];

  const get: BrowserPasskeys["Service"]["get"] = (profileId) =>
    load(profileId).pipe(Effect.map((profile) => toView(profile, availableProviders)));

  const setSettings: BrowserPasskeys["Service"]["setSettings"] = Effect.fn(
    "BrowserPasskeys.setSettings",
  )(function* ({ profileId, ...changes }) {
    if (changes.provider !== undefined && !providers.has(changes.provider)) {
      return yield* new TempoBrowserProfileError({ reason: "provider_unavailable" });
    }
    const next = yield* update(profileId, (profile) => ({
      ...profile,
      settings: { ...profile.settings, ...changes },
    }));
    yield* refreshTabs(profileId);
    return toView(next, availableProviders);
  });

  const remove: BrowserPasskeys["Service"]["remove"] = Effect.fn("BrowserPasskeys.remove")(
    function* ({ profileId, credentialId }) {
      const current = yield* load(profileId);
      if (!current.credentials.some((credential) => credential.credentialId === credentialId)) {
        return yield* new TempoBrowserProfileError({ reason: "not_found" });
      }
      const next = yield* update(profileId, (profile) => ({
        ...profile,
        credentials: profile.credentials.filter(
          (credential) => credential.credentialId !== credentialId,
        ),
      }));
      yield* refreshTabs(profileId);
      return toView(next, availableProviders);
    },
  );

  const forget: BrowserPasskeys["Service"]["forget"] = (profileId) =>
    lock
      .withPermit(
        Effect.gen(function* () {
          yield* secrets.remove(passkeySecretName(profileId)).pipe(Effect.mapError(storage));
          cache.delete(profileId);
        }),
      )
      .pipe(Effect.andThen(refreshTabs(profileId)));

  const attach: BrowserPasskeys["Service"]["attach"] = (target) =>
    Effect.promise(async (): Promise<BrowserAuthenticatorSession> => {
      const session = await saved.attach(target).catch((cause: unknown) => {
        warn("Could not set up saved passkeys for a tab.", cause);
        return unattached(target);
      });
      if (icloud === undefined || target.threadId === undefined) return session;
      // Every tab gets the bridge; it runs only while the profile asks for iCloud Keychain.
      const bridge = attachICloudKeychain(icloud, {
        profileId: target.profileId,
        threadId: target.threadId,
        cdp: target.cdp,
        controllerSessionId: target.controllerSessionId ?? (() => null),
        agentTouched: session.agentTouched,
      });
      const live: LiveSession = { apply: bridge.apply };
      const tabs = sessions.get(target.profileId) ?? new Set<LiveSession>();
      tabs.add(live);
      sessions.set(target.profileId, tabs);
      // Before the page loads, so a sign-in on load already goes to the Mac.
      await bridge.apply().catch(constVoid);
      return {
        ...session,
        detach: () => {
          bridge.detach();
          tabs.delete(live);
          if (tabs.size === 0 && sessions.get(target.profileId) === tabs) {
            sessions.delete(target.profileId);
          }
          session.detach();
        },
        idle: async () => {
          await session.idle();
          await bridge.idle();
        },
      };
    });

  return BrowserPasskeys.of({ get, setSettings, remove, forget, attach });
});

export const layer = Layer.effect(BrowserPasskeys, make);
