import { useAtomValue } from "@effect/atom-react";
import {
  deriveWorkflowCard,
  formatWorkflowTokens,
  WORKFLOW_STATE_LABELS,
  workflowAgentCountLabel,
  type WorkflowCard,
  type WorkflowCardAgent,
  type WorkflowCardPhase,
  type WorkflowItemState,
} from "@t3tools/client-runtime/tempo/claude-workflows";
import {
  NodeId,
  ThreadId,
  type OrchestrationV2Subagent,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { parseClaudeWorkflowMeta } from "@t3tools/shared/tempoClaudeWorkflowMeta";
import * as DateTime from "effect/DateTime";
import {
  ChevronRightIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleSlashIcon,
  CircleXIcon,
  CopyIcon,
  PanelRightIcon,
  SquareIcon,
  WorkflowIcon,
  type LucideProps,
} from "lucide-react";
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";

import { AgentElapsed } from "../components/chat/AgentElapsed";
import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import {
  Sheet,
  SheetDescription,
  SheetHeader,
  SheetPopup,
  SheetTitle,
} from "../components/ui/sheet";
import { toastManager } from "../components/ui/toast";
import { useCopyToClipboard } from "../hooks/useCopyToClipboard";
import { cn } from "../lib/utils";
import { orchestrationEnvironment } from "../state/orchestration";
import { useEnvironmentQuery } from "../state/query";
import { environmentThreadDetails } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { SuccessCheckIcon } from "./look/SuccessCheckIcon";
import { useTempoLook } from "./look/useTempoLook";

const STATE_VISUALS: Readonly<
  Record<
    WorkflowItemState,
    { readonly icon: ComponentType<LucideProps>; readonly className: string }
  >
> = {
  queued: { icon: CircleDashedIcon, className: "text-muted-foreground" },
  running: { icon: CircleDotIcon, className: "text-warning" },
  // tempo: the tempo look draws done as a plain check in ink.
  done: { icon: SuccessCheckIcon, className: "text-success tempo:text-foreground" },
  failed: { icon: CircleXIcon, className: "text-destructive" },
  stopped: { icon: CircleSlashIcon, className: "text-muted-foreground" },
};

/** Icon, word and colour together: state never rests on colour alone. */
function StateMark(props: { readonly state: WorkflowItemState; readonly withLabel?: boolean }) {
  const visual = STATE_VISUALS[props.state];
  const Icon = visual.icon;
  return (
    <span className={cn("inline-flex shrink-0 items-center gap-1 text-2xs", visual.className)}>
      <Icon aria-hidden className="size-3.5" />
      {props.withLabel === false ? (
        <span className="sr-only">{WORKFLOW_STATE_LABELS[props.state]}</span>
      ) : (
        WORKFLOW_STATE_LABELS[props.state]
      )}
    </span>
  );
}

const iso = (epochMs: number | null) =>
  epochMs === null ? null : DateTime.formatIso(DateTime.makeUnsafe(epochMs));

function AgentTime(props: { readonly agent: WorkflowCardAgent }) {
  const { agent } = props;
  if (agent.startedAt === null) return null;
  const running = agent.state === "running";
  return (
    <AgentElapsed
      compact
      agent={{
        status: running ? "running" : "completed",
        startedAt: iso(agent.startedAt),
        completedAt: running ? null : iso(agent.startedAt + (agent.durationMs ?? 0)),
      }}
    />
  );
}

/**
 * Progress snapshots arrive as fast as the CLI sends them. The card redraws at
 * most twice a second; elapsed clocks tick on their own without a redraw.
 */
function useThrottled<T>(value: T, intervalMs: number): T {
  const [shown, setShown] = useState(value);
  const lastShownAt = useRef(0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that holds back a new value until the throttle interval since the last shown one has passed
  useEffect(() => {
    const wait = lastShownAt.current + intervalMs - Date.now();
    if (wait <= 0) {
      lastShownAt.current = Date.now();
      setShown(value);
      return;
    }
    const timer = setTimeout(() => {
      lastShownAt.current = Date.now();
      setShown(value);
    }, wait);
    return () => clearTimeout(timer);
  }, [intervalMs, value]);
  return shown;
}

function useWorkflowCard(parentRef: ScopedThreadRef, subagentId: NodeId): WorkflowCard | null {
  const subagent = useAtomValue(
    environmentThreadDetails.threadAtom(parentRef),
    (thread): OrchestrationV2Subagent | null =>
      thread?.projection.subagents.find((agent) => agent.id === subagentId) ?? null,
  );
  const scriptPath = subagent?.workflow?.runHandles?.scriptPath ?? null;
  // The script's own header names the phases ahead of the run and their details.
  const script = useEnvironmentQuery(
    scriptPath === null
      ? null
      : orchestrationEnvironment.workflowScript({
          environmentId: parentRef.environmentId,
          input: { threadId: parentRef.threadId, scriptPath },
        }),
  );
  const meta =
    script.data === null ? null : (parseClaudeWorkflowMeta(script.data.contents) ?? null);
  const card = subagent === null ? null : deriveWorkflowCard(subagent, meta);
  return useThrottled(card, 500);
}

function useStopWorkflow(parentRef: ScopedThreadRef, card: WorkflowCard | null) {
  const stopCommand = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canOperate = useAtomValue(
    orchestrationEnvironment.stopWorkflow.permissionAtom(parentRef.environmentId),
  );
  const [stopping, setStopping] = useState(false);
  const stop =
    card !== null && card.canStop && canOperate
      ? async () => {
          if (stopping) return;
          setStopping(true);
          const result = await stopCommand({
            environmentId: parentRef.environmentId,
            input: { threadId: parentRef.threadId, subagentId: NodeId.make(card.subagentId) },
          });
          setStopping(false);
          if (result._tag === "Failure") {
            toastManager.add({ type: "error", title: "Could not stop workflow" });
          }
        }
      : null;
  return { stop, stopping };
}

function WorkflowSummaryLine(props: { readonly card: WorkflowCard }) {
  const { card } = props;
  const tokens = formatWorkflowTokens(card.totalTokens);
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-muted-foreground tabular-nums">
      <StateMark state={card.state} />
      <span>{workflowAgentCountLabel(card)}</span>
      {card.failedCount > 0 ? (
        <span className="text-destructive">{card.failedCount} failed</span>
      ) : null}
      {tokens === null ? null : <span>{tokens}</span>}
    </span>
  );
}

function PhaseRow(props: {
  readonly phase: WorkflowCardPhase;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly detailed: boolean;
}) {
  const { phase } = props;
  const [openOverride, setOpenOverride] = useState<boolean | null>(null);
  // The running phase opens itself until the person picks a side.
  const open = openOverride ?? (props.detailed || phase.state === "running");
  return (
    <li>
      <button
        type="button"
        aria-expanded={open}
        disabled={phase.agents.length === 0}
        onClick={() => setOpenOverride(!open)}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left hover:bg-accent/30 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <ChevronRightIcon
          aria-hidden
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90",
            phase.agents.length === 0 && "invisible",
          )}
        />
        <StateMark state={phase.state} withLabel={false} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs text-foreground">{phase.title}</span>
          {phase.detail === null ? null : (
            <span className="block truncate text-2xs text-muted-foreground">{phase.detail}</span>
          )}
        </span>
        <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
          {phase.agents.length === 0
            ? WORKFLOW_STATE_LABELS[phase.state]
            : `${phase.doneCount}/${phase.agents.length} · ${WORKFLOW_STATE_LABELS[phase.state]}`}
        </span>
      </button>
      {open && phase.agents.length > 0 ? (
        <ul className="m-0 list-none py-0.5 ps-6">
          {phase.agents.map((agent) => (
            <AgentRow
              key={agent.key}
              agent={agent}
              detailed={props.detailed}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function AgentRow(props: {
  readonly agent: WorkflowCardAgent;
  readonly detailed: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { agent } = props;
  const tokens = formatWorkflowTokens(agent.totalTokens);
  const childThreadId = agent.childThreadId;
  return (
    <li className="py-0.5">
      <div className="flex min-w-0 items-center gap-2 px-1.5 text-2xs">
        <StateMark state={agent.state} withLabel={false} />
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">
          {agent.label}
          {agent.attempt > 1 ? (
            <span className="text-muted-foreground"> · attempt {agent.attempt}</span>
          ) : null}
        </span>
        {agent.model === null ? null : (
          <span className="hidden shrink-0 text-muted-foreground sm:inline">{agent.model}</span>
        )}
        {tokens === null ? null : (
          <span className="shrink-0 text-muted-foreground tabular-nums">{tokens}</span>
        )}
        <span className="shrink-0 text-muted-foreground tabular-nums">
          <AgentTime agent={agent} />
        </span>
        {childThreadId === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Open ${agent.label} chat`}
            onClick={() => props.onOpenThread(ThreadId.make(childThreadId))}
          >
            Open
          </Button>
        )}
      </div>
      {props.detailed && (agent.prompt !== null || agent.result !== null) ? (
        <div className="mt-1 ms-6 space-y-1 rounded-md border border-border/70 p-2 text-2xs">
          {agent.prompt === null ? null : (
            <p className="whitespace-pre-wrap break-words text-muted-foreground">
              <span className="font-medium text-foreground">Prompt </span>
              {agent.prompt}
            </p>
          )}
          {agent.result === null ? null : (
            <p
              className={cn(
                "whitespace-pre-wrap break-words",
                agent.state === "failed" ? "text-destructive" : "text-foreground",
              )}
            >
              <span className="font-medium">{agent.state === "failed" ? "Error " : "Result "}</span>
              {agent.result}
            </p>
          )}
        </div>
      ) : null}
    </li>
  );
}

function WorkflowPhases(props: {
  readonly card: WorkflowCard;
  readonly detailed: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { card } = props;
  if (card.phases.length === 0 && card.unphasedAgents.length === 0) {
    return <p className="px-1.5 text-2xs text-muted-foreground">No agents yet</p>;
  }
  return (
    <ul className="m-0 list-none p-0">
      {card.phases.map((phase) => (
        <PhaseRow
          key={phase.index}
          phase={phase}
          detailed={props.detailed}
          onOpenThread={props.onOpenThread}
        />
      ))}
      {card.unphasedAgents.map((agent) => (
        <AgentRow
          key={agent.key}
          agent={agent}
          detailed={props.detailed}
          onOpenThread={props.onOpenThread}
        />
      ))}
    </ul>
  );
}

// tempo: the tempo look draws each agent as one block of a segmented bar.
const TEMPO_BLOCK_CLASS: Readonly<Record<WorkflowItemState, string>> = {
  queued: "bg-tempo-seg-off",
  running: "bg-tempo-accent-soft ring-1 ring-tempo-accent ring-inset",
  done: "bg-tempo-accent",
  failed: "bg-destructive",
  stopped: "bg-tempo-ink-4",
};

const TEMPO_STEP_CLASS: Readonly<Record<WorkflowItemState, string>> = {
  queued: "text-secondary-label",
  running: "text-tempo-accent",
  done: "text-muted-foreground",
  failed: "text-destructive",
  stopped: "text-secondary-label",
};

function agentSummary(agent: WorkflowCardAgent): string {
  const tokens = formatWorkflowTokens(agent.totalTokens);
  return [
    agent.label,
    WORKFLOW_STATE_LABELS[agent.state],
    ...(agent.attempt > 1 ? [`attempt ${agent.attempt}`] : []),
    ...(tokens === null ? [] : [tokens]),
  ].join(", ");
}

/** One block per agent, then the phases (or the agents) by name, colored by state. */
function WorkflowProgress(props: {
  readonly card: WorkflowCard;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { card } = props;
  const agents = [...card.phases.flatMap((phase) => phase.agents), ...card.unphasedAgents];
  const steps =
    card.phases.length > 0
      ? card.phases.map((phase) => ({
          key: `phase:${phase.index}`,
          title: phase.title,
          state: phase.state,
        }))
      : agents.map((agent) => ({ key: agent.key, title: agent.label, state: agent.state }));
  return (
    <>
      {agents.length > 0 ? (
        <ol aria-label="Agents" className="m-0 mt-1.5 mb-1 flex list-none gap-1 p-0">
          {agents.map((agent) => {
            const childThreadId = agent.childThreadId;
            // The 8 px bar sits in a 20 px tall target. A block with no chat to open is not a tab
            // stop: the Details sheet lists every agent's state, attempt and tokens.
            const bar = (
              <span
                className={cn(
                  "block h-2 w-full rounded-tempo-block",
                  TEMPO_BLOCK_CLASS[agent.state],
                )}
              />
            );
            return (
              <li key={agent.key} className="flex min-w-0 flex-1">
                <Tooltip>
                  <TooltipTrigger
                    render={
                      childThreadId === null ? (
                        <span
                          role="img"
                          aria-label={agentSummary(agent)}
                          className="w-full py-1.5"
                        />
                      ) : (
                        <button
                          type="button"
                          aria-label={`Open ${agent.label} chat: ${agentSummary(agent)}`}
                          onClick={() => props.onOpenThread(ThreadId.make(childThreadId))}
                          className="w-full cursor-pointer rounded-tempo-block py-1.5 focus-visible:outline-2 focus-visible:outline-ring"
                        />
                      )
                    }
                  >
                    {bar}
                  </TooltipTrigger>
                  <TooltipPopup>{agentSummary(agent)}</TooltipPopup>
                </Tooltip>
              </li>
            );
          })}
        </ol>
      ) : null}
      <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1 p-0 text-tempo-caption leading-[normal]">
        {steps.map((step) => (
          <li key={step.key} className={TEMPO_STEP_CLASS[step.state]}>
            {step.title}
          </li>
        ))}
      </ul>
    </>
  );
}

function WorkflowDetailSheet(props: {
  readonly card: WorkflowCard;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly stop: (() => Promise<void>) | null;
  readonly stopping: boolean;
}) {
  const { card } = props;
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "workflow run id" });
  const childThreadId = card.childThreadId;
  return (
    <Sheet open={props.open} onOpenChange={props.onOpenChange}>
      <SheetPopup side="right" className="max-w-lg">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <WorkflowIcon aria-hidden className="size-4 text-muted-foreground" />
            <SheetTitle>{card.name}</SheetTitle>
          </div>
          {card.description === null ? null : (
            <SheetDescription>{card.description}</SheetDescription>
          )}
          <WorkflowSummaryLine card={card} />
          <div className="flex flex-wrap gap-2 pt-1">
            {props.stop === null ? null : (
              <Button
                size="sm"
                variant="destructive-outline"
                disabled={props.stopping}
                onClick={() => void props.stop?.()}
              >
                <SquareIcon aria-hidden className="size-3 fill-current" />
                {props.stopping ? "Stopping" : "Stop workflow"}
              </Button>
            )}
            {card.runId === null ? null : (
              <Button size="sm" variant="outline" onClick={() => copyToClipboard(card.runId!)}>
                <CopyIcon aria-hidden className="size-3.5" />
                {isCopied ? "Copied" : "Copy run id"}
              </Button>
            )}
            {childThreadId === null ? null : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => props.onOpenThread(ThreadId.make(childThreadId))}
              >
                Open workflow chat
              </Button>
            )}
          </div>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-6">
          <WorkflowPhases card={card} detailed onOpenThread={props.onOpenThread} />
          {card.result === null ? null : (
            <section className="mt-4">
              <h3 className="mb-1 text-xs font-medium text-foreground">
                {card.state === "failed" ? "Error" : "Result"}
              </h3>
              <p
                className={cn(
                  "whitespace-pre-wrap break-words text-xs",
                  card.state === "failed" ? "text-destructive" : "text-muted-foreground",
                )}
              >
                {card.result}
              </p>
            </section>
          )}
        </div>
      </SheetPopup>
    </Sheet>
  );
}

/**
 * A Claude workflow in the thread: its phases, agents and counts inline, with a
 * sheet for the whole tree, each agent's prompt and result, Stop and the run id.
 * Renders `fallback` for a subagent that is not a workflow.
 */
export function WorkflowTimelineCard(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const card = useWorkflowCard(props.parentRef, props.subagentId);
  const { stop, stopping } = useStopWorkflow(props.parentRef, card);
  const [sheetOpen, setSheetOpen] = useState(false);
  const look = useTempoLook();
  if (card === null) return props.fallback;
  const sheet = (
    <WorkflowDetailSheet
      card={card}
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      onOpenThread={props.onOpenThread}
      stop={stop}
      stopping={stopping}
    />
  );
  if (look === "tempo") {
    return (
      <div
        data-v2-item-type="subagent"
        data-tempo-workflow={card.state}
        className="mt-0.5 mb-4.5 rounded-tempo-card bg-card px-4 pt-3.25 pb-3.5 ring-1 ring-border"
      >
        <div className="flex min-w-0 items-center gap-2.5 text-sm leading-[normal]">
          <WorkflowIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 truncate font-medium text-foreground">{card.name}</span>
          <span className="ms-auto shrink-0 text-tempo-note text-secondary-label tabular-nums">
            {card.agentCount === 0
              ? "No agents yet"
              : `${card.doneCount} of ${card.agentCount} ${card.agentCount === 1 ? "agent" : "agents"}`}
          </span>
          <span className="-my-1 -me-2 flex shrink-0 items-center">
            {stop === null ? null : (
              <Button
                size="xs"
                variant="ghost-muted"
                aria-label={`Stop workflow ${card.name}`}
                disabled={stopping}
                onClick={() => void stop()}
              >
                Stop
              </Button>
            )}
            <Button
              size="xs"
              variant="ghost-muted"
              aria-label={`Open ${card.name} details`}
              onClick={() => setSheetOpen(true)}
            >
              Details
            </Button>
          </span>
        </div>
        <WorkflowProgress card={card} onOpenThread={props.onOpenThread} />
        {card.result === null ? null : (
          <p
            className={cn(
              "mt-2.5 line-clamp-3 text-tempo-caption whitespace-pre-wrap",
              card.state === "failed" ? "text-destructive" : "text-secondary-label",
            )}
          >
            {card.result}
          </p>
        )}
        {sheet}
      </div>
    );
  }
  return (
    <div
      data-v2-item-type="subagent"
      data-tempo-workflow={card.state}
      className="my-1 rounded-lg border border-border/70 px-2 py-2"
    >
      <div className="flex min-w-0 items-start gap-2 px-1.5">
        <WorkflowIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-foreground">{card.name}</p>
          {card.description === null ? null : (
            <p className="truncate text-2xs text-muted-foreground">{card.description}</p>
          )}
          <WorkflowSummaryLine card={card} />
        </div>
        {stop === null ? null : (
          <Button
            size="xs"
            variant="ghost"
            aria-label={`Stop workflow ${card.name}`}
            disabled={stopping}
            onClick={() => void stop()}
          >
            <SquareIcon aria-hidden className="size-3 fill-current" />
            Stop
          </Button>
        )}
        <Button
          size="xs"
          variant="ghost"
          aria-label={`Open ${card.name} details`}
          onClick={() => setSheetOpen(true)}
        >
          <PanelRightIcon aria-hidden className="size-3.5" />
          Details
        </Button>
      </div>
      <div className="mt-1.5">
        <WorkflowPhases card={card} detailed={false} onOpenThread={props.onOpenThread} />
      </div>
      {card.result === null ? null : (
        <p
          className={cn(
            "mt-1.5 line-clamp-3 px-1.5 text-2xs whitespace-pre-wrap",
            card.state === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {card.result}
        </p>
      )}
      {sheet}
    </div>
  );
}
