/**
 * tempo: extra MCP servers agents on an environment get (Claude and Codex) beside `t3-code`: the
 * HTTP servers a person adds in settings. Header values are credentials: the server keeps them in
 * its secret store and clients only see that one is saved.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Names the server owns: the app's own orchestration server. */
export const TEMPO_RESERVED_MCP_SERVER_NAMES: ReadonlyArray<string> = ["t3-code"];

/**
 * Agents see tools as `mcp__<name>__<tool>` (Claude) or under `mcp_servers.<name>` (Codex),
 * so a name is a short slug both accept.
 */
const MCP_SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** An HTTP header field name (RFC 9110 token). */
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;

export const TempoMcpServerHeader = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** A credential: stored in the secret store, redacted for clients. */
  value: Schema.String.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
});
export type TempoMcpServerHeader = typeof TempoMcpServerHeader.Type;

/**
 * One server entry. Saving goes through `TempoMcpServerList`; the settings file
 * reads entries through `TempoSavedMcpServers`, and the server skips any saved
 * entry `tempoMcpServerProblem` rejects.
 */
export const TempoMcpServerConfig = Schema.Struct({
  /** Stable across renames; names the header secrets. */
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  url: TrimmedNonEmptyString,
  enabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
  headers: Schema.Array(TempoMcpServerHeader).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type TempoMcpServerConfig = typeof TempoMcpServerConfig.Type;

const decodeServerOption = Schema.decodeUnknownOption(TempoMcpServerConfig);
const decodesAsServer = (value: unknown): value is typeof TempoMcpServerConfig.Encoded =>
  Option.isSome(decodeServerOption(value));

/**
 * The saved list in the settings file. An entry that does not decode (a
 * hand edit missing its url, say) is dropped, so one bad entry never sends
 * the whole settings file back to defaults.
 */
export const TempoSavedMcpServers = Schema.Array(Schema.Unknown).pipe(
  Schema.decodeTo(
    Schema.Array(TempoMcpServerConfig),
    SchemaTransformation.transform({
      decode: (entries): ReadonlyArray<typeof TempoMcpServerConfig.Encoded> =>
        entries.filter(decodesAsServer),
      encode: (entries) => entries,
    }),
  ),
);

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isHttpUrl(url: URL | null): url is URL {
  return (
    url !== null && (url.protocol === "https:" || url.protocol === "http:") && url.username === ""
  );
}

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname.endsWith(".localhost") ||
  hostname === "[::1]" ||
  /^127(?:\.\d{1,3}){3}$/.test(hostname);

/** Why an entry cannot be used, as a sentence for the settings form, or null when it is fine. */
export function tempoMcpServerProblem(
  server: Pick<TempoMcpServerConfig, "name" | "url" | "headers">,
): string | null {
  if (!MCP_SERVER_NAME_PATTERN.test(server.name)) {
    return "Use letters, numbers, dashes, or underscores for the name (at most 64).";
  }
  if (TEMPO_RESERVED_MCP_SERVER_NAMES.includes(server.name.toLowerCase())) {
    return `"${server.name}" is reserved for Tempo's own servers.`;
  }
  const url = parseUrl(server.url);
  if (!isHttpUrl(url)) return "Enter an http(s) URL without a user name or password.";
  // Header values are credentials: plain http would send them in the clear.
  if (server.headers.length > 0 && url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    return "Use an https URL for a server with headers (http only on this machine).";
  }
  const seen = new Set<string>();
  for (const header of server.headers) {
    if (!HEADER_NAME_PATTERN.test(header.name)) {
      return `"${header.name}" is not a valid header name.`;
    }
    const key = header.name.toLowerCase();
    if (seen.has(key)) return `The ${header.name} header is listed twice.`;
    seen.add(key);
  }
  return null;
}

/** Saved list: every entry valid, names and ids unique (names case-insensitively). */
export const TempoMcpServerList = Schema.Array(TempoMcpServerConfig).check(
  Schema.makeFilter((servers) => {
    const issues: Array<{ readonly path: ReadonlyArray<PropertyKey>; readonly issue: string }> = [];
    const names = new Set<string>();
    const ids = new Set<string>();
    servers.forEach((server, index) => {
      const problem = tempoMcpServerProblem(server);
      if (problem !== null) issues.push({ path: [index], issue: problem });
      const name = server.name.toLowerCase();
      if (names.has(name)) {
        issues.push({ path: [index, "name"], issue: `Another server is named "${server.name}".` });
      }
      if (ids.has(server.id)) issues.push({ path: [index, "id"], issue: "Duplicate server id." });
      names.add(name);
      ids.add(server.id);
    });
    return issues;
  }),
);
