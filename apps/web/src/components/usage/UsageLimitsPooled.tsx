import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  formatResetsIn,
  type LimitAccount,
  type LimitPool,
  type LimitPoolMember,
  type LimitPoolWindow,
  paceRemainingPercent,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import type { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import { AlertTriangleIcon, ExternalLinkIcon, TicketIcon } from "lucide-react";
import {
  createContext,
  Fragment,
  type ReactNode,
  type RefObject,
  use,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Popover, PopoverCreateHandle, PopoverPopup, PopoverTrigger } from "../ui/popover";
import {
  PaceIcon,
  ResetCreditDialog,
  barColor,
  resetCreditsSummary,
  useResetCredit,
} from "./UsageLimits";

function accountInitials(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  return `${local[0] ?? ""}${domain[0] ?? ""}`.toUpperCase() || "?";
}

function accountHue(email: string): number {
  let hash = 0;
  for (let index = 0; index < email.length; index += 1) {
    hash = (hash * 31 + email.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) % 360;
}

function AccountChip({ email }: { readonly email: string }) {
  const hue = accountHue(email);
  return (
    <span
      role="img"
      aria-label={`Account ${accountInitials(email)}`}
      className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-3xs leading-none font-semibold"
      style={{ backgroundColor: `oklch(0.85 0.08 ${hue})`, color: `oklch(0.35 0.1 ${hue})` }}
    >
      {accountInitials(email)}
    </span>
  );
}

function AccountAvatar({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.redeem) {
    return (
      <ProviderInstanceIcon
        driverKind={account.driver}
        displayName={
          account.displayName ??
          providerClients.get(account.driver)?.label ??
          String(account.driver)
        }
        accentColor={account.accentColor}
        showBadge={Boolean(account.displayName)}
        indicatorBackground="var(--popover)"
        className={cn("size-5", className)}
        iconClassName="size-4 text-foreground/80"
      />
    );
  }
  return account.email ? <AccountChip email={account.email} /> : null;
}

function AccountName({
  account,
  className,
}: {
  readonly account: LimitAccount;
  readonly className?: string;
}) {
  if (account.displayName) return <span className={className}>{account.displayName}</span>;
  if (account.email) {
    return (
      <span className={cn("inline-flex min-w-0 items-center", className)}>
        <AccountChip email={account.email} />
      </span>
    );
  }
  return (
    <span className={className}>
      {providerClients.get(account.driver)?.label ?? String(account.driver)}
    </span>
  );
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function SegmentPopover({
  account,
  window,
  reset,
  now,
  redeem,
  onRedeem,
}: {
  readonly account: LimitAccount;
  readonly window: LimitPoolMember["window"];
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
  readonly now: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly onRedeem: () => void;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const timeLeft = paceRemainingPercent(window, now);
  const resetsIn = formatResetsIn(window, now);
  const where =
    account.environments.length > 0
      ? account.environments.map((environment) => environment.label).join(", ")
      : account.sourceLabel;
  const credits =
    redeem && account.limits.resetCredits?.availableCount ? account.limits.resetCredits : null;
  return (
    <div className="flex w-72 max-w-[calc(100vw-3rem)] flex-col gap-2.5 text-xs">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-medium text-foreground">
          <AccountAvatar account={account} />
          <span className="truncate">
            {account.displayName ?? providerClients.get(account.driver)?.label ?? account.driver}
          </span>
        </span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="w-fit"
          />
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        {account.plan ? <Row label="Plan">{account.plan}</Row> : null}
        {where ? (
          <Row label={account.environments.length > 0 ? "Signed in" : "Via"}>{where}</Row>
        ) : null}
      </div>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2.5">
        <Row label="Left">{remaining}%</Row>
        {window.resetsAt ? (
          <Row label="Resets">
            {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            {resetsIn ? ` · ${resetsIn.replace("resets in ", "in ")}` : ""}
          </Row>
        ) : null}
        {timeLeft !== null ? <Row label="Even pace">{timeLeft}% left by now</Row> : null}
        {reset && reset.restoresPercent > 0 ? (
          <Row label="Restores">+{reset.restoresPercent}% of pool</Row>
        ) : null}
      </div>
      {credits && redeem ? (
        <div className="border-t border-border/60 pt-2.5 text-muted-foreground">
          <span className="flex items-center gap-3">
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
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Every segment on the page shares one popover, so hovering or clicking another
 * segment moves it instead of opening a second one. The payload is the segment
 * it currently describes.
 */
type SegmentPayload = Omit<Parameters<typeof SegmentPopover>[0], "now" | "onRedeem">;
const SegmentPopoverContext = createContext<ReturnType<
  typeof PopoverCreateHandle<SegmentPayload>
> | null>(null);

function ActiveSegmentPopover({
  handle,
  actions,
  payload,
  pools,
  now,
}: {
  readonly handle: ReturnType<typeof PopoverCreateHandle<SegmentPayload>>;
  readonly actions: RefObject<PopoverPrimitive.Root.Actions | null>;
  readonly payload: SegmentPayload;
  readonly pools: readonly LimitPool[];
  readonly now: number;
}) {
  const available = pools.some((pool) =>
    displayLimitWindows(pool).some((window) =>
      window.members.some(
        (member) =>
          member.account.key === payload.account.key &&
          member.window.id === payload.window.id &&
          member.window.kind === payload.window.kind &&
          Boolean(member.account.redeem) === Boolean(payload.redeem),
      ),
    ),
  );
  // The trigger is gone, so the popup has nothing to anchor to: an exit transition would
  // slide it to the viewport origin. Unmount it outright, which also clears Base UI's
  // active-trigger bookkeeping so the segment can open again when it comes back.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- closes the popover handle and unmounts the Base UI popup before paint when its trigger is gone
  useLayoutEffect(() => {
    if (available) return;
    handle.close();
    actions.current?.unmount();
  }, [available, handle, actions]);
  return (
    <PopoverPopup side="top" sideOffset={6}>
      <SegmentPopover
        {...payload}
        now={now}
        onRedeem={() => {
          handle.close();
          payload.redeem?.setConfirming(true);
        }}
      />
    </PopoverPopup>
  );
}

// tempo: one heat grid per provider instead of one bar per window, so a dozen or more accounts stay
// readable. Rows group by whose allowance each account is when the source says (the hub).
export const OWNER_GROUPS = [
  ["mine", "Yours"],
  ["shared", "Shared"],
  ["borrowed", "Borrowed"],
] as const;

type GridCell = LimitPoolMember & {
  readonly reset: LimitPoolWindow["resets"][number] | undefined;
};

interface GridRow {
  readonly account: LimitAccount;
  readonly cells: ReadonlyArray<GridCell | null>;
  /** The spent window that resets last, when the account serves again; null while it serves. */
  readonly blocking: LimitPoolMember["window"] | null;
}

function resetTime(window: LimitPoolMember["window"]): number {
  const at = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY;
}

function gridRows(pool: LimitPool, windows: readonly LimitPoolWindow[]): readonly GridRow[] {
  return pool.accounts.map((account) => {
    const cells = windows.map((window): GridCell | null => {
      const member = window.members.find((candidate) => candidate.account.key === account.key);
      if (!member) return null;
      const reset = window.resets.find((candidate) => candidate.member.account.key === account.key);
      return { ...member, reset };
    });
    const blocking = cells.reduce<GridRow["blocking"]>(
      (latest, cell) =>
        cell &&
        remainingPercent(cell.window) === 0 &&
        (!latest || resetTime(cell.window) > resetTime(latest))
          ? cell.window
          : latest,
      null,
    );
    return { account, cells, blocking };
  });
}

function groupRows(rows: readonly GridRow[]) {
  const backAt = (row: GridRow) => (row.blocking ? resetTime(row.blocking) : 0);
  // Serving accounts first, then the soonest back; ties keep the pool's order.
  const sorted = [...rows].sort((left, right) => {
    const [a, b] = [backAt(left), backAt(right)];
    return a === b ? 0 : a < b ? -1 : 1;
  });
  if (!sorted.some((row) => row.account.owner)) return [{ label: null, rows: sorted }];
  return [
    ...OWNER_GROUPS.map(([owner, label]) => ({
      label,
      rows: sorted.filter((row) => row.account.owner === owner),
    })),
    // No source vouches for these, such as an account signed in only on an environment.
    { label: "Other", rows: sorted.filter((row) => !row.account.owner) },
  ].filter((group) => group.rows.length > 0);
}

// At most 35%, like the old bars: Codex's colour is near the text colour, so more hides the number.
function heatStyle(color: string, remaining: number) {
  return remaining === 0
    ? undefined
    : { backgroundColor: `color-mix(in oklab, ${color} ${10 + remaining * 0.25}%, transparent)` };
}

function accountLabel(account: LimitAccount): string {
  return (
    account.displayName ?? (account.email ? accountInitials(account.email) : String(account.driver))
  );
}

function HeatCell({
  account,
  cell,
  redeem,
  color,
  now,
}: {
  readonly account: LimitAccount;
  readonly cell: GridCell | null;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly color: string;
  readonly now: number;
}) {
  const popover = use(SegmentPopoverContext) ?? undefined;
  if (!cell) {
    return (
      <span className="flex h-6 items-center justify-center text-xs text-muted-foreground">
        <span aria-hidden>–</span>
        <span className="sr-only">Not reported</span>
      </span>
    );
  }
  const { window, reset } = cell;
  const remaining = remainingPercent(window);
  const resetsIn = formatResetsIn(window, now);
  const timeLeft = paceRemainingPercent(window, now);
  return (
    <PopoverTrigger
      handle={popover}
      payload={{ account, window, reset, redeem }}
      openOnHover
      render={
        <button
          type="button"
          aria-label={`${accountLabel(account)}, ${window.label}: ${remaining}% left${resetsIn ? `, ${resetsIn}` : ""}${timeLeft === null ? "" : `, ${timeLeft}% of the window left`}`}
          className={cn(
            "h-6 min-w-0 cursor-pointer rounded-md text-xs tabular-nums outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-[popup-open]:ring-1 data-[popup-open]:ring-inset data-[popup-open]:ring-border",
            remaining === 0 ? "bg-muted text-muted-foreground" : "font-medium text-foreground",
          )}
          style={heatStyle(color, remaining)}
        />
      }
    >
      {remaining}%
    </PopoverTrigger>
  );
}

function BackIn({ row, now }: { readonly row: GridRow; readonly now: number }) {
  if (!row.blocking) {
    return <span className="text-xs font-medium text-success-foreground">now</span>;
  }
  const resetsIn = formatResetsIn(row.blocking, now);
  return (
    <span className="truncate text-xs text-muted-foreground tabular-nums">
      {resetsIn ? (
        resetsIn.replace(/^resets in /, "")
      ) : (
        <>
          <span aria-hidden>–</span>
          <span className="sr-only">Unknown</span>
        </>
      )}
    </span>
  );
}

function WeeklyReset({ cell, now }: { readonly cell: GridCell | null; readonly now: number }) {
  const resetsIn = cell ? formatResetsIn(cell.window, now) : null;
  return (
    <span className="truncate text-xs text-muted-foreground tabular-nums">
      {resetsIn ? (
        resetsIn.replace(/^resets in /i, "")
      ) : (
        <>
          <span aria-hidden>–</span>
          <span className="sr-only">Unknown</span>
        </>
      )}
    </span>
  );
}

function HeatRow(props: {
  readonly row: GridRow;
  readonly windows: readonly LimitPoolWindow[];
  readonly weeklyIndex: number;
  readonly color: string;
  readonly now: number;
}) {
  const { redeem } = props.row.account;
  return redeem ? (
    <RedeemableHeatRow redeemAt={redeem} {...props} />
  ) : (
    <HeatRowCells redeem={null} {...props} />
  );
}

/**
 * The confirm is a sibling of the popover, not a child: dialogs stack under
 * popovers, and the popover closes as the confirm opens.
 */
function RedeemableHeatRow({
  redeemAt,
  ...props
}: Omit<Parameters<typeof HeatRowCells>[0], "redeem"> & {
  readonly redeemAt: NonNullable<LimitAccount["redeem"]>;
}) {
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  return (
    <>
      <HeatRowCells redeem={redeem} {...props} />
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
      {/* The popover closed before the confirm, so progress and the outcome need a home outside it. */}
      {redeem.busy || redeem.status ? (
        <span role="status" className="col-span-full text-xs text-muted-foreground">
          <AccountName account={props.row.account} className="font-medium text-foreground" />{" "}
          {redeem.busy ? "Using reset credit…" : redeem.status}
        </span>
      ) : null}
    </>
  );
}

function HeatRowCells({
  row,
  windows,
  weeklyIndex,
  redeem,
  color,
  now,
}: {
  readonly row: GridRow;
  readonly windows: readonly LimitPoolWindow[];
  readonly weeklyIndex: number;
  readonly redeem: ReturnType<typeof useResetCredit> | null;
  readonly color: string;
  readonly now: number;
}) {
  const { account } = row;
  const credits = account.limits.resetCredits?.availableCount ?? 0;
  return (
    <>
      <span className="flex min-w-0 items-center gap-1.5">
        <AccountAvatar account={account} />
        {account.email && !account.displayName ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
            className="truncate"
          />
        ) : (
          <AccountName account={account} className="min-w-0 truncate text-xs text-foreground" />
        )}
        {credits ? (
          <span className="inline-flex shrink-0 items-center gap-0.5 text-2xs font-semibold text-foreground tabular-nums">
            <TicketIcon className="size-3" aria-hidden />
            {credits}
            <span className="sr-only"> reset {credits === 1 ? "credit" : "credits"} banked</span>
          </span>
        ) : null}
      </span>
      {windows.map((window, index) => (
        <HeatCell
          key={`${window.kind}:${window.id}`}
          account={account}
          cell={row.cells[index] ?? null}
          redeem={redeem}
          color={color}
          now={now}
        />
      ))}
      <BackIn row={row} now={now} />
      {weeklyIndex >= 0 ? <WeeklyReset cell={row.cells[weeklyIndex] ?? null} now={now} /> : null}
    </>
  );
}

function windowLabel(driver: LimitPool["driver"], window: LimitPoolWindow) {
  const details = driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined;
  return { label: details?.label ?? window.label, description: details?.description };
}

function PoolSummary({
  driver,
  windows,
}: {
  readonly driver: LimitPool["driver"];
  readonly windows: readonly LimitPoolWindow[];
}) {
  return (
    <div className="flex flex-col gap-1">
      {windows.map((window) => {
        const { label, description } = windowLabel(driver, window);
        const nextRefill = window.resets.find((reset) => reset.restoresPercent > 0);
        return (
          <div
            key={`${window.kind}:${window.id}`}
            className="flex flex-wrap items-baseline gap-x-2 text-sm"
          >
            <span className="w-28 shrink-0 text-muted-foreground">{label}</span>
            <span className="text-lg font-semibold text-foreground tabular-nums">
              {window.remainingPercent}%
            </span>
            <span className="inline-flex items-center gap-2 text-muted-foreground">
              left
              {window.pace ? <PaceIcon pace={window.pace} /> : null}
            </span>
            {nextRefill && window.columns.length > 1 ? (
              <span className="text-xs font-medium text-foreground tabular-nums">
                ↻ +{nextRefill.restoresPercent}%
              </span>
            ) : null}
            {description ? (
              <span className="text-xs text-muted-foreground">{description}</span>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function HeatGrid({
  pool,
  windows,
  color,
  now,
}: {
  readonly pool: LimitPool;
  readonly windows: readonly LimitPoolWindow[];
  readonly color: string;
  readonly now: number;
}) {
  const groups = groupRows(gridRows(pool, windows));
  // tempo: Back in only counts down spent windows, so the weekly reset gets its own column.
  const weeklyIndex = windows.findIndex((window) => window.kind === "weekly");
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div
        className="grid items-center gap-x-1.5 gap-y-1 overflow-x-auto"
        style={{
          gridTemplateColumns: `minmax(9rem, 1.6fr) repeat(${windows.length}, minmax(3.25rem, 1fr)) minmax(4.5rem, auto)${weeklyIndex >= 0 ? " minmax(4.5rem, auto)" : ""}`,
        }}
      >
        <span className="text-2xs text-muted-foreground">Account</span>
        {windows.map((window) => (
          <span
            key={`${window.kind}:${window.id}`}
            className="truncate text-center text-2xs text-muted-foreground"
          >
            {windowLabel(pool.driver, window).label}
          </span>
        ))}
        <span className="text-2xs text-muted-foreground">Back in</span>
        {weeklyIndex >= 0 ? (
          <span className="text-2xs text-muted-foreground">Weekly resets</span>
        ) : null}
        {groups.map((group) => (
          <Fragment key={group.label ?? "all"}>
            {group.label ? (
              <span className="col-span-full mt-2 text-2xs font-medium tracking-wide text-muted-foreground uppercase">
                {group.label}
              </span>
            ) : null}
            {group.rows.map((row) => (
              <HeatRow
                key={row.account.key}
                row={row}
                windows={windows}
                weeklyIndex={weeklyIndex}
                color={color}
                now={now}
              />
            ))}
          </Fragment>
        ))}
      </div>
      <div aria-hidden className="flex items-center gap-1.5 text-2xs text-muted-foreground">
        left:
        {[0, 40, 100].map((remaining) => (
          <Fragment key={remaining}>
            <span
              className={cn("h-3 w-7 rounded-sm", remaining === 0 && "bg-muted")}
              style={heatStyle(color, remaining)}
            />
            {remaining}%
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function PoolSection({ pool, now }: { readonly pool: LimitPool; readonly now: number }) {
  const color = barColor(pool.driver);
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={pool.driver}
          displayName={label}
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        {label}
      </h2>
      <div className="flex flex-col gap-4 rounded-lg border border-border/60 p-4">
        <PoolSummary driver={pool.driver} windows={windows} />
        <HeatGrid pool={pool} windows={windows} color={color} now={now} />
      </div>
    </section>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const [segmentPopover] = useState(() => PopoverCreateHandle<SegmentPayload>());
  const segmentPopoverActions = useRef<PopoverPrimitive.Root.Actions | null>(null);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const notices = collectLimitNotices(presentations);
  const externalLinks = collectExternalUsageLinks(presentations);
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 && notices.length === 0 && !cursorPrompt && externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      <SegmentPopoverContext value={segmentPopover}>
        {pools.map((pool, index) => (
          <Fragment key={pool.driver}>
            {index === cursorPromptAt ? cursorPrompt : null}
            <PoolSection pool={pool} now={now} />
          </Fragment>
        ))}
      </SegmentPopoverContext>
      <Popover handle={segmentPopover} actionsRef={segmentPopoverActions}>
        {({ payload }) =>
          payload ? (
            <ActiveSegmentPopover
              handle={segmentPopover}
              actions={segmentPopoverActions}
              payload={payload}
              pools={pools}
              now={now}
            />
          ) : null
        }
      </Popover>
      {cursorPromptAt === pools.length ? cursorPrompt : null}
      <ExternalUsageLinks links={externalLinks} />
      <LimitNotices notices={notices} />
    </div>
  );
}

export function ExternalUsageLinks({
  links,
}: {
  readonly links: ReturnType<typeof collectExternalUsageLinks>;
}) {
  return links.map((link) => (
    <section
      key={link.url}
      className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {link.url === CHATGPT_USAGE_URL ? (
          <OpenAI className="size-5 shrink-0" aria-hidden="true" />
        ) : null}
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium">{link.label}</h2>
          {link.url === CHATGPT_USAGE_URL ? (
            <p className="text-xs text-muted-foreground">
              View usage in ChatGPT with your connected account.
            </p>
          ) : link.message ? (
            <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
          ) : null}
        </div>
      </div>
      <Button
        variant="ghost-muted"
        size="xs"
        onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
      >
        Manage usage
        <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
      </Button>
    </section>
  ));
}

export function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}
