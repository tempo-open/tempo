import { ProviderDriverKind, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isImportedNativeSession } from "./importedNativeSession.ts";

const sessionId = "0697f99c-0e22-406f-9d0a-7a07cf6b5ecc";
const importedThreadId = ThreadId.make(`import:claudeAgent:${sessionId}`);
const nativeRef = (nativeId: string) => ({
  nativeThreadRef: {
    driver: ProviderDriverKind.make("claudeAgent"),
    nativeId,
    strength: "strong" as const,
  },
});

describe("isImportedNativeSession", () => {
  it("matches the session an imported chat was imported with", () => {
    expect(
      isImportedNativeSession({
        thread: { id: importedThreadId, historyOrigin: "v1_import" },
        providerThread: nativeRef(sessionId),
      }),
    ).toBe(true);
  });

  it("ignores a fresh session minted later on the imported chat, as a rewind to the start does", () => {
    expect(
      isImportedNativeSession({
        thread: { id: importedThreadId, historyOrigin: "v1_import" },
        providerThread: nativeRef("5b1c0e7e-2f43-4d55-9a3e-0b8f2c6d7e11"),
      }),
    ).toBe(false);
  });

  it("ignores moved and legacy threads, whose ids are not import ids", () => {
    expect(
      isImportedNativeSession({
        thread: { id: ThreadId.make(sessionId), historyOrigin: "v1_import" },
        providerThread: nativeRef(sessionId),
      }),
    ).toBe(false);
  });

  it("ignores an imported chat with no native session bound", () => {
    expect(
      isImportedNativeSession({
        thread: { id: importedThreadId, historyOrigin: "v1_import" },
        providerThread: { nativeThreadRef: null },
      }),
    ).toBe(false);
  });
});
