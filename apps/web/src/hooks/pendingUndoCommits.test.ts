import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  forgetPendingUndoCommit,
  readPendingUndoCommits,
  rememberPendingUndoCommit,
} from "./pendingUndoCommits";

const deleteCommit = { kind: "delete-thread", environmentId: "env", threadId: "a", at: 1 } as const;
const closeCommit = {
  kind: "close-terminal",
  environmentId: "env",
  threadId: "a",
  terminalId: "term",
  at: 1,
} as const;

describe("pending Undo commits", () => {
  beforeEach(() => {
    for (const commit of readPendingUndoCommits()) forgetPendingUndoCommit(commit);
  });

  it("keeps an action until it is forgotten, one at a time", () => {
    const forgetDelete = rememberPendingUndoCommit(deleteCommit);
    const forgetClose = rememberPendingUndoCommit(closeCommit);
    expect(readPendingUndoCommits()).toEqual([deleteCommit, closeCommit]);
    forgetDelete();
    expect(readPendingUndoCommits()).toEqual([closeCommit]);
    forgetClose();
    expect(readPendingUndoCommits()).toEqual([]);
  });

  it("tells two terminals of one thread apart", () => {
    const other = { ...closeCommit, terminalId: "other" };
    rememberPendingUndoCommit(closeCommit);
    rememberPendingUndoCommit(other);
    forgetPendingUndoCommit(closeCommit);
    expect(readPendingUndoCommits()).toEqual([other]);
  });
});
