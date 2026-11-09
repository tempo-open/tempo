import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ambientSubagentThreadIds,
  createAmbientSubagentRowFilter,
  withoutAmbientSubagents,
} from "./ambientSubagents.ts";

type Rows = Parameters<ReturnType<typeof createAmbientSubagentRowFilter>>[0];

const row = (id: string, item: Record<string, unknown>) =>
  ({ sourceItemId: id, item }) as unknown as Rows[number];

describe("createAmbientSubagentRowFilter", () => {
  it("drops ambient subagent rows and keeps every other row in order", () => {
    const rows = [
      row("message", { type: "assistant_message" }),
      row("ambient", { type: "subagent", ambient: true }),
      row("worker", { type: "subagent" }),
    ];
    const filter = createAmbientSubagentRowFilter();
    expect(filter(rows).map((entry) => entry.sourceItemId)).toEqual(["message", "worker"]);
    // The same input gives the same array, so rows keep their identity between renders.
    expect(filter(rows)).toBe(filter(rows));
  });

  it("returns the projection's own array when nothing is ambient", () => {
    const rows = [
      row("message", { type: "assistant_message" }),
      row("worker", { type: "subagent" }),
    ];
    expect(createAmbientSubagentRowFilter()(rows)).toBe(rows);
  });
});

describe("withoutAmbientSubagents", () => {
  it("keeps the array when nothing is ambient", () => {
    const subagents = [{ id: "a" }, { id: "b", ambient: false }];
    expect(withoutAmbientSubagents(subagents)).toBe(subagents);
    expect(withoutAmbientSubagents([...subagents, { id: "c", ambient: true }])).toEqual(subagents);
  });
});

describe("ambientSubagentThreadIds", () => {
  it("names the threads of ambient subagents only", () => {
    const housekeeping = ThreadId.make("housekeeping");
    expect([
      ...ambientSubagentThreadIds([
        { childThreadId: housekeeping, ambient: true },
        { childThreadId: ThreadId.make("worker") },
        { childThreadId: null, ambient: true },
      ]),
    ]).toEqual([housekeeping]);
  });
});
