import type { OrchestrationV2AppThread, OrchestrationV2ProviderThread } from "@t3tools/contracts";

/**
 * An imported chat (thread id `import:<instance>:<native id>`) resumes its provider's own session:
 * starting one with that id fails ("Session ID … is already in use"), and a text handoff would give
 * the agent the conversation twice. The native id must match the thread id, since a rewind to the
 * start binds a fresh one with no transcript.
 */
export function isImportedNativeSession(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "id" | "historyOrigin">;
  readonly providerThread: Pick<OrchestrationV2ProviderThread, "nativeThreadRef">;
}): boolean {
  const nativeId = input.providerThread.nativeThreadRef?.nativeId;
  return (
    input.thread.historyOrigin === "v1_import" &&
    nativeId !== undefined &&
    nativeId !== null &&
    nativeId !== "" &&
    input.thread.id.startsWith("import:") &&
    input.thread.id.endsWith(`:${nativeId}`)
  );
}
