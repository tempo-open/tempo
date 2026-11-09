import { useAtomValue } from "@effect/atom-react";
import {
  type TempoLocalServiceConnection,
  type TempoLocalServiceConnectionInput,
  type TempoServiceConnection,
  type TempoServiceKind,
  TempoServiceMethod,
  type TempoServiceTestResult,
  type EnvironmentId,
  tempoServiceKindLabel,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

import { APP_BASE_NAME } from "../branding";
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { searchableSetting } from "../components/settings/settingsSearch";
import { SecretInput } from "../components/settings/SecretInput";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Switch } from "../components/ui/switch";
import { Textarea } from "../components/ui/textarea";
import { useEnvironment } from "../state/environments";
import { useEnvironmentQuery } from "../state/query";
import { serverEnvironment } from "../state/server";
import { useAtomCommand } from "../state/use-atom-command";
import { tempoServicesEnvironment } from "./tempoServicesState";

const PRESETS: Readonly<
  Record<
    TempoServiceKind,
    { readonly name: string; readonly baseUrl: string; readonly hint: string }
  >
> = {
  openrouter: {
    name: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
    hint: "A management key lets agents list API keys and read credits and activity. Creating, updating, and deleting keys also needs POST, PATCH, and DELETE.",
  },
  cloudflare: {
    name: "cloudflare",
    baseUrl: "https://api.cloudflare.com/client/v4",
    hint: "An API token scoped to the zones and accounts agents may touch. Creating or updating DNS records also needs POST and PATCH.",
  },
  http: { name: "", baseUrl: "", hint: "Any HTTPS API that takes a key in a header." },
};

/** Messages a failed command shows; TempoServiceError carries the sentence for people. */
function failureMessage(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag === "Success" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  return error instanceof Error && error.message.trim() !== ""
    ? error.message
    : "The environment could not complete the request.";
}

function policySummary(connection: TempoServiceConnection): string {
  const prefixes = connection.allowedPathPrefixes;
  return [
    tempoServiceKindLabel(connection.kind),
    connection.baseUrl,
    connection.allowedMethods.join(", "),
    prefixes.length === 0 ? "all paths" : prefixes.join(", "),
  ]
    .filter((part) => part !== "")
    .join(" · ");
}

/**
 * tempo: the services agents on one environment may call, in Settings → Integrations. Connections
 * are added, tested, and removed on this environment, and their secrets never come back to the
 * client.
 */
export function ServiceConnectionsSection({
  environmentId,
  connected,
  title,
  icon,
  anchored,
}: {
  readonly environmentId: EnvironmentId;
  readonly connected: boolean;
  readonly title: string;
  readonly icon: ReactNode;
  readonly anchored: boolean;
}) {
  const query = useEnvironmentQuery(
    connected ? tempoServicesEnvironment.connections({ environmentId, input: {} }) : null,
  );
  // Saving, removing, and testing share one permission (providers:manage).
  const canManage = useAtomValue(tempoServicesEnvironment.saveLocal.permissionAtom(environmentId));
  const removeLocal = useAtomCommand(
    tempoServicesEnvironment.removeLocal,
    "remove service connection",
  );
  const [editing, setEditing] = useState<TempoLocalServiceConnection | "new" | null>(null);
  const [removeFailure, setRemoveFailure] = useState<string | null>(null);
  const snapshot = query.data;

  return (
    <SettingsSection
      title={title}
      icon={icon}
      {...(anchored ? { id: searchableSetting("integrations-services").id } : {})}
      titleAction={
        canManage && connected ? (
          <Button
            size="icon-xs"
            variant="ghost-muted"
            onClick={() => setEditing("new")}
            aria-label="Add service connection"
          >
            <PlusIcon />
          </Button>
        ) : null
      }
    >
      <SettingsRow
        title="Services for agents"
        description={
          !connected
            ? "Reconnect this environment to see its service connections."
            : snapshot === null
              ? (query.error ?? "Loading…")
              : `Agents call these through ${APP_BASE_NAME}'s service tools, which add the key; tool results never show it. Agent service access is in Settings → Browser.`
        }
      />
      {connected ? (
        <ServiceWriteApprovalRow
          environmentId={environmentId}
          canManage={canManage}
          anchored={anchored}
        />
      ) : null}
      {snapshot === null ? null : (
        <>
          {snapshot.local.map((connection) => (
            <ConnectionRow
              key={connection.id}
              environmentId={environmentId}
              connection={connection}
              canManage={canManage}
              onEdit={() => setEditing(connection)}
              onRemove={() => {
                setRemoveFailure(null);
                void removeLocal({ environmentId, input: { name: connection.name } }).then(
                  (result) => setRemoveFailure(failureMessage(result)),
                );
              }}
            />
          ))}
          {removeFailure ? (
            <p role="alert" className="pb-2 text-xs text-destructive-foreground">
              {removeFailure}
            </p>
          ) : null}
          {!canManage ? (
            <SettingsRow
              title="Local connections"
              description="This connection lacks permission to manage providers on this environment, so it cannot add or test connections."
            />
          ) : null}
        </>
      )}
      {editing === null ? null : (
        <ServiceConnectionDialog
          environmentId={environmentId}
          existing={editing === "new" ? null : editing}
          localNames={snapshot?.local.map((connection) => connection.name) ?? []}
          onClose={() => setEditing(null)}
        />
      )}
    </SettingsSection>
  );
}

const SERVICE_WRITE_APPROVAL_DESCRIPTION =
  "Agents ask you before a service write: any request but a read, and creating or changing keys and DNS records. In Full access, only mail and writes through a custom HTTP API ask. Off, every agent runs writes without asking. Reads never ask.";

/**
 * The environment's `askBeforeServiceWrites` server setting. It shares the connections'
 * permission (providers:manage), and servers from before it ask for every write and offer no
 * switch.
 */
function ServiceWriteApprovalRow({
  environmentId,
  canManage,
  anchored,
}: {
  readonly environmentId: EnvironmentId;
  readonly canManage: boolean;
  readonly anchored: boolean;
}) {
  const supported =
    useEnvironment(environmentId)?.serverConfig?.environment.capabilities
      .tempoAskBeforeServiceWrites === true;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const updateSettings = useAtomCommand(
    serverEnvironment.updateSettings,
    "update service write approvals",
  );
  const [saving, setSaving] = useState(false);
  if (!supported) return null;

  const setAsk = async (askBeforeServiceWrites: boolean) => {
    setSaving(true);
    await updateSettings({
      environmentId,
      input: { patch: { askBeforeServiceWrites } },
    }).finally(() => setSaving(false));
  };

  return (
    <SettingsRow
      {...(anchored ? { id: searchableSetting("integrations-service-writes").id } : {})}
      title="Ask before service writes"
      description={
        canManage
          ? SERVICE_WRITE_APPROVAL_DESCRIPTION
          : `${SERVICE_WRITE_APPROVAL_DESCRIPTION} This connection lacks permission to manage providers on this environment.`
      }
      control={
        <Switch
          aria-label="Ask before service writes"
          checked={settings?.askBeforeServiceWrites ?? true}
          disabled={!canManage || settings === null || saving}
          onCheckedChange={(ask) => void setAsk(ask)}
        />
      }
    />
  );
}

function ConnectionRow({
  environmentId,
  connection,
  canManage,
  onEdit,
  onRemove,
}: {
  readonly environmentId: EnvironmentId;
  readonly connection: TempoServiceConnection;
  readonly canManage: boolean;
  readonly onEdit?: () => void;
  readonly onRemove?: () => void;
}) {
  const test = useAtomCommand(tempoServicesEnvironment.test, "test service connection");
  const [testing, setTesting] = useState(false);
  const [outcome, setOutcome] = useState<TempoServiceTestResult | null>(null);

  const runTest = async () => {
    setTesting(true);
    setOutcome(null);
    const result = await test({ environmentId, input: { id: connection.id } }).finally(() =>
      setTesting(false),
    );
    setOutcome(
      result._tag === "Success"
        ? result.value
        : { ok: false, message: failureMessage(result) ?? "The test did not run." },
    );
  };

  return (
    <SettingsRow
      title={
        <span className="flex items-center gap-2">
          {connection.id}
          {connection.writable ? <Badge variant="warning">Writes</Badge> : null}
        </span>
      }
      description={connection.description || policySummary(connection)}
      {...(connection.description ? { status: policySummary(connection) } : {})}
      control={
        canManage ? (
          <div className="flex shrink-0 gap-2">
            <Button size="xs" variant="outline" disabled={testing} onClick={() => void runTest()}>
              Test
            </Button>
            {onEdit ? (
              <Button size="xs" variant="outline" onClick={onEdit}>
                Edit
              </Button>
            ) : null}
            {onRemove ? (
              <Button size="xs" variant="destructive-outline" onClick={onRemove}>
                Remove
              </Button>
            ) : null}
          </div>
        ) : null
      }
    >
      {outcome ? (
        <p
          role="status"
          className={
            outcome.ok
              ? "pb-2 text-xs text-success-foreground"
              : "pb-2 text-xs text-destructive-foreground"
          }
        >
          {outcome.message}
        </p>
      ) : null}
    </SettingsRow>
  );
}

const METHODS = TempoServiceMethod.literals;

function ServiceConnectionDialog({
  environmentId,
  existing,
  localNames,
  onClose,
}: {
  readonly environmentId: EnvironmentId;
  readonly existing: TempoLocalServiceConnection | null;
  /** Saving is an upsert by name, so a new connection must not reuse one. */
  readonly localNames: ReadonlyArray<string>;
  readonly onClose: () => void;
}) {
  const saveLocal = useAtomCommand(tempoServicesEnvironment.saveLocal, "save service connection");
  const [kind, setKind] = useState<TempoServiceKind>(existing?.kind ?? "openrouter");
  const [name, setName] = useState(existing?.name ?? PRESETS.openrouter.name);
  const [baseUrl, setBaseUrl] = useState(existing?.baseUrl ?? PRESETS.openrouter.baseUrl);
  const [authHeader, setAuthHeader] = useState(existing?.authHeader ?? "Authorization");
  const [authScheme, setAuthScheme] = useState(existing?.authScheme ?? "Bearer");
  const [secret, setSecret] = useState("");
  const [description, setDescription] = useState(existing?.description ?? "");
  const [methods, setMethods] = useState<ReadonlySet<TempoServiceMethod>>(
    new Set(existing?.allowedMethods ?? ["GET"]),
  );
  const [prefixes, setPrefixes] = useState((existing?.allowedPathPrefixes ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const choosePreset = (next: TempoServiceKind) => {
    setKind(next);
    setName(PRESETS[next].name);
    setBaseUrl(PRESETS[next].baseUrl);
    setAuthHeader("Authorization");
    setAuthScheme(next === "http" ? "" : "Bearer");
  };

  const nameTaken = existing === null && localNames.includes(name.trim());
  const canSave =
    !nameTaken &&
    name.trim() !== "" &&
    baseUrl.trim() !== "" &&
    authHeader.trim() !== "" &&
    (existing !== null || secret.trim() !== "");

  const save = async () => {
    if (!canSave) return;
    const input: TempoLocalServiceConnectionInput = {
      name: name.trim(),
      kind,
      baseUrl: baseUrl.trim(),
      authHeader: authHeader.trim(),
      authScheme: authScheme.trim(),
      description: description.trim(),
      allowedMethods: METHODS.filter((method) => methods.has(method)),
      allowedPathPrefixes: prefixes
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
      ...(secret.trim() === "" ? {} : { secret: secret.trim() }),
    };
    setBusy(true);
    setFailure(null);
    const result = await saveLocal({ environmentId, input }).finally(() => setBusy(false));
    const message = failureMessage(result);
    setFailure(message);
    if (result._tag === "Success") onClose();
  };

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogPopup className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? `Edit ${existing.id}` : "Add a service connection"}</DialogTitle>
          <DialogDescription>
            The secret is saved on this environment and kept out of clients and tool results. An
            agent with shell access on this machine could still read it from disk.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            {/* Locked while saving: a successful save closes the dialog. */}
            <fieldset disabled={busy} className="contents">
              {existing ? null : (
                <div className="grid gap-1.5">
                  <Label>Service</Label>
                  <Select
                    value={kind}
                    onValueChange={(value) => {
                      if (value === "openrouter" || value === "cloudflare" || value === "http") {
                        choosePreset(value);
                      }
                    }}
                  >
                    <SelectTrigger size="sm" aria-label="Service">
                      <SelectValue>
                        {(value: string | null) =>
                          value === "http" ? "Custom HTTP API" : tempoServiceKindLabel(kind)
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      <SelectItem value="openrouter">OpenRouter</SelectItem>
                      <SelectItem value="cloudflare">Cloudflare</SelectItem>
                      <SelectItem value="http">Custom HTTP API</SelectItem>
                    </SelectPopup>
                  </Select>
                  <p className="text-xs text-muted-foreground">{PRESETS[kind].hint}</p>
                </div>
              )}
              <Field id="tempo-service-name" label="Name">
                <Input
                  id="tempo-service-name"
                  value={name}
                  disabled={existing !== null}
                  placeholder="billing"
                  onChange={(event) => setName(event.target.value.toLowerCase())}
                />
                {nameTaken ? (
                  <p className="text-xs text-destructive-foreground">
                    local/{name.trim()} already exists. Pick another name, or edit that one.
                  </p>
                ) : null}
              </Field>
              <Field id="tempo-service-url" label="Base URL">
                <Input
                  id="tempo-service-url"
                  value={baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </Field>
              <div className="grid grid-cols-2 gap-3">
                <Field id="tempo-service-header" label="Auth header">
                  <Input
                    id="tempo-service-header"
                    value={authHeader}
                    onChange={(event) => setAuthHeader(event.target.value)}
                  />
                </Field>
                <Field id="tempo-service-scheme" label="Scheme (optional)">
                  <Input
                    id="tempo-service-scheme"
                    value={authScheme}
                    placeholder="Bearer"
                    onChange={(event) => setAuthScheme(event.target.value)}
                  />
                </Field>
              </div>
              <Field id="tempo-service-secret" label="Secret">
                <SecretInput
                  id="tempo-service-secret"
                  configured={existing !== null}
                  value={secret}
                  onChange={(event) => setSecret(event.target.value)}
                />
              </Field>
              <div className="grid gap-1.5">
                <Label>Allowed methods</Label>
                <div className="flex flex-wrap gap-3">
                  {METHODS.map((method) => (
                    <label key={method} className="flex items-center gap-1.5 text-sm">
                      <Checkbox
                        checked={methods.has(method)}
                        onCheckedChange={(checked) =>
                          setMethods((current) => {
                            const next = new Set(current);
                            if (checked) next.add(method);
                            else next.delete(method);
                            return next;
                          })
                        }
                      />
                      {method}
                    </label>
                  ))}
                </div>
                <p className="text-xs text-muted-foreground">
                  Anything but GET and HEAD is a write. Writes ask you first unless Ask before
                  service writes is off.
                </p>
              </div>
              <Field id="tempo-service-prefixes" label="Allowed path prefixes (one per line)">
                <Textarea
                  id="tempo-service-prefixes"
                  rows={3}
                  value={prefixes}
                  placeholder="Empty allows every path below the base URL"
                  onChange={(event) => setPrefixes(event.target.value)}
                />
              </Field>
              <Field id="tempo-service-description" label="Description (optional)">
                <Input
                  id="tempo-service-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              {failure ? (
                <p role="alert" className="text-xs text-destructive-foreground">
                  {failure}
                </p>
              ) : null}
            </fieldset>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave || busy}>
            Save
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}
