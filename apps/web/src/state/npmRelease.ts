import { AsyncResult, Atom } from "effect/reactivity";

/**
 * Upstream T3 Code waits for `t3@<version>` to reach npm before offering boot-service servers an
 * update. Tempo is not on npm: every server, desktop-managed or not, installs the target
 * version from the same GitHub release that advertised it (TEMPO_RELEASE_REPOSITORY). So the release
 * has always landed by the time a version is offered, and this never asks a registry.
 */
export function isNpmReleasePublished(_version: string | null): boolean {
  return true;
}

interface NpmRelease {
  readonly version: string;
  readonly databaseMigration: number | undefined;
}

/** tempo: never finds a release, since Tempo is not on npm. Only upstream's fleet track switch
 * (UpdateTrackSwitchDialog) reads it, and Tempo does not render that dialog. */
export const npmReleaseAtom = Atom.family((spec: string) =>
  Atom.make(AsyncResult.success<NpmRelease | null>(null)).pipe(
    Atom.withLabel(`npm-release:${spec}`),
  ),
);
