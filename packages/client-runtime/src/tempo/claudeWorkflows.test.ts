import type { OrchestrationV2Subagent, ProviderOptionDescriptor } from "@t3tools/contracts";
import { NodeId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  claudeWorkflowInstanceSettings,
  deriveWorkflowCard,
  workflowApprovalScriptNotice,
  workflowApprovalTitle,
  workflowApprovalView,
  resolveUltracodeToggle,
  runUsedUltracode,
  shouldShowUltracodeKeywordHint,
  toggleUltracodeOptions,
  workflowAgentCountLabel,
} from "./claudeWorkflows.ts";

const ULTRACODE_DESCRIPTORS: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
  },
  { id: "ultracode", label: "Ultracode", type: "boolean" },
];

describe("ultracode toggle", () => {
  it("is offered only where the model has the option, and keeps the effort", () => {
    expect(resolveUltracodeToggle({ descriptors: [], options: [] })).toEqual({
      available: false,
      enabled: false,
    });
    const on = toggleUltracodeOptions([{ id: "effort", value: "high" }]);
    expect(on).toEqual([
      { id: "effort", value: "high" },
      { id: "ultracode", value: true },
    ]);
    expect(resolveUltracodeToggle({ descriptors: ULTRACODE_DESCRIPTORS, options: on })).toEqual({
      available: true,
      enabled: true,
    });
    expect(toggleUltracodeOptions(on)).toEqual([
      { id: "effort", value: "high" },
      { id: "ultracode", value: false },
    ]);
  });

  it("turns a legacy ultracode effort off without leaving the effort behind", () => {
    expect(toggleUltracodeOptions([{ id: "effort", value: "ultracode" }])).toEqual([
      { id: "ultracode", value: false },
    ]);
  });

  it("hints that the keyword runs a workflow only while the toggle is off", () => {
    const off = { available: true, enabled: false };
    expect(
      shouldShowUltracodeKeywordHint({
        prompt: "ultracode: migrate the tests",
        toggle: off,
        keywordTriggerEnabled: true,
      }),
    ).toBe(true);
    expect(
      shouldShowUltracodeKeywordHint({
        prompt: "ultracodes are not a word",
        toggle: off,
        keywordTriggerEnabled: true,
      }),
    ).toBe(false);
    expect(
      shouldShowUltracodeKeywordHint({
        prompt: "ultracode",
        toggle: off,
        keywordTriggerEnabled: false,
      }),
    ).toBe(false);
    expect(
      shouldShowUltracodeKeywordHint({
        prompt: "ultracode",
        toggle: { available: true, enabled: true },
        keywordTriggerEnabled: true,
      }),
    ).toBe(false);
  });

  it("reads the keyword the way Claude Code does", () => {
    const hint = (prompt: string) =>
      shouldShowUltracodeKeywordHint({
        prompt,
        toggle: { available: true, enabled: false },
        keywordTriggerEnabled: true,
      });
    expect(hint("Let's ultracode the migration.")).toBe(true);
    expect(hint("Port the suites, ultracode.")).toBe(true);
    // A slash command, quoted or bracketed text, paths, flags and questions do not count.
    expect(hint("/review ultracode")).toBe(false);
    expect(hint('What does "ultracode" do')).toBe(false);
    expect(hint("Explain `ultracode` and (ultracode) and <ultracode>")).toBe(false);
    expect(hint("Read docs/ultracode/intro.md and ultracode.ts")).toBe(false);
    expect(hint("Pass --ultracode-mode")).toBe(false);
    expect(hint("Should I use ultracode?")).toBe(false);
  });

  it("badges a run from the selection it was sent with", () => {
    expect(
      runUsedUltracode({ modelSelection: { options: [{ id: "ultracode", value: true }] } }),
    ).toBe(true);
    expect(runUsedUltracode({ modelSelection: {} })).toBe(false);
  });
});

// The workflow the server folds from claudeWorkflowStream.test.ts's frames,
// with the run still going.
const coordinator = (
  status: OrchestrationV2Subagent["status"],
): Pick<
  OrchestrationV2Subagent,
  "id" | "title" | "prompt" | "status" | "workflow" | "result" | "childThreadId"
> => ({
  id: NodeId.make("node-wf"),
  title: "Review the diff with three critics",
  prompt: "",
  status,
  result: status === "completed" ? "Two critics agree; tests need a retry." : null,
  childThreadId: ThreadId.make("thread-wf"),
  workflow: {
    name: "review",
    runHandles: { runId: "run_7f3a", scriptPath: "/s/script.js" },
    // The CLI numbers phases and agents from 1.
    phases: [
      { index: 1, title: "Read" },
      { index: 2, title: "Critique" },
    ],
    agents: [
      {
        index: 1,
        label: "read:diff",
        state: "completed",
        phaseIndex: 1,
        phaseTitle: "Read",
        model: "claude-opus-5-5",
        totalTokens: 9_000,
        durationMs: 4_000,
        startedAt: 1_760_000_000_000,
      },
      { index: 2, label: "critic:types", state: "running", phaseIndex: 2, phaseTitle: "Critique" },
      { index: 3, label: "critic:tests", state: "queued", phaseIndex: 2, phaseTitle: "Critique" },
    ],
    totalTokens: 12_500,
  },
});

describe("workflow card", () => {
  it("shows phases with state, per-phase agents and counts while running", () => {
    // The meta's phases join the arc by title: the first is not repeated.
    const card = deriveWorkflowCard(coordinator("running"), {
      name: "review",
      description: "Review the diff with three critics",
      phases: [
        { title: "Read" },
        { title: "Critique", detail: "One critic per concern" },
        { title: "Merge" },
      ],
    });
    expect(card).not.toBeNull();
    expect(card!.name).toBe("review");
    expect(card!.description).toBe("Review the diff with three critics");
    expect(card!.state).toBe("running");
    expect(card!.canStop).toBe(true);
    expect(card!.runId).toBe("run_7f3a");
    expect(
      card!.phases.map(({ title, state, doneCount, agents, detail }) => ({
        title,
        state,
        doneCount,
        agents: agents.map((agent) => agent.state),
        detail,
      })),
    ).toEqual([
      { title: "Read", state: "done", doneCount: 1, agents: ["done"], detail: null },
      {
        title: "Critique",
        state: "running",
        doneCount: 0,
        agents: ["running", "queued"],
        detail: "One critic per concern",
      },
      { title: "Merge", state: "queued", doneCount: 0, agents: [], detail: null },
    ]);
    expect(workflowAgentCountLabel(card!)).toBe("1 of 3 agents done");
    expect(card!.result).toBeNull();
  });

  it("settles agents the provider last saw in flight with the run", () => {
    const stopped = deriveWorkflowCard(coordinator("cancelled"))!;
    expect(stopped.state).toBe("stopped");
    expect(stopped.canStop).toBe(false);
    expect(stopped.phases.map((phase) => phase.state)).toEqual(["done", "stopped"]);

    const done = deriveWorkflowCard(coordinator("completed"))!;
    expect(done.result).toBe("Two critics agree; tests need a retry.");
    expect(done.phases.map((phase) => phase.state)).toEqual(["done", "done"]);
  });

  it("is null for an ordinary subagent", () => {
    expect(deriveWorkflowCard({ ...coordinator("running"), workflow: undefined })).toBeNull();
  });
});

describe("workflow approvals", () => {
  it("reads the meta header from the script the CLI will run", () => {
    const script = `export const meta = {
  name: "migrate",
  description: "Port every test to vitest",
  phases: [{ title: "Find", detail: "list suites" }, { title: "Port" }],
};
await parallel(files.map((file) => agent(file)));`;
    const view = workflowApprovalView({ script });
    expect(view).toEqual({
      name: "migrate",
      description: "Port every test to vitest",
      phases: [{ title: "Find", detail: "list suites" }, { title: "Port" }],
      script,
      scriptLength: null,
      savedName: null,
      scriptPath: null,
      resumeFromRunId: null,
    });
    expect(workflowApprovalTitle(view!)).toBe('Run workflow "migrate"');
    expect(workflowApprovalScriptNotice(view!)).toBeNull();
  });

  it("names a saved workflow and a script file it could not read", () => {
    const saved = workflowApprovalView({ name: "review" })!;
    expect(workflowApprovalTitle(saved)).toBe('Run the saved workflow "review"');
    const file = workflowApprovalView({ scriptPath: "/tmp/run/script.js" })!;
    expect(workflowApprovalTitle(file)).toBe("Run a workflow script");
    expect(workflowApprovalScriptNotice(file)).toBe(
      "Tempo can't show this script file. Read it before approving.",
    );
  });

  it("says when the script shown is only its start", () => {
    const view = workflowApprovalView({ script: "x".repeat(10), scriptLength: 50 })!;
    expect(workflowApprovalScriptNotice(view)).toBe(
      "Script cut: 10 of 50 characters shown. Approving runs all of it.",
    );
  });

  it("is only ever built from the structured workflow, never approval text", () => {
    expect(workflowApprovalView(undefined)).toBeNull();
  });
});

describe("Claude instance workflow settings", () => {
  it("defaults both switches on and turns the keyword off with workflows", () => {
    expect(claudeWorkflowInstanceSettings(undefined)).toEqual({
      workflowsEnabled: true,
      keywordTriggerEnabled: true,
    });
    expect(claudeWorkflowInstanceSettings({ ultracodeKeyword: false })).toEqual({
      workflowsEnabled: true,
      keywordTriggerEnabled: false,
    });
    expect(claudeWorkflowInstanceSettings({ workflows: false })).toEqual({
      workflowsEnabled: false,
      keywordTriggerEnabled: false,
    });
  });
});
