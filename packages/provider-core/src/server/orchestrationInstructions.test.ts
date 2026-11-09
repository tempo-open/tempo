import { assert, describe, it } from "@effect/vitest";

import {
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH,
  T3_CODE_ORCHESTRATION_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
  t3AcpPromptWithInstructions,
  t3OrchestrationPrompt,
  t3OrchestrationSystemPrompt,
} from "./orchestrationInstructions.ts";

// tempo: Tempo adds sections to upstream's orchestration guidance.
describe("Tempo orchestration provider instructions", () => {
  it("sends waits on outside state to a watcher, not a recurring prompt", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "arm a watcher with `watch_command`");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "Never use `schedule_task` to check back");
  });

  it("renders a page in the thread through html_preview and html_render", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "then `html_render`");
  });

  it("asks for decisions with the question tool and rereads the asks before reporting done", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ask with your question tool");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "with `t3_user_messages` before you report");
  });

  // A secret the user sent is for use, and a secret card closes when the turn ends.
  it("uses a secret the user already sent, and waits on a secret card", () => {
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "A secret the user already sent");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "never ask for it again");
    assert.include(T3_CODE_ORCHESTRATION_INSTRUCTIONS, "ending your turn closes its card");
  });

  it("keeps every section under Codex's per-entry limit", () => {
    for (const section of T3_CODE_ORCHESTRATION_SECTIONS) {
      assert.isBelow(new TextEncoder().encode(section).byteLength, 4_000);
    }
  });
});

describe("T3 device instructions", () => {
  // tempo: tempoAgentText names the heading for Tempo, so the absence checks below look for that.
  const TEMPO_DEVICE_HEADING = "## Tempo devices";

  it("tempo: heads the device instructions with Tempo's name", () => {
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, TEMPO_DEVICE_HEADING);
  });

  it("route device work through device_open and give Claude the line that loads the tools", () => {
    for (const intent of ["`device_list`", "`device_open`", "`agent-device`", "ssh", "`hostId`"]) {
      assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, intent);
    }
    assert.notInclude(T3_CODE_DEVICE_TOOL_INSTRUCTIONS, "ToolSearch");
    const loadLine =
      " Load them with ToolSearch `select:mcp__t3-code__device_list,mcp__t3-code__device_open,mcp__t3-code__device_screenshot,mcp__t3-code__device_close`.";
    assert.include(T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH, loadLine);
    assert.equal(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS_WITH_TOOL_SEARCH.replace(loadLine, ""),
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });

  it("open the app before the returned command's snapshots, screenshots and input", () => {
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "its snapshots, screenshots and input need `open <app>` first,",
    );
  });

  it("keep the failure rule from taking over or closing a session another thread holds", () => {
    // agent-device's DEVICE_IN_USE advice is to rerun with the owner's --session or close it first.
    assert.include(
      T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
      "follow its advice once, but never reuse or close another session; if it still fails,",
    );
  });

  it("reach OpenCode and Cursor only when the session holds device access", () => {
    assert.include(t3OrchestrationSystemPrompt(true, true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(t3OrchestrationSystemPrompt(true, false), TEMPO_DEVICE_HEADING);
    assert.isUndefined(t3OrchestrationSystemPrompt(false, true));

    const firstRun = (hasDeviceTools: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools,
        orchestrationDelivered: false,
        deviceInstructionsDelivered: false,
      });
    assert.include(firstRun(true), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(firstRun(false), TEMPO_DEVICE_HEADING);

    const laterRun = (deviceInstructionsDelivered: boolean) =>
      t3OrchestrationPrompt({
        prompt: "Check the login screen.",
        hasT3Mcp: true,
        hasDeviceTools: true,
        orchestrationDelivered: true,
        deviceInstructionsDelivered,
      });
    assert.include(laterRun(false), T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.notInclude(laterRun(false), T3_CODE_ORCHESTRATION_INSTRUCTIONS.trim());
    assert.equal(laterRun(true), "Check the login screen.");
  });

  it("reach ACP agents again when device access changes mid-thread", () => {
    const state = { interactionMode: "default", hasT3Mcp: true, hasDeviceTools: false } as const;
    const withDevices = t3AcpPromptWithInstructions({
      prompt: "Check the login screen.",
      state: { ...state, hasDeviceTools: true },
      previousState: state,
    });
    assert.include(withDevices, T3_CODE_DEVICE_TOOL_INSTRUCTIONS);
    assert.equal(
      t3AcpPromptWithInstructions({ prompt: "Again.", state, previousState: state }),
      "Again.",
    );
    assert.notInclude(t3AcpPromptWithInstructions({ prompt: "Hi.", state }), TEMPO_DEVICE_HEADING);
  });
});
