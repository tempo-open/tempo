import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  TempoThreadMoveId,
  TempoThreadMoveManifest,
  tempoThreadMoveShellFields,
} from "./tempoThreadMove.ts";

const isMoveId = Schema.is(TempoThreadMoveId);
const decodeManifest = Schema.decodeUnknownExit(Schema.toCodecJson(TempoThreadMoveManifest));

describe("TempoThreadMoveId", () => {
  it("accepts server-minted ids and rejects anything that could name a path", () => {
    expect(isMoveId("0f0e0d0c-0b0a-4908-8706-050403020100")).toBe(true);
    for (const unsafe of ["../outgoing", "a/b", "a\\b", ".hidden", "", "x".repeat(65)]) {
      expect(isMoveId(unsafe)).toBe(false);
    }
  });
});

describe("TempoThreadMoveManifest", () => {
  it("refuses archives from a future format version", () => {
    const manifest = {
      format: "tempo-thread-move",
      version: 2,
      moveId: "move",
      createdAt: "2026-10-01T10:00:00.000Z",
      source: { threadId: "t", projectId: "p", cwd: "/r", workspaceRoot: "/r" },
      repository: { canonicalKey: "k", groupingKey: "k", displayName: null },
      git: { branch: null, headCommit: "c", wipCommit: null, bundleFile: null, bundleRefs: [] },
      thread: {
        title: "t",
        modelSelection: { instanceId: "codex", model: "gpt-5.4" },
        providerDriver: null,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-10-01T10:00:00.000Z",
        movedFrom: null,
      },
      messages: [],
      providerRefs: [],
      files: [],
    };
    expect(decodeManifest(manifest)._tag).toBe("Failure");
    expect(decodeManifest({ ...manifest, version: 1 })._tag).toBe("Success");
  });
});

describe("tempoThreadMoveShellFields", () => {
  it("omits links a thread does not have", () => {
    expect(tempoThreadMoveShellFields({ movedTo: null })).toEqual({});
  });
});
