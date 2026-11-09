/**
 * tempo: this device's "Run new work on" choice (`ClientSettings.newWorkEnvironmentId`) as an
 * atom, so atoms such as the anchor environment in `state/server.ts` can follow it. Client settings
 * live in `hooks/useSettings.ts`, which imports `state/server.ts`, so this module imports neither:
 * the settings store publishes each snapshot's choice here.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { Atom, type AtomRegistry } from "effect/reactivity";

export const newWorkEnvironmentChoiceAtom = Atom.make<EnvironmentId | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("tempo-new-work-environment-choice"),
);

/** Called by the client settings store with each new snapshot's choice. */
export function publishNewWorkEnvironmentChoice(
  registry: AtomRegistry.AtomRegistry,
  choice: EnvironmentId | null | undefined,
): void {
  const next = choice ?? null;
  if (registry.get(newWorkEnvironmentChoiceAtom) !== next) {
    registry.set(newWorkEnvironmentChoiceAtom, next);
  }
}
