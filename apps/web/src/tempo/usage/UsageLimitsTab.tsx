/**
 * tempo: the tempo look's Limits tab: how much of this
 * week's Claude limit is left across every account, one row per account with a ten block bar, then
 * Codex and any other provider. A full account shows a timer and when it serves again. A row's
 * details hold each window, its pace and reset, the plan, where it is signed in, and reset credits.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  collectExternalUsageLinks,
  collectLimitAccounts,
  collectLimitNotices,
  collectLimitPools,
  formatResetsIn,
  paceOf,
  paceRemainingPercent,
  remainingPercent,
  type LimitAccount,
  type LimitPool,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";
import { TimerIcon } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

import { ProviderInstanceIcon } from "~/components/chat/ProviderInstanceIcon";
import { providerClients } from "~/components/settings/providerDriverMeta";
import { RedactedSensitiveText } from "~/components/settings/RedactedSensitiveText";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import {
  PaceIcon,
  ResetCreditDialog,
  resetCreditsSummary,
  useResetCredit,
} from "~/components/usage/UsageLimits";
import {
  ExternalUsageLinks,
  LimitNotices,
  OWNER_GROUPS,
} from "~/components/usage/UsageLimitsPooled";
import { useNowMinute } from "~/hooks/useNowMinute";
import { usePrimarySettings } from "~/hooks/useSettings";
import { environmentPresentations } from "~/state/presentation";
import { formatUpcomingTimestamp } from "~/timestampFormat";
import { devLimitsFixture } from "../limits/devLimitsFixture";
import { formatRefill } from "../limits/limitGlance.logic";
import { limitTable, type LimitRow, type LimitTable } from "../limits/limitRows";
import claudeLogoUrl from "../threadLogos/logos/claude.png";
import codexLogoUrl from "../threadLogos/logos/chatgpt.png";
import { UsageHeadline } from "./UsageCard";

function logoOf(driver: LimitPool["driver"]): string | null {
  if (driver === "claudeAgent") return claudeLogoUrl;
  if (driver === "codex") return codexLogoUrl;
  return null;
}

const OWNER_LABELS = new Map<string | null, string>([...OWNER_GROUPS, [null, "Other"]]);

/** Every environment's limits, or the dev preview's fixture on `environmentId`. */
export function useLimitsSource(environmentId: EnvironmentId | null): LimitPresentations {
  const live = useAtomValue(environmentPresentations.presentationsWithProvidersAtom);
  return devLimitsFixture(environmentId) ?? live;
}

export function UsageLimitsTab({
  presentations,
  cursorPrompt,
}: {
  readonly presentations: LimitPresentations;
  readonly cursorPrompt: ReactNode;
}) {
  // A refill time is a clock: it moves on minute boundaries, and the percentages move only when
  // the server reports new limits.
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00.000Z`);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const links = collectExternalUsageLinks(presentations);
  const claude = pools.find((pool) => pool.driver === "claudeAgent");
  const others = pools.filter((pool) => pool !== claude);
  return (
    <>
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && links.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on this Mac reports subscription limits.
        </p>
      ) : null}
      {claude ? <ClaudeLimits pool={claude} now={now} /> : null}
      {others.map((pool) => (
        <PoolLimits key={pool.driver} pool={pool} now={now} />
      ))}
      <div className="flex flex-col gap-6.5 empty:hidden">
        {cursorPrompt}
        <ExternalUsageLinks links={links} />
        <LimitNotices notices={notices} />
      </div>
    </>
  );
}

function ProviderLogo({
  driver,
  className,
}: {
  readonly driver: LimitPool["driver"];
  readonly className?: string;
}) {
  const logo = logoOf(driver);
  const label = providerClients.get(driver)?.label ?? String(driver);
  return logo ? (
    <img src={logo} alt="" draggable={false} className={className} />
  ) : (
    <ProviderInstanceIcon driverKind={driver} displayName={label} iconClassName="size-4.5" />
  );
}

function ClaudeLimits({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const table = limitTable(pool);
  const count = pool.accounts.length;
  const across = count === 1 ? "" : ` across ${count} accounts`;
  const refill =
    table.nextRefillAt === null
      ? ""
      : `; the next one refills in ${formatRefill(table.nextRefillAt - now)}`;
  return (
    <>
      {table.headline ? (
        <UsageHeadline
          mark={
            <ProviderLogo
              driver={pool.driver}
              className="size-4.5 self-center rounded-tempo-logo"
            />
          }
          figure={`${table.headline.remainingPercent}%`}
          label={`of this week's Claude limit is left${across}${refill}`}
        />
      ) : null}
      <LimitsTable table={table} now={now} />
    </>
  );
}

function PoolLimits({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const count = pool.accounts.length;
  return (
    <section aria-label={label}>
      <h2 className="mb-3 flex items-center gap-2.25 text-tempo-title font-semibold text-foreground">
        <ProviderLogo driver={pool.driver} className="size-4.5 rounded-tempo-logo" />
        {label}
        <span className="ms-auto text-tempo-note font-tempo-book text-secondary-label">
          {count === 1 ? "1 account" : `${count} accounts`}
        </span>
      </h2>
      <LimitsTable table={limitTable(pool)} now={now} />
    </section>
  );
}

function LimitsTable({ table, now }: { readonly table: LimitTable; readonly now: number }) {
  const grouped = table.groups.some((group) => group.owner !== null);
  const headline =
    table.headline?.kind === "weekly" ? "Left this week" : (table.headline?.label ?? "Left");
  return (
    <div role="table" className="mb-6.5 overflow-hidden rounded-xl bg-card ring-1 ring-border">
      <div
        role="row"
        className="grid h-10 grid-cols-[1fr_1.6fr] items-center bg-muted px-4.5 text-tempo-note font-medium text-secondary-label"
      >
        <span role="columnheader">Account</span>
        <span role="columnheader">{headline}</span>
      </div>
      {table.groups.map((group) => (
        <Fragment key={group.owner ?? "other"}>
          {grouped ? (
            <div
              role="row"
              className="border-t border-border px-4.5 pt-3 pb-1 text-tempo-caption font-medium text-secondary-label"
            >
              <span role="rowheader">{OWNER_LABELS.get(group.owner)}</span>
            </div>
          ) : null}
          {group.rows.map((row) => (
            <LimitAccountRow key={row.account.key} row={row} now={now} />
          ))}
        </Fragment>
      ))}
    </div>
  );
}

function LimitAccountRow(props: { readonly row: LimitRow; readonly now: number }) {
  const { redeem } = props.row.account;
  return redeem ? (
    <RedeemableRow redeemAt={redeem} {...props} />
  ) : (
    <RowCells redeem={null} {...props} />
  );
}

/** The confirm sits beside the details popover, which closes as the confirm opens. */
function RedeemableRow({
  redeemAt,
  ...props
}: Omit<Parameters<typeof RowCells>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <RowCells redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </>
  );
}

function RowCells({
  row,
  now,
  redeem,
}: {
  readonly row: LimitRow;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
}) {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const refill = row.refillsAt === null ? null : formatRefill(row.refillsAt - now);
  const percent = row.remainingPercent ?? 0;
  const status = row.full
    ? `full, ${refill ? `refills in ${refill}` : "refill time unknown"}`
    : row.remainingPercent === null
      ? "limit not reported"
      : `${percent}% left`;
  return (
    <div role="row" className="group/row">
      <div className="grid h-12.5 grid-cols-[1fr_1.6fr] items-center border-t border-border px-4.5 text-tempo-list">
        <span role="cell" className="flex min-w-0 items-center font-medium text-foreground">
          <AccountName account={row.account} />
        </span>
        <span role="cell" className="h-full">
          <Popover open={detailsOpen} onOpenChange={setDetailsOpen}>
            <PopoverTrigger
              openOnHover
              delay={300}
              render={
                <button
                  type="button"
                  aria-label={`${accountLabel(row.account)}: ${status}. Details`}
                  className="flex h-full cursor-default items-center gap-3.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                />
              }
            >
              <span className="w-18 text-left font-medium whitespace-nowrap text-foreground tabular-nums">
                {row.full ? (
                  <span className="inline-flex items-center gap-1">
                    <TimerIcon aria-hidden className="size-3.25 stroke-2 text-muted-foreground" />
                    {refill}
                  </span>
                ) : row.remainingPercent === null ? null : (
                  `${percent}%`
                )}
              </span>
              <LimitBlocks percent={row.full ? 0 : percent} />
            </PopoverTrigger>
            <PopoverPopup side="top" sideOffset={6}>
              <LimitDetails
                row={row}
                now={now}
                redeem={redeem}
                onRedeem={() => {
                  setDetailsOpen(false);
                  redeem?.setConfirming(true);
                }}
              />
            </PopoverPopup>
          </Popover>
        </span>
      </div>
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem && (redeem.busy || redeem.status) ? (
        <p role="status" className="px-4.5 pb-3 text-xs text-muted-foreground">
          {redeem.busy ? "Using reset credit…" : redeem.status}
        </p>
      ) : null}
    </div>
  );
}

function LimitBlocks({ percent }: { readonly percent: number }) {
  const on = Math.round(percent / 10);
  return (
    <span
      aria-hidden
      data-tempo-limit-blocks=""
      data-low={percent < 30 ? "" : undefined}
      className="flex gap-0.75"
    >
      {Array.from({ length: 10 }, (_, index) => (
        <span key={index} data-on={index < on ? "" : undefined} />
      ))}
    </span>
  );
}

function accountLabel(account: LimitAccount): string {
  return (
    account.displayName ??
    account.email ??
    providerClients.get(account.driver)?.label ??
    String(account.driver)
  );
}

function AccountName({ account }: { readonly account: LimitAccount }) {
  if (account.email && !account.displayName) {
    return (
      <RedactedSensitiveText
        value={account.email}
        ariaLabel="Toggle account email visibility"
        revealTooltip="Click to reveal email"
        hideTooltip="Click to hide email"
        className="truncate font-sans text-tempo-list text-foreground"
      />
    );
  }
  return <span className="truncate">{accountLabel(account)}</span>;
}

function DetailRow({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function LimitDetails({
  row,
  now,
  redeem,
  onRedeem,
}: {
  readonly row: LimitRow;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const { account } = row;
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="truncate text-sm font-medium text-foreground">
          {accountLabel(account)}
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit font-sans text-xs"
          />
        ) : null}
      </div>
      {account.plan || where ? (
        <div className="flex flex-col gap-1 border-t border-border pt-2.5">
          {account.plan ? <DetailRow label="Plan">{account.plan}</DetailRow> : null}
          {where ? (
            <DetailRow label={account.environments.length > 0 ? "Signed in" : "Via"}>
              {where}
            </DetailRow>
          ) : null}
        </div>
      ) : null}
      {row.windows.map(({ window, member, reset }) => {
        const resetsIn = formatResetsIn(member.window, now);
        const evenPace = paceRemainingPercent(member.window, now);
        const pace = paceOf(member.window, now);
        return (
          <div
            key={`${window.kind}:${window.id}`}
            className="flex flex-col gap-1 border-t border-border pt-2.5"
          >
            <span className="flex items-center gap-2 font-medium text-foreground">
              {window.label}
              {pace ? <PaceIcon pace={pace} /> : null}
            </span>
            <DetailRow label="Left">{remainingPercent(member.window)}%</DetailRow>
            {member.window.resetsAt ? (
              <DetailRow label="Resets">
                {formatUpcomingTimestamp(member.window.resetsAt, timestampFormat, now)}
                {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
              </DetailRow>
            ) : null}
            {evenPace !== null ? (
              <DetailRow label="Even pace">{evenPace}% left by now</DetailRow>
            ) : null}
            {reset && reset.restoresPercent > 0 ? (
              <DetailRow label="Restores">+{reset.restoresPercent}% of pool</DetailRow>
            ) : null}
          </div>
        );
      })}
      {credits && redeem ? (
        <div className="flex items-center gap-3 border-t border-border pt-2.5 text-muted-foreground">
          <span className="tabular-nums">{resetCreditsSummary(credits, now, true)}</span>
          <Button
            size="xs"
            variant="outline"
            disabled={redeem.busy || !redeem.canManageProviders}
            className="ms-auto"
            onClick={onRedeem}
          >
            {redeem.busy ? "Using…" : "Use reset"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
