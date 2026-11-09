/**
 * tempo: the two managed providers. Every environment runs exactly two provider
 * instances, Claude (`claudeAgent`) and Codex (`codex`), on this machine's own sign in.
 * There is no personal API key and no other driver on any surface.
 */
import * as Schema from "effect/Schema";

/** The only provider instance ids, which are also their driver kinds. */
export const TEMPO_MANAGED_PROVIDER_IDS = ["claudeAgent", "codex"] as const;
export type TempoManagedProviderId = (typeof TEMPO_MANAGED_PROVIDER_IDS)[number];

export const TEMPO_MANAGED_PROVIDER_NAMES: Readonly<Record<TempoManagedProviderId, string>> = {
  claudeAgent: "Claude",
  codex: "Codex",
};

/** Whether a driver kind or instance id is one of the two managed providers. */
export const isTempoManagedProvider = (value: string): value is TempoManagedProviderId =>
  (TEMPO_MANAGED_PROVIDER_IDS as ReadonlyArray<string>).includes(value);

/** Shown wherever Claude Code reports no sign in on this Mac. */
export const TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT =
  "Claude Code is not signed in on this Mac. Run `claude auth login` in a terminal, then restart Tempo.";

/** Shown wherever Codex runs on local sign in and Codex reports no sign in. */
export const TEMPO_LOCAL_CODEX_SIGN_IN_HINT =
  "Codex is not signed in on this Mac. Run `codex login` in a terminal, then restart Tempo.";

/** Shown wherever a client asks for something Tempo manages itself. */
export const TEMPO_PROVIDERS_MANAGED_MESSAGE =
  "Tempo decides how Claude and Codex start. Both use their own sign-in on this Mac.";

/**
 * A client tried to add another provider, remove a managed one, or change how
 * Claude or Codex launch (environment, binary, home, launch arguments).
 */
export class TempoManagedProviderError extends Schema.TaggedError<TempoManagedProviderError>()(
  "TempoManagedProviderError",
  {
    instanceId: Schema.optionalKey(Schema.String),
    operation: Schema.String,
  },
) {
  override get message(): string {
    return TEMPO_PROVIDERS_MANAGED_MESSAGE;
  }
}
