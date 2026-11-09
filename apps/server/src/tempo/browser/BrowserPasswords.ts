// @effect-diagnostics nodeBuiltinImport:off - Hashes profile ids into secret names; Effect has no sync digest.
/**
 * A profile's saved passwords (in the secret store; clients see only sites, usernames, dates) and
 * every tab's saving and filling. Origins come from the browser, never the page; a save replaces
 * its username on that origin, and a frame gets only its own origin's. With "Let agents use
 * passwords" off, agent pages get no fills, and fills are emptied before each agent action.
 */
import {
  TEMPO_DEFAULT_PASSWORD_SETTINGS,
  TempoBrowserProfileError,
  type TempoBrowserProfileState,
  type TempoBrowserSetPasswordSettingsInput,
  TempoPasswordSettings,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as NodeCrypto from "node:crypto";
import type { CDPSession } from "playwright-core";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import {
  CLEAR_EXPRESSION,
  fillExpression,
  type FormField,
  isPasswordOrigin,
  parsePasswordMessage,
  PASSWORD_BINDING,
  PASSWORD_WORLD,
  passwordPageScript,
  pickSignIn,
  planFill,
  savedFor,
  usernameFor,
} from "./passwordForms.ts";

const StoredPassword = Schema.Struct({
  origin: Schema.String,
  username: Schema.String,
  /** Never leaves the server. */
  password: Schema.String,
  createdAt: Schema.String,
  lastUsedAt: Schema.String,
});
type StoredPassword = typeof StoredPassword.Type;

const ProfilePasswords = Schema.Struct({
  version: Schema.Literal(1),
  settings: TempoPasswordSettings,
  saved: Schema.Array(StoredPassword),
});
type ProfilePasswords = typeof ProfilePasswords.Type;

const decodeProfile = Schema.decodeUnknownEffect(Schema.fromJsonString(ProfilePasswords));
const encodeProfile = Schema.encodeEffect(Schema.fromJsonString(ProfilePasswords));

const EMPTY_PROFILE: ProfilePasswords = {
  version: 1,
  settings: TEMPO_DEFAULT_PASSWORD_SETTINGS,
  saved: [],
};

/** A site keeps this many usernames at most; saving another drops the one used longest ago. */
const MAX_PER_ORIGIN = 20;

/** Profile ids are free text; the secret name is a hash of one. */
export const passwordSecretName = (profileId: string) =>
  `tempo-browser-passwords-${NodeCrypto.createHash("sha256").update(profileId).digest("hex").slice(0, 32)}`;

type PasswordsView = NonNullable<TempoBrowserProfileState["passwords"]>;

const toView = (profile: ProfilePasswords): PasswordsView => ({
  settings: profile.settings,
  saved: profile.saved
    .map(({ origin, username, createdAt, lastUsedAt }) => ({
      origin,
      username,
      createdAt,
      lastUsedAt,
    }))
    .toSorted((a, b) => a.origin.localeCompare(b.origin) || a.username.localeCompare(b.username)),
});

const storage = (cause: unknown) => new TempoBrowserProfileError({ reason: "storage", cause });

const sameAccount =
  (entry: { readonly origin: string; readonly username: string }) => (other: StoredPassword) =>
    other.origin === entry.origin && other.username === entry.username;

/** Saves one sign-in in place of the site's same username. */
const withSignIn = (
  saved: ReadonlyArray<StoredPassword>,
  signIn: Pick<StoredPassword, "origin" | "username" | "password">,
  at: string,
): ReadonlyArray<StoredPassword> => {
  const previous = saved.find(sameAccount(signIn));
  const others = saved.filter((entry) => !sameAccount(signIn)(entry));
  const site = others.filter((entry) => entry.origin === signIn.origin);
  const dropped =
    site.length < MAX_PER_ORIGIN
      ? undefined
      : site.toSorted((a, b) => a.lastUsedAt.localeCompare(b.lastUsedAt))[0];
  return [
    ...others.filter((entry) => entry !== dropped),
    { ...signIn, createdAt: previous?.createdAt ?? at, lastUsedAt: at },
  ];
};

/** One tab, as the server browser gives it. */
export interface PasswordTabTarget {
  readonly profileId: string;
  readonly cdp: Pick<CDPSession, "send" | "on" | "off">;
  /** Whether an agent opened or acted in the tab's current page. */
  readonly agentTouched: () => boolean;
}

export interface PasswordTab {
  /**
   * Runs before each agent action in the tab, once its page counts as the
   * agent's. Unless the profile lets agents use passwords, it empties what
   * the tab filled.
   */
  readonly beforeAgentAction: () => Promise<void>;
  /** Stops serving the tab; call when it closes. */
  readonly detach: () => void;
  /** Resolves once the tab's saves and fills in flight have finished. */
  readonly idle: () => Promise<void>;
}

export class BrowserPasswords extends Context.Service<
  BrowserPasswords,
  {
    readonly get: (profileId: string) => Effect.Effect<PasswordsView, TempoBrowserProfileError>;
    readonly setSettings: (
      input: TempoBrowserSetPasswordSettingsInput,
    ) => Effect.Effect<PasswordsView, TempoBrowserProfileError>;
    readonly remove: (input: {
      readonly profileId: string;
      readonly origin: string;
      readonly username: string;
    }) => Effect.Effect<PasswordsView, TempoBrowserProfileError>;
    /** Deletes every password and setting of a profile that is going away. */
    readonly forget: (profileId: string) => Effect.Effect<void, TempoBrowserProfileError>;
    /** Serves one tab of the profile until detached. */
    readonly attach: (target: PasswordTabTarget) => Effect.Effect<PasswordTab>;
  }
>()("t3/tempo/browser/BrowserPasswords") {}

const constVoid = () => {};

const NO_TAB: PasswordTab = {
  beforeAgentAction: async () => {},
  detach: constVoid,
  idle: async () => {},
};

const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);
  const lock = yield* Semaphore.make(1);
  const cache = new Map<string, ProfilePasswords>();

  const load = Effect.fn("BrowserPasswords.load")(function* (profileId: string) {
    const cached = cache.get(profileId);
    if (cached) return cached;
    const stored = yield* secrets.get(passwordSecretName(profileId));
    // An unreadable store fails rather than reads empty, so no save can replace it.
    const profile = Option.isNone(stored)
      ? EMPTY_PROFILE
      : yield* decodeProfile(new TextDecoder().decode(stored.value));
    cache.set(profileId, profile);
    return profile;
  }, Effect.mapError(storage));

  /** Applies a change to the stored profile; a change that returns the profile as is writes nothing. */
  const update = (profileId: string, change: (profile: ProfilePasswords) => ProfilePasswords) =>
    lock.withPermit(
      Effect.gen(function* () {
        const current = yield* load(profileId);
        const next = change(current);
        if (next === current) return current;
        const encoded = yield* encodeProfile(next).pipe(Effect.mapError(storage));
        yield* secrets
          .set(passwordSecretName(profileId), new TextEncoder().encode(encoded))
          .pipe(Effect.mapError(storage));
        cache.set(profileId, next);
        return next;
      }),
    );

  /** `named` is the username the tab last submitted on the site, if it did. */
  const save = Effect.fn("BrowserPasswords.save")(function* (
    profileId: string,
    signIn: {
      readonly origin: string;
      readonly username: string | undefined;
      readonly password: string;
    },
    named: string | undefined,
  ) {
    const at = DateTime.formatIso(yield* DateTime.now);
    yield* update(profileId, (profile) => {
      if (!profile.settings.savePasswords) return profile;
      const username =
        signIn.username ??
        usernameFor(
          signIn.password,
          named,
          profile.saved.filter((entry) => entry.origin === signIn.origin),
        );
      return { ...profile, saved: withSignIn(profile.saved, { ...signIn, username }, at) };
    });
  });

  const warn = (message: string, cause: unknown) => {
    runFork(Effect.logWarning(message, { cause }));
  };

  const serve = async ({
    profileId,
    cdp,
    agentTouched,
  }: PasswordTabTarget): Promise<PasswordTab> => {
    /** The isolated world's execution contexts on sites passwords are kept for, and their origins. */
    const origins = new Map<number, string>();
    /** Contexts the tab filled something in. */
    const filled = new Set<number>();
    /** The username the tab last submitted, for a password step or prompt after it on the site. */
    let named: { readonly origin: string; readonly username: string } | null = null;
    let detached = false;
    let scriptId: string | null = null;
    const running = new Set<Promise<void>>();

    const namedOn = (origin: string) => (named?.origin === origin ? named.username : undefined);

    const submitted = async (origin: string, fields: ReadonlyArray<FormField>) => {
      const signIn = pickSignIn(fields);
      if (signIn === null) return;
      const earlier = namedOn(origin);
      if (signIn.username !== undefined) named = { origin, username: signIn.username };
      if (signIn.password === undefined) return;
      await runPromise(
        save(profileId, { origin, username: signIn.username, password: signIn.password }, earlier),
      );
    };

    const fill = async (
      contextId: number,
      origin: string,
      request: { readonly id: number; readonly fields: ReadonlyArray<FormField> },
    ) => {
      const profile = await runPromise(load(profileId));
      const allowed = () => profile.settings.agentsMayUse || !agentTouched();
      if (!allowed()) return;
      const values = planFill(request.fields, savedFor(profile.saved, origin, namedOn(origin)));
      // Read again with nothing between it and the fill: an agent that started
      // acting meanwhile has its page already, and the fill must not land.
      if (values.length === 0 || detached || !allowed() || origins.get(contextId) !== origin)
        return;
      filled.add(contextId);
      await cdp
        .send("Runtime.evaluate", { contextId, expression: fillExpression(request.id, values) })
        .catch(constVoid);
    };

    const onBinding = (event: { name: string; payload: string; executionContextId: number }) => {
      if (event.name !== PASSWORD_BINDING || detached) return;
      // Only the isolated world has the binding; its context's origin is the browser's word.
      const origin = origins.get(event.executionContextId);
      const message = origin === undefined ? null : parsePasswordMessage(event.payload);
      if (origin === undefined || message === null) return;
      const work = (
        message.kind === "submit"
          ? submitted(origin, message.fields)
          : fill(event.executionContextId, origin, message)
      ).catch((cause: unknown) => warn("Could not save or fill a password in a tab.", cause));
      running.add(work);
      void work.finally(() => running.delete(work));
    };
    // Runtime.enable reports the contexts already open, then each new one.
    const onContextCreated = (event: { context: { id: number; name: string; origin: string } }) => {
      if (event.context.name === PASSWORD_WORLD && isPasswordOrigin(event.context.origin)) {
        origins.set(event.context.id, event.context.origin);
      }
    };
    const onContextGone = (event: { executionContextId: number }) => {
      origins.delete(event.executionContextId);
      filled.delete(event.executionContextId);
    };
    const onContextsCleared = () => {
      origins.clear();
      filled.clear();
    };

    const detach = () => {
      detached = true;
      cdp.off("Runtime.bindingCalled", onBinding);
      cdp.off("Runtime.executionContextCreated", onContextCreated);
      cdp.off("Runtime.executionContextDestroyed", onContextGone);
      cdp.off("Runtime.executionContextsCleared", onContextsCleared);
      // A desktop page outlives the connection that added the script; the
      // binding stays, since a newer connection may have added it as well.
      if (scriptId !== null) {
        void cdp
          .send("Page.removeScriptToEvaluateOnNewDocument", { identifier: scriptId })
          .catch(constVoid);
      }
    };
    cdp.on("Runtime.bindingCalled", onBinding);
    cdp.on("Runtime.executionContextCreated", onContextCreated);
    cdp.on("Runtime.executionContextDestroyed", onContextGone);
    cdp.on("Runtime.executionContextsCleared", onContextsCleared);
    try {
      // Scripts for new documents run only while this session's Page domain is on.
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Runtime.addBinding", {
        name: PASSWORD_BINDING,
        executionContextName: PASSWORD_WORLD,
      });
      ({ identifier: scriptId } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
        source: passwordPageScript(),
        worldName: PASSWORD_WORLD,
        runImmediately: true,
      }));
    } catch (cause) {
      detach();
      throw cause;
    }

    return {
      beforeAgentAction: async () => {
        if (filled.size === 0) return;
        // A store that cannot be read empties the fields all the same.
        const settings = await runPromise(load(profileId)).then(
          (profile) => profile.settings,
          () => null,
        );
        if (settings?.agentsMayUse) return;
        const contexts = [...filled];
        filled.clear();
        await Promise.all(
          contexts.map((contextId) =>
            cdp
              .send("Runtime.evaluate", { contextId, expression: CLEAR_EXPRESSION })
              .catch(constVoid),
          ),
        );
      },
      detach,
      idle: async () => {
        while (running.size > 0) await Promise.all(running);
      },
    };
  };

  const get: BrowserPasswords["Service"]["get"] = (profileId) =>
    load(profileId).pipe(Effect.map(toView));

  const setSettings: BrowserPasswords["Service"]["setSettings"] = Effect.fn(
    "BrowserPasswords.setSettings",
  )(function* ({ profileId, ...changes }) {
    const next = yield* update(profileId, (profile) => ({
      ...profile,
      settings: { ...profile.settings, ...changes },
    }));
    return toView(next);
  });

  const remove: BrowserPasswords["Service"]["remove"] = Effect.fn("BrowserPasswords.remove")(
    function* ({ profileId, ...account }) {
      const current = yield* load(profileId);
      if (!current.saved.some(sameAccount(account))) {
        return yield* new TempoBrowserProfileError({ reason: "not_found" });
      }
      const next = yield* update(profileId, (profile) => ({
        ...profile,
        saved: profile.saved.filter((entry) => !sameAccount(account)(entry)),
      }));
      return toView(next);
    },
  );

  const forget: BrowserPasswords["Service"]["forget"] = (profileId) =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* secrets.remove(passwordSecretName(profileId)).pipe(Effect.mapError(storage));
        cache.delete(profileId);
      }),
    );

  const attach: BrowserPasswords["Service"]["attach"] = (target) =>
    Effect.promise(() =>
      serve(target).catch((cause: unknown) => {
        warn("Could not set up saved passwords for a tab.", cause);
        return NO_TAB;
      }),
    );

  return BrowserPasswords.of({ get, setSettings, remove, forget, attach });
});

export const layer = Layer.effect(BrowserPasswords, make);
