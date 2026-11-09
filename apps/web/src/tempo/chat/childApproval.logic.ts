import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type {
  ProviderApprovalDecision,
  RuntimeRequestId,
  ScopedThreadRef,
} from "@t3tools/contracts";

type ChildInput = Pick<EnvironmentThreadShell, "environmentId" | "id" | "hasPendingApprovals">;

/**
 * The sub chat whose approval the chat that started it shows inline. Children arrive oldest
 * request first, so this is the one that has waited longest; questions stay behind the banner.
 */
export function inlineChildApprovalThread<T extends ChildInput>(children: readonly T[]): T | null {
  return children.find((child) => child.hasPendingApprovals) ?? null;
}

/** Answers the sub chat that asked, never the chat on screen. */
export function childApprovalResponse(
  child: ScopedThreadRef,
  requestId: RuntimeRequestId,
  decision: ProviderApprovalDecision,
) {
  return {
    environmentId: child.environmentId,
    input: { threadId: child.threadId, requestId, decision },
  };
}
