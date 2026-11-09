import { describe, expect, it } from "vite-plus/test";

import { parseClaudeWorkflowMeta } from "./tempoClaudeWorkflowMeta.ts";

describe("parseClaudeWorkflowMeta", () => {
  it("reads the literal header without evaluating the script", () => {
    expect(
      parseClaudeWorkflowMeta(`/* saved */
export const meta = {
  name: "audit",
  "description": 'Audit the \\'api\\' package',
  phases: [{ title: "Scan", detail: "find call sites" }, "Report",],
  version: 2,
  draft: false,
};
throw new Error("never runs");`),
    ).toEqual({
      name: "audit",
      description: "Audit the 'api' package",
      phases: [{ title: "Scan", detail: "find call sites" }, { title: "Report" }],
    });
  });

  it("returns undefined for scripts Claude could not read a header from", () => {
    expect(parseClaudeWorkflowMeta("export default async () => {}")).toBeUndefined();
    expect(
      parseClaudeWorkflowMeta("export const meta = { name: `run-${Date.now()}` };"),
    ).toBeUndefined();
    expect(parseClaudeWorkflowMeta("export const meta = buildMeta();")).toBeUndefined();
  });
});
