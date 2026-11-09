/**
 * Extension pages run with the extension's privileges, so agents never drive them, except uBlock
 * Origin Lite's strict-blocking warning (every profile has it): an agent may read it, press its
 * buttons, navigate away or close the tab, so a blocked link never strands it. It still may not
 * run script there, which would carry the extension's privileges.
 */
import type { PreviewAutomationOperation } from "@t3tools/contracts";

import { UBLOCK_ORIGIN_LITE_ID } from "./BrowserExtensions.ts";

const BLOCK_PAGE_OPERATIONS: ReadonlySet<PreviewAutomationOperation> = new Set([
  "status",
  "snapshot",
  "waitFor",
  "open",
  "navigate",
  "click",
  "close",
]);

/** uBlock Origin Lite redirects a blocked page to `strictblock.html#<blocked URL>`. */
const isBlockPage = (url: string) => {
  const parsed = URL.parse(url);
  return (
    parsed?.protocol === "chrome-extension:" &&
    parsed.hostname === UBLOCK_ORIGIN_LITE_ID &&
    parsed.pathname === "/strictblock.html"
  );
};

/** Whether an agent's operation may run in a tab showing `url`. */
export const agentMayUsePage = (url: string, operation: PreviewAutomationOperation) =>
  !url.startsWith("chrome-extension:") ||
  (BLOCK_PAGE_OPERATIONS.has(operation) && isBlockPage(url));
