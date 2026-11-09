/**
 * tempo: "Run new work on": each device picks where new projects, threads without a chosen
 * project, and scratch threads start. The choice lives in the device's own client settings
 * (web/desktop `ClientSettings.newWorkEnvironmentId`, mobile preferences), never on a server,
 * because a laptop and a phone may choose differently.
 */
import type { EnvironmentId } from "@t3tools/contracts";

export interface NewWorkEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** False when the person switched the saved environment off. */
  readonly enabled: boolean;
  /** Reached through T3 Connect (a relay-managed environment). */
  readonly relayManaged?: boolean;
}

export interface NewWorkEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** This client's own environment: the desktop's local server, or the server serving this page. */
  readonly isPrimary: boolean;
}

/**
 * The environments new work may start on: the primary first (when this
 * client has one), then every saved environment that is switched on, Tempo
 * Connect machines before the rest, otherwise in the order the client lists
 * them.
 */
export function newWorkEnvironmentOptions(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environments: ReadonlyArray<NewWorkEnvironmentCandidate>;
}): ReadonlyArray<NewWorkEnvironmentOption> {
  const primary = input.environments.find(
    (environment) => environment.environmentId === input.primaryEnvironmentId,
  );
  const saved = input.environments.filter(
    (environment) =>
      environment.environmentId !== input.primaryEnvironmentId && environment.enabled,
  );
  saved.sort((a, b) => Number(b.relayManaged === true) - Number(a.relayManaged === true));
  return [
    ...(primary
      ? [{ environmentId: primary.environmentId, label: primary.label, isPrimary: true }]
      : []),
    ...saved.map((environment) => ({
      environmentId: environment.environmentId,
      label: environment.label,
      isPrimary: false,
    })),
  ];
}

/**
 * Where new work starts: the device's choice while it is still offered, else
 * the primary (the local environment, when it runs), else the first saved
 * environment. Null only when there is nowhere to run.
 */
export function resolveNewWorkEnvironmentId(input: {
  readonly choice: EnvironmentId | null;
  readonly options: ReadonlyArray<Pick<NewWorkEnvironmentOption, "environmentId" | "isPrimary">>;
}): EnvironmentId | null {
  if (
    input.choice !== null &&
    input.options.some((option) => option.environmentId === input.choice)
  ) {
    return input.choice;
  }
  return (
    input.options.find((option) => option.isPrimary)?.environmentId ??
    input.options[0]?.environmentId ??
    null
  );
}

/**
 * The environment a client follows for server-kept preferences (keybindings, published themes) and
 * server-driven navigation: its own environment when it has one, else where it runs new work, so a
 * laptop without a server, or a browser, follows the host it works on rather than whichever
 * environment was saved first.
 */
export function resolveAnchorEnvironmentId(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** This device's "Run new work on" choice, if any. */
  readonly choice: EnvironmentId | null;
  /** Saved environments in the client's order, including ones switched off. */
  readonly savedEnvironments: Iterable<{
    readonly environmentId: EnvironmentId;
    readonly enabled: boolean;
  }>;
}): EnvironmentId | null {
  if (input.primaryEnvironmentId !== null) return input.primaryEnvironmentId;
  const options: Array<{ readonly environmentId: EnvironmentId; readonly isPrimary: boolean }> = [];
  for (const environment of input.savedEnvironments) {
    if (environment.enabled) {
      options.push({ environmentId: environment.environmentId, isPrimary: false });
    }
  }
  return resolveNewWorkEnvironmentId({ choice: input.choice, options });
}

/**
 * The project a new thread without a chosen project starts in: the first one
 * (in the caller's order) on the new-work environment. When that environment
 * has no projects yet, the first project anywhere, so the shortcut still works.
 */
export function pickNewWorkProject<P extends { readonly environmentId: EnvironmentId }>(
  orderedProjects: ReadonlyArray<P>,
  newWorkEnvironmentId: EnvironmentId | null,
): P | null {
  return (
    (newWorkEnvironmentId === null
      ? undefined
      : orderedProjects.find((project) => project.environmentId === newWorkEnvironmentId)) ??
    orderedProjects[0] ??
    null
  );
}

/** Lists items on the new-work environment first, keeping each side's order. */
export function orderNewWorkEnvironmentFirst<T extends { readonly environmentId: EnvironmentId }>(
  items: ReadonlyArray<T>,
  newWorkEnvironmentId: EnvironmentId | null,
): ReadonlyArray<T> {
  if (newWorkEnvironmentId === null) return items;
  const first = items.filter((item) => item.environmentId === newWorkEnvironmentId);
  if (first.length === 0 || first.length === items.length) return items;
  return [...first, ...items.filter((item) => item.environmentId !== newWorkEnvironmentId)];
}

/**
 * Environment ids with the new-work environment first and the rest in the
 * caller's order: where work a link starts without naming a machine should go.
 */
export function newWorkEnvironmentFirstIds<Id extends string>(
  newWorkEnvironmentId: Id | null,
  environmentIds: ReadonlyArray<Id>,
): ReadonlyArray<Id> {
  if (newWorkEnvironmentId === null) return environmentIds;
  return [newWorkEnvironmentId, ...environmentIds.filter((id) => id !== newWorkEnvironmentId)];
}
