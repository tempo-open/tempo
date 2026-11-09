/**
 * A whole workflow run, frame by frame, as Claude Code 2.1.296 (Agent SDK 0.3.276) emits it. The
 * SDK types omit `workflow_progress`, so its entries follow the CLI bundle: phases count from 1, a
 * queued agent is "start" with queuedAt and no startedAt, and a failed one reports `error`.
 * Snapshots leave out workflow_log entries. No recorded run exists in the testkit fixtures yet.
 */
import type { OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mergeClaudeWorkflowProgress,
  parseClaudeWorkflowRunHandles,
} from "../orchestration-v2/Adapters/claudeWorkflowProgress.ts";

const TASK_ID = "wf_review";
const T0 = 1_760_000_000_000;
const MODEL = "claude-opus-5-5";
const started = {
  type: "system",
  subtype: "task_started",
  task_id: TASK_ID,
  tool_use_id: "toolu_wf",
  description: "Review the diff with three critics",
  task_type: "local_workflow",
  workflow_name: "review",
  uuid: "00000000-0000-4000-8000-0000000000a1",
  session_id: "native",
};
const launched = {
  status: "async_launched",
  taskId: TASK_ID,
  taskType: "local_workflow",
  workflowName: "review",
  runId: "wf_7f3a9c21e0b4",
  transcriptDir: "/home/me/.claude/projects/p/s/subagents/workflows/wf_7f3a9c21e0b4",
  scriptPath: "/home/me/.claude/projects/p/s/workflows/scripts/review.js",
};
const progress = (
  entries: ReadonlyArray<Record<string, unknown>> | undefined,
  usage: { total_tokens: number; tool_uses: number; duration_ms: number },
  description: string,
) => ({
  type: "system",
  subtype: "task_progress",
  task_id: TASK_ID,
  tool_use_id: "toolu_wf",
  description,
  usage,
  ...(entries === undefined ? {} : { workflow_progress: entries }),
  uuid: "00000000-0000-4000-8000-0000000000a2",
  session_id: "native",
});
const DECLARED_PHASES = [
  { type: "workflow_phase", index: 1, title: "Read" },
  { type: "workflow_phase", index: 2, title: "Critique" },
  { type: "workflow_phase", index: 3, title: "Merge" },
];
const agent = (
  index: number,
  phaseIndex: number,
  phaseTitle: string,
  label: string,
  promptPreview: string,
  extra: Record<string, unknown>,
) => ({
  type: "workflow_agent",
  index,
  label,
  phaseIndex,
  phaseTitle,
  model: MODEL,
  promptPreview,
  lastProgressAt: T0,
  ...extra,
});
const read = (extra: Record<string, unknown>) =>
  agent(1, 1, "Read", "read:diff", "Summarise the diff", {
    agentId: "a1",
    queuedAt: T0,
    startedAt: T0 + 100,
    attempt: 1,
    ...extra,
  });
const types = (extra: Record<string, unknown>) =>
  agent(2, 2, "Critique", "critic:types", "Check the types", { queuedAt: T0 + 200, ...extra });
const tests = (extra: Record<string, unknown>) =>
  agent(3, 2, "Critique", "critic:tests", "Check the tests", { queuedAt: T0 + 200, ...extra });
const waiting = { state: "start" };

const frames = [
  progress(
    [...DECLARED_PHASES, read({ state: "start" })],
    { total_tokens: 0, tool_uses: 0, duration_ms: 50 },
    "Read: read:diff",
  ),
  progress(
    [
      ...DECLARED_PHASES,
      read({ state: "progress", tokens: 1_200, toolCalls: 1, lastToolName: "Read" }),
      types(waiting),
      tests(waiting),
    ],
    { total_tokens: 1_200, tool_uses: 1, duration_ms: 900 },
    "Critique: critic:tests",
  ),
  // Progress-only updates inside the throttle window: usage, no snapshot.
  progress(undefined, { total_tokens: 2_400, tool_uses: 2, duration_ms: 2_000 }, "Read: read:diff"),
  progress(
    [
      ...DECLARED_PHASES,
      read({
        state: "done",
        tokens: 9_000,
        toolCalls: 3,
        durationMs: 4_000,
        resultPreview: "Three files change the parser.",
        lastProgressAt: T0 + 4_100,
      }),
      types({ agentId: "a2", state: "start", startedAt: T0 + 4_100, attempt: 1 }),
      tests(waiting),
    ],
    { total_tokens: 9_000, tool_uses: 3, duration_ms: 4_300 },
    "Critique: critic:types",
  ),
  progress(
    [
      ...DECLARED_PHASES,
      read({
        state: "done",
        tokens: 9_000,
        toolCalls: 3,
        durationMs: 4_000,
        resultPreview: "Three files change the parser.",
        lastProgressAt: T0 + 4_100,
      }),
      types({
        agentId: "a2",
        state: "done",
        startedAt: T0 + 4_100,
        attempt: 1,
        tokens: 4_000,
        toolCalls: 2,
        durationMs: 3_000,
        resultPreview: "Types are fine.",
        lastProgressAt: T0 + 7_100,
      }),
      tests({
        agentId: "a3",
        state: "error",
        startedAt: T0 + 7_100,
        attempt: 1,
        tokens: 300,
        toolCalls: 0,
        durationMs: 1_000,
        error: "API Error: 529 overloaded",
        lastProgressAt: T0 + 8_100,
      }),
    ],
    { total_tokens: 13_300, tool_uses: 5, duration_ms: 8_200 },
    "Critique: critic:tests",
  ),
];

function fold(count: number): OrchestrationV2SubagentWorkflow | undefined {
  let workflow = mergeClaudeWorkflowProgress({
    previous: undefined,
    name: started.workflow_name,
    message: started,
  });
  workflow = mergeClaudeWorkflowProgress({
    previous: workflow,
    runHandles: parseClaudeWorkflowRunHandles(launched),
    message: {},
  });
  for (const frame of frames.slice(0, count)) {
    workflow = mergeClaudeWorkflowProgress({ previous: workflow, message: frame });
  }
  return workflow;
}

describe("Claude workflow stream", () => {
  it("shows agents waiting for a slot as queued, not running", () => {
    const workflow = fold(3);
    expect(workflow?.agents.map((entry) => [entry.label, entry.state])).toEqual([
      ["read:diff", "running"],
      ["critic:types", "queued"],
      ["critic:tests", "queued"],
    ]);
    // The usage-only frame keeps the roster and moves the totals.
    expect(workflow?.totalTokens).toBe(2_400);
  });

  it("folds a run into the workflow every client renders", () => {
    expect(fold(frames.length)).toEqual({
      name: "review",
      runHandles: {
        runId: "wf_7f3a9c21e0b4",
        transcriptDir: "/home/me/.claude/projects/p/s/subagents/workflows/wf_7f3a9c21e0b4",
        scriptPath: "/home/me/.claude/projects/p/s/workflows/scripts/review.js",
      },
      phases: [
        { index: 1, title: "Read" },
        { index: 2, title: "Critique" },
        { index: 3, title: "Merge" },
      ],
      agents: [
        {
          index: 1,
          label: "read:diff",
          state: "completed",
          agentId: "a1",
          phaseIndex: 1,
          phaseTitle: "Read",
          model: MODEL,
          attempt: 1,
          totalTokens: 9_000,
          toolCalls: 3,
          durationMs: 4_000,
          queuedAt: T0,
          startedAt: T0 + 100,
          completedAt: T0 + 4_100,
          prompt: "Summarise the diff",
          result: "Three files change the parser.",
        },
        {
          index: 2,
          label: "critic:types",
          state: "completed",
          agentId: "a2",
          phaseIndex: 2,
          phaseTitle: "Critique",
          model: MODEL,
          attempt: 1,
          totalTokens: 4_000,
          toolCalls: 2,
          durationMs: 3_000,
          queuedAt: T0 + 200,
          startedAt: T0 + 4_100,
          completedAt: T0 + 7_100,
          prompt: "Check the types",
          result: "Types are fine.",
        },
        {
          index: 3,
          label: "critic:tests",
          state: "failed",
          agentId: "a3",
          phaseIndex: 2,
          phaseTitle: "Critique",
          model: MODEL,
          attempt: 1,
          totalTokens: 300,
          toolCalls: 0,
          durationMs: 1_000,
          queuedAt: T0 + 200,
          startedAt: T0 + 7_100,
          completedAt: T0 + 8_100,
          prompt: "Check the tests",
          result: "API Error: 529 overloaded",
        },
      ],
      totalTokens: 13_300,
      toolCalls: 5,
      durationMs: 8_200,
    });
  });
});
