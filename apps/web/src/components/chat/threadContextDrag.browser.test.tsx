import { memo, useRef } from "react";
import { describe, expect, it } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";

import { act, render } from "../../../test/render";
import {
  dropThreadContext,
  endThreadContextDrag,
  moveThreadContextDrag,
  THREAD_CONTEXT_DROP_EVENT,
  threadContextDropTargetProps,
  threadContextDropZoneProps,
  useThreadContextDrop,
} from "./threadContextDrag";

const ENVIRONMENT_ID = "environment-local" as EnvironmentId;

// ChatComposer is memoized and reused across thread navigation; each render's
// drop callback must write into the draft of the thread it last rendered.
const ComposerDropTarget = memo(function ComposerDropTarget({
  draftKey,
  drafts,
}: {
  draftKey: string;
  drafts: Map<string, Array<ThreadId>>;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, draftKey, (refs, isActive) => {
    if (!isActive()) return;
    drafts.get(draftKey)?.push(...refs.map((ref) => ref.threadId));
  });
  return <div data-drop-target ref={targetRef} />;
});

// Keep the key stable to isolate effect-event updates; React 19.2 retained initial props.
const StableKeyDropTarget = memo(function StableKeyDropTarget({
  received,
}: {
  received: Array<ThreadId>;
}) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  useThreadContextDrop(targetRef, ENVIRONMENT_ID, "thread-a", (refs) => {
    received.push(...refs.map((ref) => ref.threadId));
  });
  return <div data-drop-target ref={targetRef} />;
});

describe("useThreadContextDrop", () => {
  it("drops into the last rendered thread's draft when the memoized target is reused", async () => {
    const drafts = new Map<string, Array<ThreadId>>([
      ["thread-a", []],
      ["thread-b", []],
    ]);

    await using screen = await render(<ComposerDropTarget draftKey="thread-a" drafts={drafts} />);
    await screen.rerender(<ComposerDropTarget draftKey="thread-b" drafts={drafts} />);

    const dropped: ScopedThreadRef = {
      environmentId: ENVIRONMENT_ID,
      threadId: "thread-dropped" as ThreadId,
    };
    const target = screen.container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    await act(() => {
      target!.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: [dropped] }));
    });

    expect(drafts.get("thread-b")).toEqual(["thread-dropped"]);
    expect(drafts.get("thread-a")).toEqual([]);
  });

  it("reads the latest props in a memoized target whose listener stays attached", async () => {
    const first: Array<ThreadId> = [];
    const latest: Array<ThreadId> = [];

    await using screen = await render(<StableKeyDropTarget received={first} />);
    await screen.rerender(<StableKeyDropTarget received={latest} />);

    const target = screen.container.querySelector("[data-drop-target]");
    expect(target).not.toBeNull();
    await act(() => {
      target!.dispatchEvent(
        new CustomEvent(THREAD_CONTEXT_DROP_EVENT, {
          detail: [{ environmentId: ENVIRONMENT_ID, threadId: "thread-dropped" as ThreadId }],
        }),
      );
    });

    expect(latest).toEqual(["thread-dropped"]);
    expect(first).toEqual([]);
  });
});

// tempo: a drop anywhere on a chat reaches its composer.
const OWN: ScopedThreadRef = { environmentId: ENVIRONMENT_ID, threadId: "thread-own" as ThreadId };
const OTHER: ScopedThreadRef = {
  environmentId: ENVIRONMENT_ID,
  threadId: "thread-other" as ThreadId,
};

// The chat view's layout in miniature: a sidebar beside a chat whose timeline sits above its
// composer, and only the composer listens for drops.
function ChatColumn({ received, inert = false }: { received: Array<ThreadId>; inert?: boolean }) {
  const composerRef = useRef<HTMLFormElement | null>(null);
  useThreadContextDrop(composerRef, ENVIRONMENT_ID, "thread-own", (refs) => {
    received.push(...refs.map((ref) => ref.threadId));
  });
  return (
    <div style={{ display: "flex", width: 400 }}>
      <div data-testid="sidebar" style={{ width: 100, height: 300 }} />
      <div {...threadContextDropZoneProps()} style={{ width: 300 }}>
        <div data-testid="timeline" style={{ height: 200 }} />
        <div inert={inert}>
          <form
            ref={composerRef}
            data-testid="composer"
            {...threadContextDropTargetProps(OWN)}
            style={{ height: 100 }}
          />
        </div>
      </div>
    </div>
  );
}

function centerOf(screen: { container: HTMLElement }, testId: string) {
  const bounds = screen.container
    .querySelector(`[data-testid="${testId}"]`)!
    .getBoundingClientRect();
  return { x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 };
}

describe("dropping a thread on a chat", () => {
  it("reaches the composer from anywhere on the chat, which lights up meanwhile", async () => {
    const received: Array<ThreadId> = [];
    await using screen = await render(<ChatColumn received={received} />);
    using _drag = { [Symbol.dispose]: endThreadContextDrag };
    const composer = screen.container.querySelector('[data-testid="composer"]')!;

    moveThreadContextDrag(centerOf(screen, "timeline"), [OTHER], "Other");
    expect(composer.hasAttribute("data-thread-context-over")).toBe(true);
    moveThreadContextDrag(centerOf(screen, "sidebar"), [OTHER], "Other");
    expect(composer.hasAttribute("data-thread-context-over")).toBe(false);

    await act(() => {
      expect(dropThreadContext(centerOf(screen, "timeline"), [OTHER])).toBe(true);
      expect(dropThreadContext(centerOf(screen, "composer"), [OTHER])).toBe(true);
      expect(dropThreadContext(centerOf(screen, "sidebar"), [OTHER])).toBe(false);
    });
    expect(received).toEqual(["thread-other", "thread-other"]);
  });

  it("leaves out the chat's own thread, alone or among others", async () => {
    const received: Array<ThreadId> = [];
    await using screen = await render(<ChatColumn received={received} />);
    using _drag = { [Symbol.dispose]: endThreadContextDrag };
    const composer = screen.container.querySelector('[data-testid="composer"]')!;

    moveThreadContextDrag(centerOf(screen, "timeline"), [OWN], "Own");
    expect(composer.hasAttribute("data-thread-context-over")).toBe(false);

    await act(() => {
      expect(dropThreadContext(centerOf(screen, "timeline"), [OWN])).toBe(false);
      expect(dropThreadContext(centerOf(screen, "timeline"), [OWN, OTHER])).toBe(true);
    });
    expect(received).toEqual(["thread-other"]);
  });

  it("drops nothing on an inert composer", async () => {
    const received: Array<ThreadId> = [];
    await using screen = await render(<ChatColumn received={received} inert />);

    await act(() => {
      expect(dropThreadContext(centerOf(screen, "timeline"), [OTHER])).toBe(false);
    });
    expect(received).toEqual([]);
  });
});
