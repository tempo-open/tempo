import {
  LAPTOP_BROWSER_SERVER_ID,
  type DesktopLaptopToolServerConfig,
  type DesktopLaptopToolServerStatus,
  type DesktopLaptopToolsConfig,
  type DesktopLaptopToolsState,
  type TempoLaptopPasskeyStatus,
} from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";

import { ScopedSwitch } from "~/components/settings/ScopedSwitch";
import {
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "~/components/settings/settingsLayout";
import { searchableSetting } from "~/components/settings/settingsSearch";
import {
  useScopedSettings,
  useUpdateScopedSettings,
} from "~/components/settings/useScopedSettings";
import { useSettingsScope } from "~/components/settings/SettingsScopeContext";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Switch } from "~/components/ui/switch";
import { toastManager } from "~/components/ui/toast";

import { laptopToolsBridge, useLaptopToolsState } from "./laptopToolsState";

const SERVER_DESCRIPTIONS: Readonly<Record<string, string>> = {
  "computer-use":
    "Screenshots, mouse and keyboard on this Mac, through open-computer-use (npm i -g open-computer-use).",
  [LAPTOP_BROWSER_SERVER_ID]:
    "A Chrome on this laptop that agents drive, with its own profile, so it reaches this laptop's localhost and the sites you sign in to there.",
};

/** A custom server's id from its name: lowercase, dashes, unique among `taken`. */
function laptopToolServerIdFromName(name: string, taken: ReadonlySet<string>): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 48) || "tool";
  let candidate = base;
  for (let index = 2; taken.has(candidate); index += 1) candidate = `${base}-${index}`;
  return candidate;
}

/** Arguments typed on one line; double quotes keep spaces inside one argument. */
function parseLaptopToolArguments(value: string): string[] {
  const args: string[] = [];
  for (const match of value.matchAll(/"([^"]*)"|(\S+)/gu)) args.push(match[1] ?? match[2] ?? "");
  return args;
}

/**
 * tempo: what agents may use on the person's laptop. Agent access is a server
 * setting like browser access; which tools this laptop offers is the desktop
 * app's own, and only shows in the desktop app.
 */
export function LaptopToolsSettingsSection() {
  return (
    <SettingsSection id="laptop-tools" title="Laptop tools">
      <AgentComputerUseRow />
      <AgentLaptopAccessRow />
      {laptopToolsBridge === null ? (
        <SettingsUnavailableGroup message="Laptop tools run in the desktop app on your laptop. Open it and connect it to this environment to offer them.">
          {null}
        </SettingsUnavailableGroup>
      ) : (
        <DesktopLaptopTools />
      )}
    </SettingsSection>
  );
}

function AgentLaptopAccessRow() {
  const enabled = useScopedSettings((settings) => settings.enableAgentLaptopAccess);
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      {...searchableSetting("agent-laptop-access")}
      serverScoped
      settingKeys={["enableAgentLaptopAccess"]}
      description={
        projectScope
          ? "Allow agents in this project to ask for tools on your laptop. You approve each thread on the laptop. Applies when the agent session next starts."
          : "Allow agents to ask for tools on a laptop running the desktop app, such as computer use or a browser with that laptop's logins. You approve each thread on the laptop. Projects can override it."
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentLaptopAccess"]}
          checked={enabled}
          disabled={connectedEnvironments.length === 0}
          aria-label="Agent laptop access"
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentLaptopAccess: Boolean(checked) })
          }
        />
      }
    />
  );
}

/** tempo: computer use on the environment's own machine, a sibling of laptop access. */
function AgentComputerUseRow() {
  const enabled = useScopedSettings((settings) => settings.enableAgentComputerUse);
  const updateSettings = useUpdateScopedSettings();
  const { scope, connectedEnvironments } = useSettingsScope();
  const projectScope = scope.kind === "project" || scope.kind === "checkout";
  return (
    <SettingsRow
      {...searchableSetting("agent-computer-use")}
      serverScoped
      settingKeys={["enableAgentComputerUse"]}
      description={
        projectScope
          ? "Allow agents in this project to see and use the screen, mouse and keyboard of the machine their thread runs on. Applies when the agent session next starts."
          : "Allow agents to see and use the screen, mouse and keyboard of the machine their thread runs on, through Open Computer Use. A machine with no monitor gets a virtual display. Grant Open Computer Use Screen Recording and Accessibility on that machine once. Projects can override it."
      }
      control={
        <ScopedSwitch
          settingKeys={["enableAgentComputerUse"]}
          checked={enabled}
          disabled={connectedEnvironments.length === 0}
          aria-label="Agent computer use on this machine"
          onCheckedChange={(checked) =>
            updateSettings({ enableAgentComputerUse: Boolean(checked) })
          }
        />
      }
    />
  );
}

function DesktopLaptopTools() {
  const state = useLaptopToolsState();
  if (state === null) return null;
  return <DesktopLaptopToolsFor state={state} />;
}

function DesktopLaptopToolsFor({ state }: { readonly state: DesktopLaptopToolsState }) {
  const save = (config: DesktopLaptopToolsConfig) => {
    void laptopToolsBridge?.setConfig(config).catch((error: unknown) =>
      toastManager.add({
        type: "error",
        title: "Laptop tools not saved",
        description: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  const updateServer = (id: string, change: Partial<DesktopLaptopToolServerConfig>) =>
    save({
      ...state.config,
      servers: state.config.servers.map((server) =>
        server.id === id ? { ...server, ...change } : server,
      ),
    });
  const removeServer = (id: string) =>
    save({
      ...state.config,
      servers: state.config.servers.filter((server) => server.id !== id),
    });

  return (
    <>
      {state.servers.map((status) => (
        <LaptopToolServerRow
          key={status.id}
          status={status}
          config={state.config.servers.find((server) => server.id === status.id)}
          onToggle={(enabled) => updateServer(status.id, { enabled })}
          onRemove={status.builtIn ? undefined : () => removeServer(status.id)}
        />
      ))}
      <SettingsRow
        title="Ask before an agent uses a laptop tool"
        description="On: the first time a thread's run uses a tool, this laptop asks you to allow it. Off: tools you turned on work right away. Either way, Stop in the menu bar ends a thread's use for the rest of its run."
        control={
          <Switch
            checked={state.config.askBeforeUse === true}
            aria-label="Ask before an agent uses a laptop tool"
            onCheckedChange={(checked) => save({ ...state.config, askBeforeUse: Boolean(checked) })}
          />
        }
      />
      <SettingsRow
        title="Use my own Chrome for the laptop browser"
        description="Off: the laptop browser keeps a separate profile, so agents only see sites you sign in to there. On: it attaches to the Chrome you have open, with all your logins; turn on remote debugging at chrome://inspect/#remote-debugging and Chrome asks you to allow each connection."
        control={
          <Switch
            checked={state.config.laptopBrowserUsesRealProfile}
            aria-label="Use my own Chrome for the laptop browser"
            onCheckedChange={(checked) =>
              save({ ...state.config, laptopBrowserUsesRealProfile: Boolean(checked) })
            }
          />
        }
      />
      <PasskeyRequestsRow state={state} onSave={save} />
      <AddLaptopToolServer config={state.config} onSave={save} />
      <LaptopToolGrants state={state} />
    </>
  );
}

const PASSKEY_STATUS: Readonly<Record<TempoLaptopPasskeyStatus, string>> = {
  available: "Available.",
  "awaiting-entitlement":
    "Waiting for Apple approval: this build of the desktop app cannot use your Mac's passkeys yet.",
  "unsupported-os": "Needs macOS 15 or later.",
  "not-mac": "Needs a Mac.",
  off: "Off: those tabs use their profile's saved passkeys instead.",
  failed: "macOS passkeys did not load in this build of the desktop app. Updating it may help.",
};

/** tempo passkeys: whether this Mac answers server tabs' iCloud Keychain sign-ins. */
function PasskeyRequestsRow({
  state,
  onSave,
}: {
  readonly state: DesktopLaptopToolsState;
  readonly onSave: (config: DesktopLaptopToolsConfig) => void;
}) {
  const status = state.passkeys?.status;
  if (status === undefined || status === "not-mac") return null;
  return (
    <SettingsRow
      title="Answer passkey requests"
      description="Server tabs whose browser profile takes passkeys from iCloud Keychain sign in with this Mac's passkey sheet. Your Mac asks first when an agent, or a tab nobody is driving, wants to sign in."
      status={<span className="text-xs text-muted-foreground">{PASSKEY_STATUS[status]}</span>}
      control={
        <Switch
          checked={state.config.answerPasskeys !== false}
          aria-label="Answer passkey requests"
          onCheckedChange={(checked) =>
            onSave({ ...state.config, answerPasskeys: Boolean(checked) })
          }
        />
      }
    />
  );
}

function LaptopToolServerRow({
  status,
  config,
  onToggle,
  onRemove,
}: {
  readonly status: DesktopLaptopToolServerStatus;
  readonly config: DesktopLaptopToolServerConfig | undefined;
  readonly onToggle: (enabled: boolean) => void;
  readonly onRemove: (() => void) | undefined;
}) {
  const command = config === undefined ? "" : [config.command, ...config.args].join(" ");
  const availability =
    status.invalidReason ??
    (status.resolvedCommand === null
      ? `${config?.command ?? "The command"} was not found on this laptop's PATH.`
      : !status.enabled
        ? `Found at ${status.resolvedCommand}. Turning it on starts it once to list its tools.`
        : status.listError !== undefined
          ? `${status.listError} Turn it off and on to try again.`
          : status.toolCount === null
            ? status.running
              ? "Listing its tools…"
              : "Its tools are not listed yet. Turn it off and on to list them."
            : `${status.toolCount} ${status.toolCount === 1 ? "tool" : "tools"}. ${
                status.running ? "Running." : "Starts again when an agent you allow uses it."
              }`);
  return (
    <SettingsRow
      title={status.name}
      description={SERVER_DESCRIPTIONS[status.id] ?? command}
      status={<span className="text-xs text-muted-foreground">{availability}</span>}
      control={
        <>
          {onRemove === undefined ? null : (
            <Button
              size="icon-xs"
              variant="ghost-destructive"
              aria-label={`Remove ${status.name}`}
              onClick={onRemove}
            >
              <Trash2Icon />
            </Button>
          )}
          <Switch
            checked={status.enabled}
            aria-label={status.name}
            onCheckedChange={(checked) => onToggle(Boolean(checked))}
          />
        </>
      }
    />
  );
}

function AddLaptopToolServer({
  config,
  onSave,
}: {
  readonly config: DesktopLaptopToolsConfig;
  readonly onSave: (config: DesktopLaptopToolsConfig) => void;
}) {
  const [name, setName] = useState("");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const canAdd = name.trim().length > 0 && command.trim().length > 0 && config.servers.length < 32;
  const add = () => {
    if (!canAdd) return;
    const id = laptopToolServerIdFromName(name, new Set(config.servers.map((server) => server.id)));
    onSave({
      ...config,
      servers: [
        ...config.servers,
        {
          id,
          name: name.trim().slice(0, 80),
          command: command.trim(),
          args: parseLaptopToolArguments(args),
          enabled: false,
        },
      ],
    });
    setName("");
    setCommand("");
    setArgs("");
  };
  return (
    <SettingsRow
      title="Add a laptop tool"
      description="Any MCP server that speaks stdio. It runs on this laptop without a shell: give a command on PATH or an absolute path, then its arguments. New tools start turned off."
    >
      <form
        className="mt-2 grid gap-2 sm:grid-cols-[1fr_1fr_2fr_auto]"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input size="sm" placeholder="Name" value={name} onValueChange={setName} />
        <Input
          size="sm"
          font="mono"
          placeholder="Command"
          value={command}
          onValueChange={setCommand}
        />
        <Input size="sm" font="mono" placeholder="Arguments" value={args} onValueChange={setArgs} />
        <Button size="compact" variant="outline" type="submit" disabled={!canAdd}>
          Add
        </Button>
      </form>
    </SettingsRow>
  );
}

function LaptopToolGrants({ state }: { readonly state: DesktopLaptopToolsState }) {
  return (
    <SettingsRow
      title="Allowed threads"
      description="Threads you allowed to use a laptop tool. A grant ends with the thread's run, after 30 minutes unused, or when you stop it."
      control={
        state.grants.length > 0 ? (
          <Button
            size="compact"
            variant="destructive-outline"
            onClick={() => void laptopToolsBridge?.stop({})}
          >
            Stop all
          </Button>
        ) : null
      }
    >
      {state.grants.length === 0 ? (
        <p className="mt-1 text-xs text-muted-foreground">None right now.</p>
      ) : (
        <ul className="mt-2 grid gap-1.5">
          {state.grants.map((grant) => (
            <li key={grant.key} className="flex items-center justify-between gap-3 text-xs">
              <span className="min-w-0 truncate">
                {grant.serverName} for “{grant.threadTitle}” on {grant.environmentLabel}
                {grant.inFlight > 0 ? " · in use" : null}
              </span>
              <Button
                size="compact"
                variant="outline"
                onClick={() => void laptopToolsBridge?.stop({ key: grant.key })}
              >
                Stop
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsRow>
  );
}
