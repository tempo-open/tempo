import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { RocketIcon } from "lucide-react";

import {
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
} from "../../components/CommandPalette.logic";
import { readEnvironmentScope } from "../../state/session";
import { readProductionWaitAction, setProductionWait } from "./productionWaitActions";

/** "Wait for production" or "Stop waiting for production" for the open thread. */
export function buildProductionWaitPaletteItems(
  thread: EnvironmentThreadShell,
): ReadonlyArray<CommandPaletteActionItem> {
  const action = readProductionWaitAction(thread);
  if (action === null) return [];
  return [
    {
      kind: "action",
      value: `action:tempo-production-wait:${action}`,
      title: action === "start" ? "Wait for production" : "Stop waiting for production",
      searchTerms: ["production", "promote", "promotion", "staging", "deploy", "release", "wait"],
      icon: <RocketIcon className={ITEM_ICON_CLASS} />,
      disabled: !readEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope),
      run: () =>
        setProductionWait(scopeThreadRef(thread.environmentId, thread.id), action === "start"),
    },
  ];
}
