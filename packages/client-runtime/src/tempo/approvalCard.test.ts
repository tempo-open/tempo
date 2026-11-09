import { describe, expect, it } from "vite-plus/test";

import { alwaysAllowLabel, approvalCardView, humanizeMcpToolName } from "./approvalCard.ts";

describe("humanizeMcpToolName", () => {
  it("strips a repeated server prefix and uppercases short server names", () => {
    expect(humanizeMcpToolName("mcp__aws__aws_list_buckets")).toEqual({
      app: "AWS",
      action: "List buckets",
    });
    expect(humanizeMcpToolName("mcp__github__list_issues")).toEqual({
      app: "Github",
      action: "List issues",
    });
  });

  it("names the app's own server Tempo and drops the t3_ its tools repeat", () => {
    expect(humanizeMcpToolName("mcp__t3-code__service_request")).toEqual({
      app: "Tempo",
      action: "Service request",
    });
    expect(humanizeMcpToolName("mcp__t3_code__t3_thread_launch")).toEqual({
      app: "Tempo",
      action: "Thread launch",
    });
  });

  it("returns null for tools that are not MCP tools", () => {
    expect(humanizeMcpToolName("Bash")).toBeNull();
    expect(humanizeMcpToolName("mcp__nope")).toBeNull();
  });
});

describe("approvalCardView", () => {
  it("uses Claude's own Bash description as the title and shows the command", () => {
    const view = approvalCardView({
      requestKind: "command",
      detail: "Bash: git push --force",
      tool: {
        name: "Bash",
        command: "git push --force",
        description: "Force-push this branch to GitHub",
        input: '{"command":"git push --force","description":"Force-push this branch to GitHub"}',
      },
    });
    expect(view.title).toBe("Force-push this branch to GitHub");
    expect(view.summaryLine).toBe("$ git push --force");
    expect(view.isCommand).toBe(true);
    expect(view.rawDetails).toContain('"command": "git push --force"');
  });

  it("falls back to a generic Bash title without a description", () => {
    expect(
      approvalCardView({ requestKind: "command", tool: { name: "Bash", command: "ls" } }).title,
    ).toBe("Run a shell command");
  });

  it("shows the command Claude's Monitor tool will run", () => {
    const view = approvalCardView({
      requestKind: "command",
      tool: { name: "Monitor", command: "tail -f log | grep ERR", description: "Watch errors" },
    });
    expect(view.title).toBe("Watch errors");
    expect(view.summaryLine).toBe("$ tail -f log | grep ERR");
    expect(view.isCommand).toBe(true);
  });

  it("never cuts an emoji in half when shortening a long command", () => {
    const command = `${"a".repeat(398)}😀 and more`;
    const view = approvalCardView({ requestKind: "command", tool: { name: "Bash", command } });
    expect(view.summaryLine).toBe(`$ ${"a".repeat(398)}…`);
  });

  it("describes an MCP tool as App > Action with the first argument", () => {
    const view = approvalCardView({
      requestKind: "command",
      tool: { name: "mcp__linear__linear_get_issue", input: '{"issue_id":"01a1b2","intent":"x"}' },
    });
    expect(view.title).toBe("Use Linear › Get issue");
    expect(view.summaryLine).toBe("Linear · Get issue · 01a1b2");
    expect(view.isCommand).toBe(false);
  });

  it("calls a tool of the app's own server a Tempo tool", () => {
    const view = approvalCardView({
      requestKind: "command",
      tool: { name: "mcp__t3-code__service_request", input: '{"path":"/accounts/42"}' },
    });
    expect(view.title).toBe("Use Tempo › Service request");
    expect(view.summaryLine).toBe("Tempo · Service request · /accounts/42");
    expect(alwaysAllowLabel(view)).toBe("Always allow Tempo › Service request in this chat");
  });

  it("names an MCP tool that takes a command argument by its own name, not as a shell", () => {
    const view = approvalCardView({
      requestKind: "command",
      tool: {
        name: "mcp__laptop__run_app",
        command: "open -a Safari",
        input: '{"command":"open -a Safari"}',
      },
    });
    expect(view.title).toBe("Use Laptop › Run app");
    expect(view.summaryLine).toBe("Laptop · Run app · open -a Safari");
    expect(view.isCommand).toBe(false);
  });

  it("keeps a provider subtitle and skips it when absent", () => {
    expect(
      approvalCardView({
        requestKind: "command",
        tool: { name: "mcp__linear__linear_list_teams", subtitle: "Reads Linear teams" },
      }).subtitle,
    ).toBe("Reads Linear teams");
    expect(
      approvalCardView({ requestKind: "command", tool: { name: "mcp__linear__linear_list_teams" } })
        .subtitle,
    ).toBeNull();
  });

  it("names the file for edits and reads", () => {
    expect(
      approvalCardView({
        requestKind: "file-change",
        tool: { name: "Edit", input: '{"file_path":"src/foo.ts","old_string":"a"}' },
      }).title,
    ).toBe("Edit src/foo.ts");
    expect(
      approvalCardView({
        requestKind: "file-read",
        tool: { name: "Read", input: '{"file_path":"~/x.md"}' },
      }).title,
    ).toBe("Read ~/x.md");
  });

  it("reads the tool back out of an older prompt string, including a cut one", () => {
    const old = approvalCardView({
      requestKind: "command",
      detail: 'mcp__linear__linear_get_issue: {"issue_id":"01a1b2"}',
    });
    expect(old.title).toBe("Use Linear › Get issue");
    expect(old.summaryLine).toBe("Linear · Get issue · 01a1b2");
    const cut = approvalCardView({
      requestKind: "command",
      detail: 'mcp__linear__linear_get_issue: {"issue_id":"01a1…',
    });
    expect(cut.title).toBe("Use Linear › Get issue");
    expect(cut.summaryLine).toBe("Linear · Get issue");
    expect(cut.rawDetails).toBe('mcp__linear__linear_get_issue: {"issue_id":"01a1…');
    expect(
      approvalCardView({ requestKind: "command", detail: "Bash: git status" }).summaryLine,
    ).toBe("$ git status");
  });

  it("keeps an app-access request's own sentence", () => {
    expect(
      approvalCardView({
        requestKind: "mcp-elicitation",
        detail: "Allow Safari to open this page: a: b",
      }).title,
    ).toBe("Allow Safari to open this page: a: b");
  });

  it("keeps the path of a big Write whose input was cut, from the tool or from the prompt", () => {
    const viaTool = approvalCardView({
      requestKind: "file-change",
      detail: "Write: src/big.ts",
      tool: {
        name: "Write",
        path: "src/big.ts",
        input: '{"file_path":"src/big.ts","content":"[9000 chars',
      },
    });
    expect(viaTool.title).toBe("Write src/big.ts");
    const viaPrompt = approvalCardView({
      requestKind: "file-change",
      detail: "Write: src/big.ts",
      tool: { name: "Write", input: '{"file_path":"src/big.ts","content":"[9000 chars' },
    });
    expect(viaPrompt.title).toBe("Write src/big.ts");
  });

  it("leaves a provider reason that merely contains a colon alone", () => {
    const view = approvalCardView({ requestKind: "command", detail: "Escalation: needs network" });
    expect(view.title).toBe("Run a command");
    expect(view.summaryLine).toBe("$ Escalation: needs network");
    expect(view.rawDetails).toBe("Escalation: needs network");
  });

  it("reads an older MCP prompt back but not an unknown prefix", () => {
    expect(
      approvalCardView({ requestKind: "command", detail: "mcp__aws__aws_status: {}" }).title,
    ).toBe("Use AWS › Status");
    expect(
      approvalCardView({ requestKind: "permission", detail: "Network: allow example.com" }).title,
    ).toBe("Network: allow example.com");
  });

  it("keeps command line breaks, cuts at 400 characters, and adds the detail to Details", () => {
    const view = approvalCardView({
      requestKind: "command",
      detail: "Bash: cat <<EOF",
      tool: { name: "Bash", command: `cat <<EOF\n${"x".repeat(900)}\nEOF` },
    });
    expect(view.summaryLine!.startsWith("$ cat <<EOF\nxxx")).toBe(true);
    expect(view.summaryLine!.length).toBeLessThanOrEqual(402);
    expect(view.summaryLine!.endsWith("…")).toBe(true);
    expect(view.rawDetails).toContain("Bash: cat <<EOF");
  });

  it("names what always-allow covers", () => {
    expect(
      alwaysAllowLabel(approvalCardView({ requestKind: "command", tool: { name: "Bash" } })),
    ).toBe("Always allow Bash in this chat");
    expect(
      alwaysAllowLabel(
        approvalCardView({
          requestKind: "command",
          tool: { name: "mcp__linear__linear_create_comment" },
        }),
      ),
    ).toBe("Always allow Linear › Create comment in this chat");
    expect(
      alwaysAllowLabel(
        approvalCardView({ requestKind: "file-change", tool: { name: "Edit", path: "a.ts" } }),
      ),
    ).toBe("Always allow file edits in this chat");
    expect(alwaysAllowLabel(approvalCardView({ requestKind: "command", detail: "npm test" }))).toBe(
      "Always allow in this chat",
    );
  });

  it("describes a provider command that has no tool", () => {
    const view = approvalCardView({ requestKind: "command", detail: "npm test" });
    expect(view.title).toBe("Run a command");
    expect(view.summaryLine).toBe("$ npm test");
  });
});
