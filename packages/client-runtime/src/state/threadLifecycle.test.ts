import type { EnvironmentId, OrchestrationV2ShellSnapshot, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { createOptimisticThreadLifecycle } from "./threadLifecycle.ts";

const environmentId = "env" as EnvironmentId;
const threadId = "thread" as ThreadId;
const snapshotWith = (ids: ReadonlyArray<string>) =>
  ({
    snapshotSequence: 1,
    threads: ids.map((id) => ({ id, archivedAt: null })),
  }) as unknown as OrchestrationV2ShellSnapshot;

function setup() {
  const source = Atom.make<OrchestrationV2ShellSnapshot | null>(snapshotWith([threadId, "other"]));
  const lifecycle = createOptimisticThreadLifecycle(() => source);
  const registry = AtomRegistry.make();
  const snapshot = lifecycle.snapshotAtom(environmentId);
  const unmount = registry.mount(snapshot);
  const archivedAt = (id: string) =>
    registry.get(snapshot)?.threads.find((thread) => thread.id === id)?.archivedAt ?? null;
  const hold = () =>
    lifecycle.hold(registry, { environmentId, threadId }, (thread, now) => ({
      ...thread,
      archivedAt: now,
    }));
  return { source, registry, snapshot, unmount, archivedAt, hold };
}

describe("createOptimisticThreadLifecycle hold", () => {
  it("applies to its thread alone until released", () => {
    const { archivedAt, hold } = setup();
    const held = hold();
    expect(DateTime.isDateTime(archivedAt(threadId))).toBe(true);
    expect(archivedAt("other")).toBeNull();
    held.release();
    expect(archivedAt(threadId)).toBeNull();
  });

  it("holds through newer snapshots, and until the thread is gone when asked", () => {
    const { source, registry, snapshot, archivedAt, hold } = setup();
    const held = hold();
    registry.set(source as Atom.Writable<OrchestrationV2ShellSnapshot | null>, {
      ...snapshotWith([threadId, "other"]),
      snapshotSequence: 2,
    });
    expect(archivedAt(threadId)).not.toBeNull();

    held.releaseOnceGone();
    expect(archivedAt(threadId)).not.toBeNull();
    registry.set(
      source as Atom.Writable<OrchestrationV2ShellSnapshot | null>,
      snapshotWith(["other"]),
    );
    registry.set(
      source as Atom.Writable<OrchestrationV2ShellSnapshot | null>,
      snapshotWith([threadId]),
    );
    expect(registry.get(snapshot)?.threads[0]?.archivedAt).toBeNull();
  });
});
