import {
  TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT,
  TEMPO_LOCAL_CODEX_SIGN_IN_HINT,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { managedProviderRows } from "./managedProviders.ts";

const provider = (id: string, overrides: Partial<ServerProvider> = {}): ServerProvider => ({
  instanceId: ProviderInstanceId.make(id),
  driver: ProviderDriverKind.make(id),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-10-12T12:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...overrides,
});

const signedOut = { status: "error", auth: { status: "unauthenticated" } } as const;

describe("managedProviderRows", () => {
  it("always lists Claude then Codex, ignoring other providers", () => {
    const rows = managedProviderRows([provider("cursor"), provider("codex")]);

    expect(rows.map((row) => [row.id, row.state])).toEqual([
      ["claudeAgent", "checking"],
      ["codex", "ready"],
    ]);
  });

  it("names the account in use on this machine's own sign in", () => {
    const detail = (auth: ServerProvider["auth"]) =>
      managedProviderRows([provider("claudeAgent", { auth })])[0]?.detail;

    expect(detail({ status: "authenticated", label: "Work" })).toBe("Work · 0 models");
    expect(detail({ status: "authenticated", email: "ada@example.com" })).toBe(
      "ada@example.com · 0 models",
    );
    expect(detail({ status: "authenticated" })).toBe("On this Mac · 0 models");
  });

  it("asks for each provider's own sign in on this Mac when it has none", () => {
    const [claude, codex] = managedProviderRows([
      provider("claudeAgent", signedOut),
      provider("codex", signedOut),
    ]);

    expect(claude?.state).toBe("signIn");
    expect(claude?.detail).toBe(TEMPO_LOCAL_CLAUDE_SIGN_IN_HINT);
    expect(codex?.state).toBe("signIn");
    expect(codex?.detail).toBe(TEMPO_LOCAL_CODEX_SIGN_IN_HINT);
  });

  it("says why a refused sign in failed instead of the generic hint", () => {
    const [, codex] = managedProviderRows([
      provider("codex", { ...signedOut, message: "Codex did not accept the saved login." }),
    ]);

    expect(codex?.state).toBe("signIn");
    expect(codex?.detail).toBe("Codex did not accept the saved login.");
  });

  it("shows the provider's own message when it is not ready", () => {
    const [, codex] = managedProviderRows([
      provider("codex", {
        status: "warning",
        auth: { status: "unknown" },
        message: "Installing Codex on this environment…",
      }),
    ]);

    expect(codex?.state).toBe("attention");
    expect(codex?.detail).toBe("Installing Codex on this environment…");
  });
});
