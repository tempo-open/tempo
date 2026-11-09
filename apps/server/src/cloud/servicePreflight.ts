import { TEMPO_CLI_NAME, TEMPO_RELEASE_REPOSITORY } from "@t3tools/shared/tempoBrand";

/** Where the installer lives: the build's repository, or a checkout of the same source. */
const INSTALL_SOURCE =
  TEMPO_RELEASE_REPOSITORY === "" ? "the source this build came from" : TEMPO_RELEASE_REPOSITORY;
import packageJson from "../../package.json" with { type: "json" };
import { BUILD_MIGRATION_HEAD, recordedMigrations } from "../persistence/databaseMigrationHead.ts";
import { SERVICE_LAUNCHER_PROTOCOL } from "./serviceProtocol.ts";

export type ServicePreflightResult =
  | {
      readonly status: "ready";
      readonly version: string;
      readonly launcherProtocol: typeof SERVICE_LAUNCHER_PROTOCOL;
    }
  | {
      readonly status: "blocked";
      readonly version: string;
      readonly reason: string;
    };

export function runServicePreflight(input: {
  readonly databasePath: string;
  readonly launcherProtocol: number;
  readonly version?: string;
}): ServicePreflightResult {
  const version = input.version ?? packageJson.version;
  if (input.launcherProtocol !== SERVICE_LAUNCHER_PROTOCOL) {
    return {
      status: "blocked",
      version,
      // A stale CLI earlier on PATH makes `service install` reinstall itself and report
      // success, so name the exact install and the path check.
      // tempo: Tempo's installer is scripts/install.sh in its own source; T3's site never serves it.
      reason: [
        `The installed service launcher speaks protocol ${input.launcherProtocol}, but ${TEMPO_CLI_NAME}@${version} requires protocol ${SERVICE_LAUNCHER_PROTOCOL}.`,
        `On the server machine, install this exact CLI: \`T3CODE_VERSION=${version} sh scripts/install.sh\` from a checkout of ${INSTALL_SOURCE}.`,
        `Check that \`${TEMPO_CLI_NAME} --version\` prints ${version} and that \`which -a ${TEMPO_CLI_NAME}\` lists no older ${TEMPO_CLI_NAME} first, then run \`~/.local/bin/${TEMPO_CLI_NAME} service install\` (the installer's default path).`,
        `Updating the desktop app does not update this CLI, and \`${TEMPO_CLI_NAME} service update\` only repairs the service with whichever CLI runs it.`,
      ].join(" "),
    };
  }

  const newer = newerRecordedMigrations(input.databasePath);
  if (newer === null) {
    return {
      status: "blocked",
      version,
      reason: `Could not read this database to confirm t3@${version} supports it.`,
    };
  }
  if (newer.length > 0) {
    return {
      status: "blocked",
      version,
      reason: `This database has migrations that t3@${version} does not know: ${newer.join(", ")}. A newer build wrote them, and running t3@${version} on this database is not safe. Stay on the newer release, or wait for a release that includes these migrations.`,
    };
  }

  return { status: "ready", version, launcherProtocol: SERVICE_LAUNCHER_PROTOCOL };
}

/** Migrations a newer build recorded, or null when the database exists but cannot be read.
 * Startup already handles renamed ids this build knows. */
function newerRecordedMigrations(databasePath: string): ReadonlyArray<string> | null {
  const recorded = recordedMigrations(databasePath);
  return recorded === null
    ? null
    : recorded.filter(({ id }) => id > BUILD_MIGRATION_HEAD).map(({ id, name }) => `${id}_${name}`);
}

export function decodeServicePreflightResult(value: unknown): ServicePreflightResult | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    record.status === "ready" &&
    record.launcherProtocol === SERVICE_LAUNCHER_PROTOCOL &&
    typeof record.version === "string"
  ) {
    return {
      status: "ready",
      version: record.version,
      launcherProtocol: SERVICE_LAUNCHER_PROTOCOL,
    };
  }
  if (
    record.status === "blocked" &&
    typeof record.version === "string" &&
    typeof record.reason === "string"
  ) {
    return { status: "blocked", version: record.version, reason: record.reason };
  }
  return undefined;
}
