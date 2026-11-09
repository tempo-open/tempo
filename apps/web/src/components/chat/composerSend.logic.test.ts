import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { describe, expect, it } from "vite-plus/test";
import { formatInlineContextReference } from "../../lib/composerContextReferences";
import { threadContextReference } from "../../lib/composerContextRecords";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import {
  approvalRedirectNotice,
  emptyComposerDispatchLine,
  followsPendingComposerSend,
  joinComposerDispatchLine,
  loadBalancingSendWarning,
  multipleModelSendBlock,
  referencedThreadContexts,
} from "./composerSend.logic";

const local = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const localThread = threadContextRecord(scopeThreadRef(local, ThreadId.make("a")), "Local");
const remoteThread = threadContextRecord(scopeThreadRef(remote, ThreadId.make("b")), "Remote");

describe("referencedThreadContexts", () => {
  it("keeps only the attached threads the prompt still links", () => {
    const prompt = `see ${formatInlineContextReference(threadContextReference(remoteThread))}`;
    expect(
      referencedThreadContexts({ prompt, threadContexts: [localThread, remoteThread] }),
    ).toEqual([remoteThread]);
  });
});

describe("loadBalancingSendWarning", () => {
  it("asks the user to wait while resource checks run", () => {
    expect(
      loadBalancingSendWarning({
        pending: true,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [],
      }).title,
    ).toBe("Checking machine resources");
  });

  it("blames the attached threads when no machine can read all of them", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread, remoteThread],
        candidateEnvironmentIds: [local, remote],
      }).description,
    ).toMatch(/No machine can read every attached thread/);
  });

  it("blames resources when one machine can read every attached thread", () => {
    expect(
      loadBalancingSendWarning({
        pending: false,
        threadContexts: [localThread],
        candidateEnvironmentIds: [remote, local],
      }).description,
    ).toMatch(/No eligible machine has available resources/);
  });
});

describe("multipleModelSendBlock", () => {
  const ready = {
    selectionCount: 2,
    serverSupportsWorktreeBootstrap: true,
    isLocalDraftThread: true,
    isGitRepo: true,
    branch: "main",
  };

  it("lets a new Git draft with a branch and models start", () => {
    expect(multipleModelSendBlock(ready)).toBeNull();
  });

  it("asks for a server update before checking the draft", () => {
    expect(
      multipleModelSendBlock({
        ...ready,
        serverSupportsWorktreeBootstrap: false,
        isGitRepo: false,
      }),
    ).toBe("server-outdated");
  });

  it.each([
    { isLocalDraftThread: false },
    { isGitRepo: false },
    { branch: null },
    { selectionCount: 0 },
  ])("needs a new Git thread with a branch and models (%o)", (override) => {
    expect(multipleModelSendBlock({ ...ready, ...override })).toBe("needs-new-git-thread");
  });
});

describe("approvalRedirectNotice", () => {
  const settled = {
    draftChanged: false,
    declined: true,
    approvalResponding: false,
    approvalArrived: false,
  };

  it("says the decline went through when the draft changed after it", () => {
    expect(approvalRedirectNotice({ ...settled, draftChanged: true })).toBe(
      "Approval declined. Your message changed, so it wasn't sent.",
    );
    expect(approvalRedirectNotice({ ...settled, draftChanged: true, declined: false })).toBe(
      "Your message changed, so it wasn't sent.",
    );
  });

  it("explains an approval already being answered", () => {
    expect(
      approvalRedirectNotice({ ...settled, declined: false, approvalResponding: true }),
    ).toMatch(/already being answered/);
  });

  it("explains an approval that arrived during the decline", () => {
    expect(approvalRedirectNotice({ ...settled, approvalArrived: true })).toMatch(
      /Another approval arrived/,
    );
  });

  it("stays quiet when the decline failed or the user left the thread", () => {
    expect(approvalRedirectNotice({ ...settled, declined: false })).toBeNull();
    expect(approvalRedirectNotice(settled)).toBeNull();
  });
});

describe("followsPendingComposerSend", () => {
  const idle = emptyComposerDispatchLine();
  it.each([
    [
      "a composer send is still dispatching",
      { ...emptyComposerDispatchLine(), pending: 1 },
      false,
      true,
    ],
    ["a composer send awaits confirmation", idle, true, true],
    ["nothing from the composer is pending", idle, false, false],
  ])("on a server thread when %s", (_label, line, composerSendConfirming, follows) => {
    expect(followsPendingComposerSend({ isServerThread: true, line, composerSendConfirming })).toBe(
      follows,
    );
  });

  it("never on a draft, whose first send creates the thread", () => {
    expect(
      followsPendingComposerSend({
        isServerThread: false,
        line: { ...emptyComposerDispatchLine(), pending: 1 },
        composerSendConfirming: true,
      }),
    ).toBe(false);
  });
});

describe("joinComposerDispatchLine", () => {
  it("lets a send go only after every earlier one settled, even one that settled out of order", async () => {
    const line = emptyComposerDispatchLine();
    let idleCalls = 0;
    const onIdle = () => {
      idleCalls += 1;
    };
    const order: string[] = [];
    const first = joinComposerDispatchLine(line, onIdle);
    const second = joinComposerDispatchLine(line, onIdle);
    const third = joinComposerDispatchLine(line, onIdle);
    const thirdDispatched = third.previous.then((sent) => order.push(`third:${sent}`));

    second.settle(true);
    second.settle(false);
    await Promise.resolve();
    expect(order).toEqual([]);
    expect(line.pending).toBe(2);

    order.push("first");
    first.settle(true);
    await thirdDispatched;
    expect(order).toEqual(["first", "third:true"]);
    expect(idleCalls).toBe(0);

    third.settle(true);
    expect(line.pending).toBe(0);
    expect(idleCalls).toBe(1);
  });

  it("holds back sends queued behind a failure, but not the next send after the line empties", async () => {
    const line = emptyComposerDispatchLine();
    const failed = joinComposerDispatchLine(line, () => {});
    const queued = joinComposerDispatchLine(line, () => {});
    failed.settle(false);
    expect(await queued.previous).toBe(false);
    queued.settle(false);

    expect(await joinComposerDispatchLine(line, () => {}).previous).toBe(true);
  });
});
