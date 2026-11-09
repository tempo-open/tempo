import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { PendingThreadRequests } from "@t3tools/client-runtime/state/thread-requests";
import {
  AuthOrchestrationOperateScope,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { derivePendingApprovals, type PendingApproval } from "../../session-logic";
import { readEnvironmentScope } from "../../state/session";
import { environmentThreadDetails, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { childApprovalResponse, inlineChildApprovalThread } from "./childApproval.logic";

const NO_PENDING_REQUESTS_ATOM = Atom.make<PendingThreadRequests | null>(null).pipe(
  Atom.withLabel("web-child-approval-requests:none"),
);
const NO_PENDING_APPROVALS: PendingApproval[] = [];

/**
 * A sub chat's approval, answered from the chat that started it. Reads only the one child whose
 * request has waited longest, so the open chat follows a single extra transcript at a time.
 */
export function useChildApproval(input: {
  readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
  /** False while the open chat has its own approval or question, which comes first. */
  readonly enabled: boolean;
  readonly parentThreadId: ThreadId | null;
  readonly setThreadError: (threadId: ThreadId, error: string | null) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { parentThreadId, setThreadError, onOpenThread } = input;
  const child = input.enabled ? inlineChildApprovalThread(input.childThreadInputs) : null;
  const childRef = child === null ? null : scopeThreadRef(child.environmentId, child.id);
  const pending = useAtomValue(
    childRef === null
      ? NO_PENDING_REQUESTS_ATOM
      : environmentThreadDetails.pendingRequestsAtom(childRef),
  );
  const pendingApprovals =
    pending === null || pending.approvals.length === 0
      ? NO_PENDING_APPROVALS
      : derivePendingApprovals(pending.approvals);
  const respondToApproval = useOrchestrationCommand(threadEnvironment.respondToApproval, {
    reportFailure: false,
  });
  const [respondingRequestIds, setRespondingRequestIds] = useState<RuntimeRequestId[]>([]);

  const onRespondToApproval = useStableCallback(
    async (requestId: RuntimeRequestId, decision: ProviderApprovalDecision) => {
      if (
        childRef === null ||
        parentThreadId === null ||
        !readEnvironmentScope(childRef.environmentId, AuthOrchestrationOperateScope)
      )
        return;
      if (
        pendingApprovals.find((approval) => approval.requestId === requestId)
          ?.responseCapability !== "live"
      )
        return;
      setRespondingRequestIds((existing) =>
        existing.includes(requestId) ? existing : [...existing, requestId],
      );
      const result = await respondToApproval(childApprovalResponse(childRef, requestId, decision));
      if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
        const error = squashAtomCommandFailure(result);
        setThreadError(
          parentThreadId,
          error instanceof Error ? error.message : "Failed to submit approval decision.",
        );
      }
      setRespondingRequestIds((existing) => existing.filter((id) => id !== requestId));
      return result;
    },
  );
  const onOpenChild = useStableCallback(() => {
    if (child !== null) onOpenThread(child.id);
  });

  const activePendingApproval = pendingApprovals[0];
  if (child === null || activePendingApproval === undefined) return null;
  return {
    pendingApprovals,
    activePendingApproval,
    respondingRequestIds,
    onRespondToApproval,
    source: { title: child.title, onOpen: onOpenChild },
  };
}
