import { useAtomValue } from "@effect/atom-react";
import type {
  BrowserProfile,
  TempoBrowserExtension,
  TempoLaptopPasskeyStatus,
  TempoPasskeyProvider,
  TempoPasskeySettings,
  TempoPasswordSettings,
  TempoSavedPasskey,
  TempoSavedPassword,
  EnvironmentId,
} from "@t3tools/contracts";
import {
  ClockIcon,
  KeyRoundIcon,
  PuzzleIcon,
  RectangleEllipsisIcon,
  RefreshCwIcon,
  Trash2Icon,
} from "lucide-react";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Switch } from "../../components/ui/switch";
import { toastManager } from "../../components/ui/toast";
import { rendersServerTabNatively } from "../../browser/previewRuntime";
import { useEnvironment } from "../../state/environments";
import { primaryEnvironmentIdAtom } from "../../state/primaryEnvironment";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { laptopToolsBridge, useLaptopToolsState } from "../laptopTools/laptopToolsState";
import { SuccessCheckIcon } from "../look/SuccessCheckIcon";
import { tempoBrowserEnvironment } from "./tempoBrowserState";
import { clearProfileExtrasRequest, useRequestedProfileExtras } from "./profileExtrasRequest";

/** How often an open dialog looks again while the extension browser downloads. */
const INSTALL_REFRESH_MS = 5_000;
const INSTALL_NOTE =
  "the environment has downloaded the browser that runs extensions (about 200 MB, first time only)";

/**
 * Settings → Browser → a profile's "Extensions, passkeys and passwords", which all live on an
 * environment's server browser. Desktop tabs keep their own passkeys and load no extensions, but
 * save and fill these passwords. Also opens for a profile the browser panel's More menu asked for.
 */
export function BrowserProfileExtrasDialog({
  profile: chosenProfile,
  profiles,
  environmentIds,
  onClose,
}: {
  readonly profile: BrowserProfile | null;
  /** The profiles a request from the browser panel can name. */
  readonly profiles: ReadonlyArray<BrowserProfile>;
  /** Environments with a server browser. */
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly onClose: () => void;
}) {
  const requested = useRequestedProfileExtras();
  const profile = chosenProfile ?? profiles.find((candidate) => candidate.id === requested) ?? null;
  const close = () => {
    clearProfileExtrasRequest();
    onClose();
  };
  const [chosen, setChosen] = useState<EnvironmentId | null>(null);
  const environmentId =
    chosen !== null && environmentIds.includes(chosen) ? chosen : (environmentIds[0] ?? null);
  // The desktop app draws its own environment's tabs with Electron, which runs neither.
  const primaryEnvironmentId = useAtomValue(primaryEnvironmentIdAtom);
  const drawnHere =
    environmentId !== null &&
    rendersServerTabNatively(environmentId, primaryEnvironmentId, { runtime: "server" });
  return (
    <Dialog open={profile !== null} onOpenChange={(open) => (open ? undefined : close())}>
      <DialogPopup className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Extensions, passkeys and passwords · {profile?.name}</DialogTitle>
          <DialogDescription>
            {drawnHere
              ? "Tabs this app draws itself load no extensions or saved passkeys; tabs this environment runs by itself do. "
              : "Extensions and saved passkeys are for server browser tabs in this profile; desktop browser tabs load neither. "}
            Saved passwords work in every tab of the profile. Removing the profile deletes all of
            them.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {environmentIds.length > 1 ? (
            <EnvironmentPicker
              environmentIds={environmentIds}
              value={environmentId}
              onChange={setChosen}
            />
          ) : null}
          {profile === null || environmentId === null ? (
            <p className="text-muted-foreground text-sm">
              Connect an environment with a server browser to manage extensions, passkeys and
              passwords.
            </p>
          ) : (
            <ProfileExtras environmentId={environmentId} profileId={profile.id} />
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

function EnvironmentPicker({
  environmentIds,
  value,
  onChange,
}: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly value: EnvironmentId | null;
  readonly onChange: (environmentId: EnvironmentId) => void;
}) {
  return (
    <div className="mb-4 flex items-center justify-between gap-3">
      <span className="text-sm">Environment</span>
      <Select value={value} onValueChange={(next) => next !== null && onChange(next)}>
        <SelectTrigger className="w-56" aria-label="Environment">
          <SelectValue />
        </SelectTrigger>
        <SelectPopup>
          {environmentIds.map((environmentId) => (
            <EnvironmentOption key={environmentId} environmentId={environmentId} />
          ))}
        </SelectPopup>
      </Select>
    </div>
  );
}

function EnvironmentOption({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const environment = useEnvironment(environmentId);
  return <SelectItem value={environmentId}>{environment?.label ?? environmentId}</SelectItem>;
}

function ProfileExtras({
  environmentId,
  profileId,
}: {
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
}) {
  const query = useEnvironmentQuery(
    tempoBrowserEnvironment.profile({ environmentId, input: { profileId } }),
  );
  // Every change here needs the same grant (settings:write).
  const canChange = useAtomValue(
    tempoBrowserEnvironment.addExtension.permissionAtom(environmentId),
  );
  const state = query.data;
  // The extension browser's download says nothing when it ends; look again now and then.
  const installing = state?.extensionBrowser === "installing";
  const { refresh } = query;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- interval timer that re-reads the profile while the extension browser downloads
  useEffect(() => {
    if (!installing) return;
    const timer = window.setInterval(refresh, INSTALL_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [installing, refresh]);
  if (!state) {
    return (
      <p className="text-muted-foreground text-sm">
        {query.error ?? "Loading this profile's extensions, passkeys and passwords…"}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-6">
      <ExtensionsSection
        environmentId={environmentId}
        profileId={profileId}
        extensions={state.extensions}
        browserInstalling={installing}
        canChange={canChange}
      />
      <PasskeysSection
        environmentId={environmentId}
        profileId={profileId}
        settings={state.passkeys.settings}
        saved={state.passkeys.saved}
        availableProviders={state.passkeys.availableProviders}
        canChange={canChange}
      />
      {/* Hosts from before saved passwords send none. */}
      {state.passwords ? (
        <PasswordsSection
          environmentId={environmentId}
          profileId={profileId}
          settings={state.passwords.settings}
          saved={state.passwords.saved}
          canChange={canChange}
        />
      ) : null}
    </div>
  );
}

function SectionTitle({ icon, children }: { readonly icon: ReactNode; readonly children: string }) {
  return (
    <h3 className="mb-2 flex items-center gap-2 font-medium text-sm">
      {icon}
      {children}
    </h3>
  );
}

function ExtensionsSection({
  environmentId,
  profileId,
  extensions,
  browserInstalling,
  canChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
  readonly extensions: ReadonlyArray<TempoBrowserExtension>;
  /** The browser that runs extensions is still downloading. */
  readonly browserInstalling: boolean;
  readonly canChange: boolean;
}) {
  const [source, setSource] = useState("");
  const [busy, setBusy] = useState<"add" | "updates" | null>(null);
  const add = useAtomCommand(tempoBrowserEnvironment.addExtension, "add extension");
  const setEnabled = useAtomCommand(
    tempoBrowserEnvironment.setExtensionEnabled,
    "change extension",
  );
  const remove = useAtomCommand(tempoBrowserEnvironment.removeExtension, "remove extension");
  const checkUpdates = useAtomCommand(
    tempoBrowserEnvironment.checkExtensionUpdates,
    "check for extension updates",
  );

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = source.trim();
    if (value === "" || busy !== null) return;
    setBusy("add");
    const result = await add({ environmentId, input: { profileId, source: value } });
    setBusy(null);
    if (result._tag === "Success") {
      setSource("");
      toastManager.add({
        type: "success",
        title: "Extension added",
        description:
          result.value.extensionBrowser === "ready"
            ? "Open server tabs in this profile reload with it."
            : `Open server tabs in this profile reload with it once ${INSTALL_NOTE}.`,
      });
    }
  };

  const runUpdates = async () => {
    setBusy("updates");
    const result = await checkUpdates({ environmentId, input: { profileId } });
    setBusy(null);
    if (result._tag === "Success") {
      const count = result.value.updated.length;
      const nameOf = (extensionId: string) =>
        result.value.profile.extensions.find((extension) => extension.id === extensionId)?.name ??
        extensionId;
      const failed = result.value.failed.map((failure) => nameOf(failure.extensionId));
      toastManager.add({
        type: failed.length === 0 ? "success" : "warning",
        title:
          count === 0
            ? failed.length === 0
              ? "Extensions are up to date"
              : "Other extensions are up to date"
            : `Updated ${count} extension${count === 1 ? "" : "s"}`,
        ...(failed.length === 0
          ? {}
          : { description: `Could not check ${failed.join(", ")}. Try again, or remove it.` }),
      });
    }
  };

  return (
    <section>
      <SectionTitle icon={<PuzzleIcon className="size-4" />}>Extensions</SectionTitle>
      {browserInstalling ? (
        <p className="mb-3 text-muted-foreground text-sm">
          Waiting until {INSTALL_NOTE}. Open server tabs in this profile then reload with its
          extensions.
        </p>
      ) : null}
      {extensions.length === 0 ? (
        <p className="mb-3 text-muted-foreground text-sm">
          No extensions yet. Password managers such as 1Password and Bitwarden bring their own
          passkeys.
        </p>
      ) : (
        <ul className="mb-3 flex flex-col divide-y divide-border/60 rounded-lg border">
          {extensions.map((extension) => (
            <li key={extension.id} className="flex items-center gap-3 px-3 py-2">
              {extension.iconDataUrl ? (
                <img src={extension.iconDataUrl} alt="" className="size-5 shrink-0" />
              ) : (
                <PuzzleIcon className="size-5 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{extension.name}</span>
                <span className="block truncate text-muted-foreground text-xs">
                  {extension.version}
                  {extension.source === "unpacked" ? ` · ${extension.folder ?? "unpacked"}` : ""}
                </span>
              </span>
              <Switch
                size="sm"
                checked={extension.enabled}
                disabled={!canChange}
                aria-label={`${extension.enabled ? "Disable" : "Enable"} ${extension.name}`}
                onCheckedChange={(enabled) =>
                  void setEnabled({
                    environmentId,
                    input: { profileId, extensionId: extension.id, enabled },
                  })
                }
              />
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                disabled={!canChange}
                aria-label={`Remove ${extension.name}`}
                onClick={() =>
                  void remove({ environmentId, input: { profileId, extensionId: extension.id } })
                }
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form className="flex gap-2" onSubmit={(event) => void submit(event)}>
        <Input
          className="flex-1"
          value={source}
          disabled={!canChange || busy !== null}
          placeholder="Chrome Web Store link, extension id, or folder on the environment"
          aria-label="Extension to add"
          onChange={(event) => setSource(event.target.value)}
        />
        <Button type="submit" disabled={!canChange || busy !== null || source.trim() === ""}>
          {busy === "add" ? "Adding…" : "Add"}
        </Button>
      </form>
      <div className="mt-2 flex items-center justify-between gap-3">
        <span className="text-muted-foreground text-xs">
          {canChange
            ? "Changes reload this profile's open server tabs."
            : "This connection can't change browser settings."}
        </span>
        <Button
          size="compact"
          variant="ghost-muted"
          disabled={!canChange || busy !== null || extensions.length === 0}
          onClick={() => void runUpdates()}
        >
          <RefreshCwIcon />
          {busy === "updates" ? "Checking…" : "Check for updates"}
        </Button>
      </div>
    </section>
  );
}

const PROVIDER_LABELS: Readonly<Record<TempoPasskeyProvider, string>> = {
  saved: "Saved in this browser",
  "icloud-keychain": "iCloud Keychain (your Mac)",
};

const ICLOUD_STATUS: Readonly<Record<TempoLaptopPasskeyStatus, string>> = {
  available:
    "iCloud Keychain: available. When you drive a tab of this profile from here, sign-ins use this Mac's passkey sheet.",
  "awaiting-entitlement":
    "iCloud Keychain: waiting for Apple approval. This build of the desktop app cannot use your Mac's passkeys yet.",
  "unsupported-os": "iCloud Keychain needs macOS 15 or later.",
  "not-mac": "iCloud Keychain needs the desktop app on a Mac.",
  off: "iCloud Keychain: turned off in this desktop app's Laptop tools settings.",
  failed:
    "iCloud Keychain: macOS passkeys did not load in this build of the desktop app. Updating it may help.",
};

/**
 * Whether the device this dialog runs on can answer this profile's passkey
 * requests. The Mac of whoever drives a tab answers its requests, so this
 * describes this device only.
 */
function ICloudKeychainStatus({ savePasskeys }: { readonly savePasskeys: boolean }) {
  const state = useLaptopToolsState();
  const status = laptopToolsBridge === null ? null : state?.passkeys?.status;
  if (status === undefined) return null;
  const fallback = savePasskeys
    ? "Until then, passkeys saved in this browser answer."
    : "Until then, passkey sign-in fails.";
  const text =
    status === null
      ? `Passkeys come from the Mac of whoever drives the tab, through the desktop app. ${savePasskeys ? "Without one, passkeys saved in this browser answer." : "Without one, passkey sign-in fails."}`
      : status === "available"
        ? ICLOUD_STATUS.available
        : `${ICLOUD_STATUS[status]} ${fallback}`;
  return (
    <p className="flex items-start gap-1.5 text-muted-foreground text-xs">
      {status === "available" ? (
        <SuccessCheckIcon
          aria-hidden
          className="mt-px size-3.5 shrink-0 text-success tempo:text-foreground"
        />
      ) : (
        <ClockIcon aria-hidden className="mt-px size-3.5 shrink-0" />
      )}
      <span>{text}</span>
    </p>
  );
}

function PasskeysSection({
  environmentId,
  profileId,
  settings,
  saved,
  availableProviders,
  canChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
  readonly settings: TempoPasskeySettings;
  readonly saved: ReadonlyArray<TempoSavedPasskey>;
  readonly availableProviders: ReadonlyArray<TempoPasskeyProvider>;
  readonly canChange: boolean;
}) {
  const setSettings = useAtomCommand(
    tempoBrowserEnvironment.setPasskeySettings,
    "change passkey settings",
  );
  const remove = useAtomCommand(tempoBrowserEnvironment.removePasskey, "delete passkey");
  const change = (patch: {
    readonly savePasskeys?: boolean;
    readonly agentsMayUse?: boolean;
    readonly provider?: TempoPasskeyProvider;
  }) => void setSettings({ environmentId, input: { profileId, ...patch } });

  return (
    <section>
      <SectionTitle icon={<KeyRoundIcon className="size-4" />}>Passkeys</SectionTitle>
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">
            Save passkeys in this browser
            {settings.provider === "icloud-keychain" ? (
              <span className="block text-muted-foreground text-xs">
                With iCloud Keychain, these answer when no Mac can, and for passkey autofill.
              </span>
            ) : null}
          </span>
          <Switch
            checked={settings.savePasskeys}
            disabled={!canChange}
            onCheckedChange={(savePasskeys) => change({ savePasskeys })}
          />
        </label>
        <div className="flex items-center justify-between gap-3">
          <span className="text-sm">Passkeys from</span>
          <Select
            value={settings.provider}
            disabled={!canChange}
            onValueChange={(provider) => provider !== null && change({ provider })}
          >
            <SelectTrigger className="w-56" aria-label="Passkeys from">
              <SelectValue>
                {(provider: TempoPasskeyProvider) => PROVIDER_LABELS[provider]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(PROVIDER_LABELS) as Array<TempoPasskeyProvider>).map((provider) => (
                <SelectItem
                  key={provider}
                  value={provider}
                  disabled={!availableProviders.includes(provider)}
                >
                  {PROVIDER_LABELS[provider]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        {settings.provider === "icloud-keychain" ? (
          <ICloudKeychainStatus savePasskeys={settings.savePasskeys} />
        ) : null}
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">
            Let agents use passkeys
            <span className="block text-muted-foreground text-xs">
              Off: passkey sign-in fails in a page an agent opened or worked in. To sign in
              yourself, close any pop-up the agent used, then reload the page.
              {settings.provider === "icloud-keychain"
                ? " On: your Mac asks you before each agent's request, naming its thread."
                : ""}{" "}
              Tabs the desktop app shows for its own environment are not covered.
            </span>
          </span>
          <Switch
            checked={settings.agentsMayUse}
            disabled={!canChange || (!settings.savePasskeys && settings.provider === "saved")}
            onCheckedChange={(agentsMayUse) => change({ agentsMayUse })}
          />
        </label>
      </div>
      {saved.length === 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          No saved passkeys. Create one on a site from a server tab in this profile.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border/60 rounded-lg border">
          {saved.map((passkey) => (
            <li key={passkey.credentialId} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{passkey.rpId}</span>
                <span className="block truncate text-muted-foreground text-xs">
                  {[
                    passkey.userName ?? passkey.userDisplayName,
                    `Created ${formatDay(passkey.createdAt)}`,
                  ]
                    .filter((part) => part !== undefined)
                    .join(" · ")}
                  {passkey.lastUsedAt === null
                    ? " · Never used"
                    : ` · Last used ${formatDay(passkey.lastUsedAt)}`}
                </span>
              </span>
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                disabled={!canChange}
                aria-label={`Delete the passkey for ${passkey.rpId}`}
                onClick={() =>
                  void remove({
                    environmentId,
                    input: { profileId, credentialId: passkey.credentialId },
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** A site as the address bar shows it: https sites by host alone. */
const siteLabel = (origin: string) =>
  origin.startsWith("https://") ? origin.slice("https://".length) : origin;

function PasswordsSection({
  environmentId,
  profileId,
  settings,
  saved,
  canChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly profileId: string;
  readonly settings: TempoPasswordSettings;
  readonly saved: ReadonlyArray<TempoSavedPassword>;
  readonly canChange: boolean;
}) {
  const setSettings = useAtomCommand(
    tempoBrowserEnvironment.setPasswordSettings,
    "change password settings",
  );
  const remove = useAtomCommand(tempoBrowserEnvironment.removePassword, "remove saved password");
  const change = (patch: { readonly savePasswords?: boolean; readonly agentsMayUse?: boolean }) =>
    void setSettings({ environmentId, input: { profileId, ...patch } });

  return (
    <section>
      <SectionTitle icon={<RectangleEllipsisIcon className="size-4" />}>Passwords</SectionTitle>
      <div className="flex flex-col gap-3">
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">
            Save passwords
            <span className="block text-muted-foreground text-xs">
              Each sign-in in this profile's tabs is saved, then filled in on the same site.
            </span>
          </span>
          <Switch
            checked={settings.savePasswords}
            disabled={!canChange}
            onCheckedChange={(savePasswords) => change({ savePasswords })}
          />
        </label>
        <label className="flex items-center justify-between gap-3">
          <span className="text-sm">
            Let agents use passwords
            <span className="block text-muted-foreground text-xs">
              Off: nothing is filled in a page an agent opened or worked in, and what was filled is
              emptied before an agent acts.
            </span>
          </span>
          <Switch
            checked={settings.agentsMayUse}
            disabled={!canChange}
            onCheckedChange={(agentsMayUse) => change({ agentsMayUse })}
          />
        </label>
      </div>
      {saved.length === 0 ? (
        <p className="mt-3 text-muted-foreground text-sm">
          No saved passwords. Sign in to a site in a tab of this profile to save one.
        </p>
      ) : (
        <ul className="mt-3 flex flex-col divide-y divide-border/60 rounded-lg border">
          {saved.map((entry) => (
            <li
              key={JSON.stringify([entry.origin, entry.username])}
              className="flex items-center gap-3 px-3 py-2"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{siteLabel(entry.origin)}</span>
                <span className="block truncate text-muted-foreground text-xs">
                  {[
                    entry.username === "" ? "No username" : entry.username,
                    `Saved ${formatDay(entry.createdAt)}`,
                    `Last used ${formatDay(entry.lastUsedAt)}`,
                  ].join(" · ")}
                </span>
              </span>
              <Button
                size="icon-xs"
                variant="ghost-destructive"
                disabled={!canChange}
                aria-label={`Remove the saved password for ${
                  entry.username === ""
                    ? siteLabel(entry.origin)
                    : `${entry.username} on ${siteLabel(entry.origin)}`
                }`}
                onClick={() =>
                  void remove({
                    environmentId,
                    input: { profileId, origin: entry.origin, username: entry.username },
                  })
                }
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const formatDay = (iso: string) => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString();
};
