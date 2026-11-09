import { TEMPO_APPROVAL_TOOL_INPUT_LIMIT } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { tempoApprovalTool } from "./approvalTool.ts";

describe("tempoApprovalTool", () => {
  it("carries Bash's own description and command", () => {
    expect(
      tempoApprovalTool(
        "Bash",
        { command: "git push", description: " Push this branch " },
        undefined,
      ),
    ).toEqual({
      name: "Bash",
      input: '{"command":"git push","description":" Push this branch "}',
      command: "git push",
      firstArg: "git push",
      description: "Push this branch",
    });
  });

  it("keeps an MCP tool's input, first argument and the provider's subtitle", () => {
    expect(
      tempoApprovalTool("mcp__example__check_session", { session_id: "01a1" }, "Checks it"),
    ).toEqual({
      name: "mcp__example__check_session",
      input: '{"session_id":"01a1"}',
      firstArg: "01a1",
      subtitle: "Checks it",
    });
  });

  it("takes the first argument of a big MCP input before the input is cut", () => {
    const tool = tempoApprovalTool(
      "mcp__example__comment",
      { task_id: "TASK-1", body: "y".repeat(20_000) },
      undefined,
    );
    expect(tool.firstArg).toBe("TASK-1");
    expect(tool.input!.length).toBe(TEMPO_APPROVAL_TOOL_INPUT_LIMIT + 1);
  });

  it("does not treat another tool's description field as a Bash description", () => {
    expect(tempoApprovalTool("Task", { description: "Do a thing" }, undefined).description).toBe(
      undefined,
    );
  });

  it("keeps a 9 KB Write's path and sends its size, never its content", () => {
    const content = "SECRET-BODY ".repeat(800);
    const tool = tempoApprovalTool("Write", { file_path: "src/big.ts", content }, undefined);
    expect(tool.path).toBe("src/big.ts");
    expect(tool.input).toBe(`{"file_path":"src/big.ts","content":"[${content.length} chars]"}`);
    expect(JSON.stringify(tool)).not.toContain("SECRET-BODY");
    expect(tool.firstArg).toBeUndefined();
  });

  it("sends sizes for Edit, MultiEdit and NotebookEdit too", () => {
    const edit = tempoApprovalTool(
      "Edit",
      { file_path: "a.ts", old_string: "old", new_string: "newer" },
      undefined,
    );
    expect(edit.input).toBe(
      '{"file_path":"a.ts","old_string":"[3 chars]","new_string":"[5 chars]"}',
    );
    expect(
      tempoApprovalTool("MultiEdit", { file_path: "a.ts", edits: [{}, {}] }, undefined).input,
    ).toBe('{"file_path":"a.ts","edits":"[2 edits]"}');
    expect(
      tempoApprovalTool("NotebookEdit", { notebook_path: "n.ipynb", new_source: "abc" }, undefined)
        .path,
    ).toBe("n.ipynb");
  });

  it("caps command, description and subtitle so a huge heredoc stays off the wire", () => {
    const tool = tempoApprovalTool(
      "Bash",
      { command: `cat <<EOF\n${"x".repeat(100_000)}\nEOF`, description: "d".repeat(2_000) },
      "s".repeat(2_000),
    );
    expect(tool.command!.length).toBe(2_001);
    expect(tool.description!.length).toBe(501);
    expect(tool.subtitle!.length).toBe(501);
    expect(tool.input!.length).toBe(TEMPO_APPROVAL_TOOL_INPUT_LIMIT + 1);
    expect(JSON.stringify(tool).length).toBeLessThan(12_000);
  });

  it("cuts by code points, so an emoji at the cut stays whole", () => {
    const tool = tempoApprovalTool("Bash", { description: `${"d".repeat(499)}🙂🙂` }, undefined);
    expect(tool.description).toBe(`${"d".repeat(499)}🙂…`);
    expect(tool.description!.isWellFormed()).toBe(true);
  });
});
