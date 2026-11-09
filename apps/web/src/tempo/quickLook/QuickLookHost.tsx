import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { QuickLookCard } from "./QuickLookCard";
import { readQuickLookAtom } from "./quickLookState";

/** tempo: the markdown reading card for the thread on screen. */
export function QuickLookHost(props: {
  readonly threadKey: string;
  readonly environmentId: EnvironmentId;
  readonly cwd: string | undefined;
}) {
  const request = useAtomValue(readQuickLookAtom());
  if (request === null || request.threadKey !== props.threadKey || !props.cwd) return null;
  return (
    <QuickLookCard
      key={request.id}
      request={request}
      environmentId={props.environmentId}
      cwd={props.cwd}
    />
  );
}
