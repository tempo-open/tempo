/**
 * tempo: the company service tools by what they may do, for provider adapters that
 * pre-approve or ask by tool name. Free of the toolkit's imports so every adapter package can
 * read it; the services toolkit test checks it against the tools' Readonly annotations.
 *
 * @module tempoServiceToolNames
 */

/** Only read; adapters may pre-approve these. */
export const TEMPO_SERVICE_READ_TOOL_NAMES = [
  "services_list",
  "openrouter_keys_list",
  "openrouter_credits",
  "openrouter_activity",
  "cloudflare_zones_list",
  "cloudflare_dns_records_list",
  "cloudflare_workers_list",
] as const;

/** Change something, or can: service_request is generic, so even its GETs ask. Never pre-approved. */
export const TEMPO_SERVICE_APPROVAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "service_request",
  "openrouter_key_create",
  "openrouter_key_update",
  "openrouter_key_delete",
  "cloudflare_dns_record_upsert",
]);
