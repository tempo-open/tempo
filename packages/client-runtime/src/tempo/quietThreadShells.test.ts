import {
  EnvironmentId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { PrimaryConnectionTarget } from "../connection/model.ts";
import { v2Now, v2ShellSnapshot, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { createEnvironmentThreadShellAtoms } from "../state/threadShell.ts";
import { createQuietThreadShellsAtom } from "./quietThreadShells.ts";

const environmentId = EnvironmentId.make("environment-quiet");
const runId = RunId.make("streaming-run");
const at = (seconds: number) => DateTime.add(v2Now, { seconds });

const running: OrchestrationV2ThreadShell = {
  ...v2ThreadShell,
  latestRunId: runId,
  activeRunId: runId,
  status: "running",
  latestUserMessageAt: v2Now,
  itemCount: 1,
  visibleItemCount: 1,
};
const idle: OrchestrationV2ThreadShell = { ...v2ThreadShell, id: ThreadId.make("idle") };

const disposers: Array<() => void> = [];
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
});

function makeHarness() {
  const snapshotAtom = Atom.family((_environmentId: EnvironmentId) =>
    Atom.make<OrchestrationV2ShellSnapshot | null>(v2ShellSnapshot),
  );
  const catalogValueAtom = Atom.make({
    isReady: true,
    entries: new Map([
      [
        environmentId,
        {
          target: new PrimaryConnectionTarget({
            environmentId,
            label: "Environment",
            httpBaseUrl: "https://example.test",
            wsBaseUrl: "wss://example.test",
          }),
          profile: Option.none(),
          enabled: true,
        },
      ],
    ]),
  });
  const registry = AtomRegistry.make();
  const shells = createEnvironmentThreadShellAtoms({ catalogValueAtom, snapshotAtom });
  const quiet = createQuietThreadShellsAtom(shells.threadShellsAtom);
  const unmount = registry.mount(quiet);
  disposers.push(() => {
    unmount();
    registry.dispose();
  });
  let sequence = 0;
  return {
    setThreads: (threads: ReadonlyArray<OrchestrationV2ThreadShell>) =>
      registry.set(snapshotAtom(environmentId), {
        ...v2ShellSnapshot,
        snapshotSequence: ++sequence,
        threads,
      }),
    quiet: () => registry.get(quiet),
    live: () => registry.get(shells.threadShellsAtom),
  };
}

describe("quiet thread shell list", () => {
  it("keeps the list through a running thread's streaming ticks and follows every other change", () => {
    const harness = makeHarness();
    harness.setThreads([running, idle]);
    const before = harness.quiet();

    harness.setThreads([{ ...running, updatedAt: at(1), itemCount: 7, visibleItemCount: 4 }, idle]);
    expect(harness.quiet()).toBe(before);
    expect(harness.live()[0]?.itemCount).toBe(7);

    harness.setThreads([{ ...running, updatedAt: at(2), title: "Renamed" }, idle]);
    const renamed = harness.quiet();
    expect(renamed).not.toBe(before);
    expect(renamed[0]?.title).toBe("Renamed");
    expect(renamed[1]).toBe(before[1]);

    harness.setThreads([
      { ...running, title: "Renamed", status: "completed", activeRunId: null, updatedAt: at(3) },
      idle,
    ]);
    expect(harness.quiet()[0]?.updatedAt).toBe(DateTime.formatIso(at(3)));
  });

  it("follows the ticks of a running thread whose updatedAt a list shows", () => {
    const harness = makeHarness();
    const unprompted = { ...running, latestUserMessageAt: null };
    harness.setThreads([unprompted]);
    const before = harness.quiet();
    harness.setThreads([{ ...unprompted, updatedAt: at(1) }]);
    expect(harness.quiet()).not.toBe(before);
    expect(harness.quiet()[0]?.updatedAt).toBe(DateTime.formatIso(at(1)));

    const asking = {
      ...running,
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("approval"),
        kind: "command" as const,
        createdAt: v2Now,
      },
    };
    harness.setThreads([asking]);
    const waiting = harness.quiet();
    harness.setThreads([{ ...asking, updatedAt: at(2) }]);
    expect(harness.quiet()).not.toBe(waiting);
    expect(harness.quiet()[0]?.updatedAt).toBe(DateTime.formatIso(at(2)));
  });
});
