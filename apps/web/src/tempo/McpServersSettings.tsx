import { useAtomValue } from "@effect/atom-react";
import {
  TEMPO_RESERVED_MCP_SERVER_NAMES,
  type TempoMcpServerConfig,
  type EnvironmentId,
  tempoMcpServerProblem,
} from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { SecretInput } from "../components/settings/SecretInput";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Switch } from "../components/ui/switch";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";

interface HeaderDraft {
  /** Only identifies the row while editing. */
  readonly key: string;
  readonly name: string;
  /** A saved value arrives as the server's redaction marker and is sent back as-is to keep it. */
  readonly value: string;
  readonly saved: boolean;
}

interface ServerDraft {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly headers: ReadonlyArray<HeaderDraft>;
}

// Plain-HTTP remote pages are not secure contexts, so `crypto.randomUUID` may be missing.
const newServerId = () =>
  `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

const toDraft = (server: TempoMcpServerConfig): ServerDraft => ({
  id: server.id,
  name: server.name,
  url: server.url,
  enabled: server.enabled,
  headers: server.headers.map((header, index) => ({
    // Deterministic, so saved rows keep their identity across renders.
    key: `saved-${index}-${header.name}`,
    name: header.name,
    value: header.value,
    saved: header.value !== "",
  })),
});

const toConfig = (server: ServerDraft): TempoMcpServerConfig => ({
  id: server.id,
  name: server.name.trim(),
  url: server.url.trim(),
  enabled: server.enabled,
  headers: server.headers.map((header) => ({ name: header.name.trim(), value: header.value })),
});

/** The first problem in the list, as a sentence, or null when it can be saved. */
function mcpServerListProblem(servers: ReadonlyArray<ServerDraft>): string | null {
  const names = new Set<string>();
  for (const server of servers) {
    const config = toConfig(server);
    const problem = tempoMcpServerProblem(config);
    if (problem !== null) return `${config.name || "New server"}: ${problem}`;
    const key = config.name.toLowerCase();
    if (names.has(key)) return `Another server is named "${config.name}".`;
    names.add(key);
  }
  return null;
}

/**
 * tempo: the MCP servers Claude and Codex agents on one environment get: HTTP servers whose header
 * values (tokens) stay in the environment's secret store.
 */
export function McpServersSection({
  environmentId,
  titleSuffix,
  icon,
  canManage,
  anchored,
}: {
  readonly environmentId: EnvironmentId;
  readonly titleSuffix: string;
  readonly icon: ReactNode;
  readonly canManage: boolean;
  readonly anchored: boolean;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const saved = settings?.mcpServers;
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save MCP servers",
    reportFailure: false,
  });
  const [draft, setDraft] = useState<ReadonlyArray<ServerDraft> | null>(null);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const servers = draft ?? (saved ?? []).map(toDraft);
  const problem = draft === null ? null : mcpServerListProblem(draft);

  const edit = (index: number, change: (server: ServerDraft) => ServerDraft) =>
    setDraft(servers.map((server, i) => (i === index ? change(server) : server)));

  const save = async () => {
    if (draft === null || problem !== null) return;
    setSaving(true);
    setFailure(null);
    const result = await updateSettings({
      environmentId,
      input: { patch: { mcpServers: draft.map(toConfig) } },
    }).finally(() => setSaving(false));
    if (result._tag === "Success") {
      setDraft(null);
    } else if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      setFailure(
        error instanceof Error && error.message.trim() !== ""
          ? error.message
          : "The environment could not save its MCP servers.",
      );
    }
  };

  return (
    <SettingsSection
      title={`MCP servers${titleSuffix}`}
      icon={icon}
      {...(anchored ? { id: searchableSetting("integrations-mcp-servers").id } : {})}
      headerAction={
        <Button
          size="xs"
          variant="ghost"
          disabled={!canManage || settings === null || saving}
          onClick={() =>
            setDraft([
              ...servers,
              { id: newServerId(), name: "", url: "", enabled: true, headers: [] },
            ])
          }
        >
          <PlusIcon />
          Add server
        </Button>
      }
    >
      {servers.length === 0 ? (
        <SettingsRow
          title="No MCP servers"
          description="Add an HTTP MCP server, and Claude and Codex agents on this environment get its tools."
        />
      ) : null}
      {servers.map((server, index) => (
        <SettingsRow
          key={server.id}
          title={server.name.trim() || "New server"}
          description="Claude and Codex agents get this server's tools and ask before calling them only when their thread's mode asks. Header values are kept in this environment's secret store."
          control={
            <div className="flex items-center gap-2">
              <Switch
                aria-label={`Enable ${server.name || "server"}`}
                checked={server.enabled}
                disabled={!canManage || saving}
                onCheckedChange={(enabled) => edit(index, (current) => ({ ...current, enabled }))}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${server.name || "server"}`}
                disabled={!canManage || saving}
                onClick={() => setDraft(servers.filter((_, i) => i !== index))}
              >
                <Trash2Icon />
              </Button>
            </div>
          }
        >
          <fieldset disabled={!canManage || saving} className="grid gap-2 pb-2">
            <div className="grid gap-2 sm:grid-cols-[12rem_1fr]">
              <Input
                size="sm"
                aria-label="Name"
                placeholder={`Name, e.g. linear (not ${TEMPO_RESERVED_MCP_SERVER_NAMES.join(" or ")})`}
                value={server.name}
                spellCheck={false}
                onChange={(event) =>
                  edit(index, (current) => ({ ...current, name: event.target.value }))
                }
              />
              <Input
                size="sm"
                aria-label="URL"
                placeholder="https://example.com/mcp"
                value={server.url}
                spellCheck={false}
                onChange={(event) =>
                  edit(index, (current) => ({ ...current, url: event.target.value }))
                }
              />
            </div>
            {server.headers.map((header, headerIndex) => (
              <div key={header.key} className="grid gap-2 sm:grid-cols-[12rem_1fr_auto]">
                <Input
                  size="sm"
                  aria-label="Header name"
                  placeholder="Authorization"
                  value={header.name}
                  readOnly={header.saved}
                  spellCheck={false}
                  onChange={(event) =>
                    edit(index, (current) => ({
                      ...current,
                      headers: current.headers.map((h, i) =>
                        i === headerIndex ? { ...h, name: event.target.value } : h,
                      ),
                    }))
                  }
                />
                <SecretInput
                  size="sm"
                  aria-label={`${header.name || "Header"} value`}
                  configured={header.saved}
                  value={header.saved ? "" : header.value}
                  onChange={(event) =>
                    edit(index, (current) => ({
                      ...current,
                      headers: current.headers.map((h, i) =>
                        i === headerIndex ? { ...h, value: event.target.value, saved: false } : h,
                      ),
                    }))
                  }
                />
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`Remove ${header.name || "header"}`}
                  onClick={() =>
                    edit(index, (current) => ({
                      ...current,
                      headers: current.headers.filter((_, i) => i !== headerIndex),
                    }))
                  }
                >
                  <Trash2Icon />
                </Button>
              </div>
            ))}
            <div>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  edit(index, (current) => ({
                    ...current,
                    headers: [
                      ...current.headers,
                      { key: newServerId(), name: "", value: "", saved: false },
                    ],
                  }))
                }
              >
                <PlusIcon />
                Add header
              </Button>
            </div>
          </fieldset>
        </SettingsRow>
      ))}
      {draft !== null ? (
        <SettingsRow
          title="Unsaved changes"
          description={
            problem ??
            failure ??
            "Claude agents get the change on their next turn; Codex agents when their session next starts."
          }
          control={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setFailure(null);
                }}
              >
                Discard
              </Button>
              <Button size="sm" disabled={saving || problem !== null} onClick={() => void save()}>
                Save
              </Button>
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
