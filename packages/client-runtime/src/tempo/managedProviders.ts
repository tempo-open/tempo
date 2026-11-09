import {
  TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT,
  TEMPO_LOCAL_CODEX_SIGN_IN_HINT,
  TEMPO_MANAGED_PROVIDER_IDS,
  TEMPO_MANAGED_PROVIDER_NAMES,
  type TempoManagedProviderId,
  type ServerProvider,
} from "@t3tools/contracts";

/** How a managed provider reads to a person, in one word and one line. */
export type ManagedProviderState = "checking" | "ready" | "signIn" | "attention";

export interface ManagedProviderRow {
  readonly id: TempoManagedProviderId;
  readonly name: string;
  readonly provider: ServerProvider | undefined;
  readonly state: ManagedProviderState;
  readonly detail: string;
}

const SIGN_IN_HINTS: Readonly<Record<TempoManagedProviderId, string>> = {
  claudeAgent: TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT,
  codex: TEMPO_LOCAL_CODEX_SIGN_IN_HINT,
};

function managedProviderState(provider: ServerProvider | undefined): ManagedProviderState {
  if (provider === undefined) return "checking";
  if (provider.auth.status === "unauthenticated") return "signIn";
  if (provider.status === "ready") return "ready";
  return provider.auth.status === "unknown" && provider.message === undefined
    ? "checking"
    : "attention";
}

const modelCount = (provider: ServerProvider) =>
  provider.models.length === 1 ? "1 model" : `${provider.models.length} models`;

/** The account a provider runs on, from this machine's own sign in. */
const accountInUse = ({ auth }: ServerProvider) => auth.label ?? auth.email ?? "On this Mac";

/** Claude and Codex, in that order, with what each needs from the person. */
export function managedProviderRows(
  providers: ReadonlyArray<ServerProvider>,
): Array<ManagedProviderRow> {
  return TEMPO_MANAGED_PROVIDER_IDS.map((id) => {
    const provider = providers.find((candidate) => candidate.instanceId === id);
    const state = managedProviderState(provider);
    const detail =
      provider === undefined || state === "checking"
        ? "Checking…"
        : state === "signIn"
          ? (provider.message ?? SIGN_IN_HINTS[id])
          : state === "ready"
            ? `${accountInUse(provider)} · ${modelCount(provider)}`
            : (provider.message ?? "Not available right now.");
    return { id, name: TEMPO_MANAGED_PROVIDER_NAMES[id], provider, state, detail };
  });
}
