import { assert, describe, it } from "@effect/vitest";
import {
  TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";

import { presentLocalClaude, presentLocalCodex } from "./TempoProviderDrivers.ts";

const snapshot = (overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: "2.1.300",
  status: "ready",
  auth: { status: "authenticated", type: "apiKey", label: "API key", email: "ada@example.com" },
  checkedAt: "2026-10-12T12:00:00.000Z",
  setup: { canAuthenticate: true, canInstall: true },
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

describe("presentLocalClaude", () => {
  it("is ready on the login Claude Code reports, with no in-app setup actions", () => {
    const presented = presentLocalClaude(snapshot());

    assert.strictEqual(presented.status, "ready");
    assert.strictEqual(presented.auth.email, "ada@example.com");
    assert.deepStrictEqual(presented.setup, { canAuthenticate: false, canInstall: false });
  });

  it("tells a person whose Claude Code is signed out to run claude auth login", () => {
    const presented = presentLocalClaude(
      snapshot({
        status: "error",
        auth: { status: "unauthenticated" },
        message: "Claude Code is not authenticated. Run `claude auth login` and try again.",
      }),
    );

    assert.strictEqual(presented.status, "error");
    assert.strictEqual(presented.auth.status, "unauthenticated");
    assert.strictEqual(presented.message, TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT);
    assert.include(presented.message ?? "", "claude auth login");
  });

  it("says how to install Claude Code when it is missing, but not before the first check", () => {
    const missing = presentLocalClaude(
      snapshot({
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        message: "Claude Agent CLI (`claude`) was not found on PATH.",
      }),
    );
    assert.include(missing.message ?? "", "npm install -g @anthropic-ai/claude-code");

    const pending = presentLocalClaude(
      snapshot({
        installed: false,
        status: "warning",
        auth: { status: "unknown" },
        message: "Claude provider status has not been checked in this session yet.",
      }),
    );
    assert.notInclude(pending.message ?? "", "npm install");
  });
});

describe("presentLocalCodex", () => {
  it("shows Codex's own account and models, and tells a person it signed out what to run", () => {
    const models = snapshot().models;
    const ready = presentLocalCodex(snapshot({ models }));
    assert.strictEqual(ready.auth.email, "ada@example.com");
    assert.strictEqual(ready.status, "ready");

    const out = presentLocalCodex(snapshot({ auth: { status: "unauthenticated" } }));
    assert.strictEqual(out.status, "error");
    assert.include(out.message ?? "", "codex login");
  });
});
